"use strict";

/*
 * Active-program fetching for the shared HomeConnect session: admission
 * (rate limit, throttle, forced-request dedup, one fetch at a time with a
 * follow-up queue) and the sequential fetch loop with retry scheduling.
 *
 * The node helper owns one instance. Everything it needs from the helper comes
 * in as functions, so the helper's own methods stay the seams tests replace.
 */
const { deviceAppearsActive, isDeviceConnected } = require("./device-utils");
const { log } = require("./logger");

// A forced active-program fetch for an appliance stays good for this long, so a
// burst of SSE deltas on one device cannot turn into one API round per event.
const FORCED_ACTIVE_PROGRAM_DEDUP_WINDOW_MS = 15000;

class ProgramFetchCoordinator {
  /**
   * @param {object} deps - Helper callbacks
   * @param {object} deps.session - globalSession (rateLimitUntil, lastActiveProgramFetch, MIN_ACTIVE_PROGRAM_INTERVAL)
   * @param {Function} deps.getHc - () => HomeConnect client or null
   * @param {Function} deps.getDeviceService - () => DeviceService
   * @param {Function} deps.getProgramService - () => ProgramService
   * @param {Function} deps.getActiveProgramManager - () => ActiveProgramManager
   * @param {Function} deps.isRateLimited - () => boolean
   * @param {Function} deps.emitInitStatus - (status, payload, options) => void
   * @param {Function} deps.request - (payload) => void, admission entry (follow-ups)
   * @param {Function} deps.runFetch - (devices, requester, meta) => Promise, the fetch loop
   * @param {Function} deps.fetchOne - (haId, name) => Promise<result>
   * @param {Function} deps.broadcastProgramData - (programData, requester) => void
   * @param {Function} deps.handleError - (error) => void
   * @param {Function} [deps.now] - Clock for tests
   */
  constructor(deps) {
    this.deps = deps;
    this.session = deps.session;
    this.now = deps.now || (() => Date.now());
    this.state = {
      inFlight: false,
      // Devices the running fetch covers.
      inFlightHaIds: new Set(),
      // Devices requested while it runs and not covered by it; picked up the
      // moment it finishes instead of being lost until another SSE delta.
      pendingHaIds: new Set(),
      // haId -> end of the last forced fetch, for the dedup window.
      lastForcedAt: new Map(),
    };
  }

  isInFlight() {
    return this.state.inFlight;
  }

  reset() {
    this.state.inFlight = false;
    this.state.inFlightHaIds.clear();
    this.state.pendingHaIds.clear();
    this.state.lastForcedAt.clear();
  }

  request(payload = {}) {
    const requester = payload.instanceId || null;
    const haIds = Array.isArray(payload.haIds) ? payload.haIds : null;
    const force = Boolean(payload.force);
    // Routine resyncs (scheduled snapshot, SSE watchdog) only ask running appliances.
    const activeOnly = Boolean(payload.activeOnly);

    const requesterLabel = requester || "unknown";

    log.debug("GET_ACTIVE_PROGRAMS received", requesterLabel);

    if (!this.deps.getHc()) {
      log.warn("HomeConnect not initialized - cannot fetch active programs");
      this.deps.emitInitStatus(
        "hc_not_ready",
        {
          instanceId: requester,
        },
        requester ? { broadcast: false, targetInstanceId: requester } : {},
      );
      return;
    }

    const now = this.now();

    const rateLimitActive = this.deps.isRateLimited();
    if (!force && rateLimitActive) {
      const remainingSeconds = Math.ceil((this.session.rateLimitUntil - now) / 1000);
      log.info(`Rate limited - ${remainingSeconds}s remaining`);
      this.deps.emitInitStatus(
        "device_error",
        {
          message: `Rate limit active - please wait ${remainingSeconds}s`,
          rateLimitSeconds: remainingSeconds,
          statusCode: 429,
          isRateLimit: true,
          instanceId: requester,
        },
        requester ? { broadcast: false, targetInstanceId: requester } : {},
      );
      return;
    }

    const sinceLastFetch = now - this.session.lastActiveProgramFetch;
    if (
      !force &&
      this.session.MIN_ACTIVE_PROGRAM_INTERVAL > 0 &&
      sinceLastFetch < this.session.MIN_ACTIVE_PROGRAM_INTERVAL
    ) {
      const waitMs = this.session.MIN_ACTIVE_PROGRAM_INTERVAL - sinceLastFetch;
      log.debug(`Throttling GET_ACTIVE_PROGRAMS for ${requesterLabel} - wait ${waitMs}ms`);
      return;
    }

    const devices = this.deps.getDeviceService()?.devices;
    const deviceArray = devices ? Array.from(devices.values()) : [];
    let targetDevices = haIds?.length ? deviceArray.filter((device) => haIds.includes(device.haId)) : deviceArray;

    if (activeOnly) {
      targetDevices = targetDevices.filter((device) => deviceAppearsActive(device));
    }

    if (force) {
      targetDevices = targetDevices.filter(
        (device) => now - (this.state.lastForcedAt.get(device.haId) || 0) >= FORCED_ACTIVE_PROGRAM_DEDUP_WINDOW_MS,
      );
    }

    if (targetDevices.length === 0) {
      log.debug("No devices left for active program request", {
        requester: requesterLabel,
        requestedHaIds: haIds,
        force,
      });
      return;
    }

    if (this.state.inFlight) {
      // Queue whatever the running fetch does not already cover. Devices it does
      // cover need nothing: their data is on its way.
      const uncovered = targetDevices
        .map((device) => device.haId)
        .filter((haId) => !this.state.inFlightHaIds.has(haId));
      for (const haId of uncovered) {
        this.state.pendingHaIds.add(haId);
      }
      log.debug("Active program fetch already in flight", {
        requester: requesterLabel,
        queued: uncovered,
      });
      return;
    }

    log.debug("Active program request accepted", {
      requester: requesterLabel,
      deviceCount: targetDevices.length,
      force,
    });

    this.state.inFlight = true;
    this.state.inFlightHaIds = new Set(targetDevices.map((device) => device.haId));
    this.session.lastActiveProgramFetch = now;
    this.deps.runFetch(targetDevices, requester, { force });
  }

  async fetchDevices(deviceArray, requestingInstanceId, requestMeta = {}) {
    // Everything below runs inside the try so that the finally clause - which
    // releases the in-flight slot and drains the pending queue - cannot be
    // skipped by an early return.
    try {
      if (!this.deps.getDeviceService()) {
        log.debug("DeviceService not available - cannot fetch programs");
        return;
      }

      if (!Array.isArray(deviceArray) || deviceArray.length === 0) {
        log.debug("No target devices provided for fetching active programs");
        return;
      }

      log.debug(`Fetching active programs for ${deviceArray.length} device(s)`);

      const results = [];
      const retryCandidates = [];

      // Fetch sequentially to avoid overwhelming the API
      for (const device of deviceArray) {
        // Fallback: if device is not connected according to the API but appears
        // active (e.g. reports RemainingProgramTime/ProgramProgress/OperationState),
        // still attempt to fetch the active program. This mirrors the iOS app
        // behavior where program state can take a short while to reflect in
        // the /homeappliances list connected flag.
        const connected = isDeviceConnected(device);
        const appearsActive = deviceAppearsActive(device);
        if (connected || appearsActive) {
          if (!connected && appearsActive) {
            log.debug(`${device.name} not marked connected but appears active; fetching program anyway`, {
              rawConnected: device.connected,
            });
          }
          log.debug(`Requesting active program ${results.length + 1}/${deviceArray.length} for ${device.name}`);
          const result = await this.deps.fetchOne(device.haId, device.name);
          log.debug(`Active program response for ${device.name}:`, {
            success: result.success,
            hasData: !!(result.data && Object.keys(result.data).length),
            error: result.error || null,
          });
          if (result?.data) {
            // Summary only: the old full-depth payload dump was rendered into the
            // message string before the logger checked the level, on every fetch.
            const options = Array.isArray(result.data.options) ? result.data.options : [];
            log.debug(`Active program payload for ${device.name}:`, {
              source: result.source || "unknown",
              key: result.data.key || null,
              optionKeys: options.map((option) => option?.key).filter(Boolean),
            });
          }
          results.push(result);

          // Small delay between requests to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          log.debug(`Skipping ${device.name} - not connected`, {
            rawConnected: device.connected,
          });
        }
      }

      // Process successful results
      const programData = {};
      results.forEach((result) => {
        if (result.success && result.data) {
          const programService = this.deps.getProgramService();
          const payload = programService ? programService.applyProgramResult(result) : null;
          if (payload) {
            programData[result.haId] = payload;
            const activeProgramManager = this.deps.getActiveProgramManager();
            if (activeProgramManager && typeof activeProgramManager.clear === "function") {
              activeProgramManager.clear(result.haId);
            } else {
              log.warn(`ActiveProgramManager missing - cannot clear retry for ${result.haId}`);
            }
          }
        } else if (result.error === "No active program") {
          const device = this.deps.getDeviceService().devices.get(result.haId);
          if (device) {
            const shouldRetry = deviceAppearsActive(device);
            log.debug(`Device ${device.name} reported no active program (retry=${shouldRetry})`);
            if (shouldRetry) {
              retryCandidates.push(device);
            }
          }
        }
      });

      this.deps.broadcastProgramData(programData, requestingInstanceId);

      if (retryCandidates.length) {
        log.info(`Scheduling retries for ${retryCandidates.length} device(s) awaiting active program data`);
        const activeProgramManager = this.deps.getActiveProgramManager();
        if (activeProgramManager && typeof activeProgramManager.schedule === "function") {
          activeProgramManager.schedule(retryCandidates, requestingInstanceId);
        } else {
          log.error("ActiveProgramManager not available - cannot schedule retries");
        }
      } else {
        log.debug("No retry candidates detected for active programs");
      }
    } catch (error) {
      this.deps.handleError(error);
    } finally {
      if (requestMeta.force) {
        const completedAt = this.now();
        for (const haId of this.state.inFlightHaIds) {
          this.state.lastForcedAt.set(haId, completedAt);
        }
      }
      this.state.inFlight = false;
      this.state.inFlightHaIds.clear();

      if (this.state.pendingHaIds.size > 0) {
        const pendingHaIds = [...this.state.pendingHaIds];
        this.state.pendingHaIds.clear();
        this.deps.request({
          instanceId: "active_program_overlap_followup",
          haIds: pendingHaIds,
          force: true,
        });
      }
    }
  }
}

module.exports = { FORCED_ACTIVE_PROGRAM_DEDUP_WINDOW_MS, ProgramFetchCoordinator };
