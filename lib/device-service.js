"use strict";

const {
  deviceAppearsActive,
  extractProgramList,
  isDeviceConnected,
  isRateLimitError,
  parseOperationState,
} = require("./device-utils");
const {
  addEndedRun,
  catalogHasProgram,
  markCatalogStale,
  mergeProgramCatalog,
  needsCatalog,
} = require("./program-stats");
const { reconcileRunStates } = require("./run-state-store");

// Used when Home Connect answers 429 without a Retry-After header.
const DEVICE_RATE_LIMIT_FALLBACK_S = 5 * 60;

// Pause between two appliances while a snapshot enriches them. The
// active-program loop in the node helper paces itself the same way.
const DEVICE_DETAIL_PACING_MS = 500;

// An appliance whose program catalog could not be fetched (offline, busy, empty
// answer) is not asked again before this.
const CATALOG_RETRY_MS = 60 * 60 * 1000;

// An SSE rebuild refreshes the access token first only if it expires sooner.
const SSE_TOKEN_MIN_VALIDITY_MS = 15 * 60 * 1000;

// A token refreshed this recently is never refreshed again before an SSE rebuild.
const SSE_TOKEN_RECENT_REFRESH_MS = 5 * 60 * 1000;

// SSE watchdog. Home Connect sends a KEEP-ALIVE about every 55 s, so a stream
// silent for 70 s is dead - the server sets this pace, not the user, which is why
// it is no config option. Tests inject shorter timings (options.heartbeat).
const HEARTBEAT_DEFAULTS = Object.freeze({
  enabled: true,
  staleThresholdMs: 70 * 1000,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DeviceService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.onSseStale = options.onSseStale || (() => {});
    this.onActiveProgramNeeded = options.onActiveProgramNeeded || (() => {});
    // Fires once per getDevices() run, on success and on failure alike, so the
    // caller's in-flight flag can never latch on an error path.
    this.onRefreshSettled = options.onRefreshSettled || (() => {});
    this.setRateLimitUntil = options.setRateLimitUntil || (() => {});
    this.hc = null;
    this.devices = new Map();
    this.subscribed = false;
    this.subscribedHaIds = new Set();
    this.settingsFetchedHaIds = new Set();
    // Appliances whose current run already triggered an active-program fetch.
    this.activeProgramRequestedHaIds = new Set();
    this.globalSession = options.globalSession;
    // { read, persist } for the program start times (lib/run-state-store.js).
    // Without one, starts are only kept in memory - which is what tests want.
    this.runStateStore = options.runStateStore || null;
    this.runStates = this.runStateStore ? this.runStateStore.read() : {};
    // What this process has seen itself: an appliance seen idle before its run
    // was watched from its start, one seen running before its end from its end.
    this.runSightings = { seenIdle: new Set(), seenRunning: new Set() };
    // { read, persist } for lib/program-stats.js; optional like runStateStore.
    this.programStatsStore = options.programStatsStore || null;
    this.programStats = this.programStatsStore ? this.programStatsStore.read() : {};
    this.isRateLimited = options.isRateLimited || (() => false);
    // Program catalog fetches: one at a time, at most once per unknown program and
    // process, and a failed appliance waits before it is asked again.
    this.catalogFetchInFlight = false;
    this.catalogRequestedKeys = new Set();
    this.catalogRetryAfter = new Map();
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => {});
    this.recordSseEvent = debugHooks.recordSseEvent || (() => {});
    this.recordSseKeepAlive = debugHooks.recordSseKeepAlive || (() => {});

    // Heartbeat / SSE monitoring
    const heartbeat = { ...HEARTBEAT_DEFAULTS, ...options.heartbeat };
    this.heartbeatEnabled = heartbeat.enabled;
    this.heartbeatStaleThresholdMs = heartbeat.staleThresholdMs;
    // Watching the subscribed streams; the timer itself only runs once traffic arrived.
    this.heartbeatActive = false;
    this.heartbeatTimer = null;
    this.lastEventTimestamp = null;
    this.lastKeepAliveTimestamp = null;
    this.heartbeatStale = false;

    this.deviceEventHandler = null;
    this._deviceRefreshPending = false;
    this._deviceEventNotifier = null;
    this._stableDeviceEventHandler = null;
    this._sseTokenRefreshPromise = null;
    this._lastTokenRefreshedAt = 0;
  }

  attachClient(hc) {
    if (this.hc && this.hc !== hc) {
      try {
        // destroy() also clears the previous client's token-refresh timer -
        // closeEventSources() alone leaves it running against a discarded client.
        if (typeof this.hc.destroy === "function") {
          this.hc.destroy();
        } else if (typeof this.hc.closeEventSources === "function") {
          this.hc.closeEventSources({ devices: true, global: true });
        }
        this.logger.info("Detached previous Home Connect client and closed SSE channels");
      } catch (err) {
        this.logger.warn(
          "Failed to close event sources on previous Home Connect client",
          err?.message ? err.message : err,
        );
      }
    }

    this.hc = hc;
  }

  broadcastDevices(sendSocketNotification) {
    const devices = Array.from(this.devices.values());
    this.syncRunStates(devices);
    this.syncProgramCatalogs(devices);
    this.logger.debug(`Broadcasting ${devices.length} devices to ${this.globalSession.clientInstances.size} clients`);
    sendSocketNotification("DEVICES_UPDATE", devices);
  }

  // Every device state passes through here on its way to the displays, so this is
  // where a program start from before a restart is put back and an ended run is
  // added to the program statistics.
  syncRunStates(devices) {
    if (!this.runStateStore) {
      return;
    }
    const { changed, restored, ended } = reconcileRunStates(devices, this.runStates, Date.now(), this.runSightings);
    for (const device of restored) {
      this.logger.info(
        `Program start of ${device.name} restored from before the restart: ${new Date(device._remainingObservedAt).toISOString()}`,
      );
    }
    if (changed) {
      this.runStateStore.persist(this.runStates);
    }
    if (ended.length > 0 && this.programStatsStore) {
      for (const endedRun of ended) {
        const run = addEndedRun(this.programStats, endedRun);
        const name = endedRun.device?.name || endedRun.haId;
        const took = Number.isFinite(run.durationS)
          ? `after ${Math.round(run.durationS / 60)} min`
          : "(length unknown)";
        this.logger.info(
          `Program run recorded: ${name} - ${endedRun.record.programName} ${run.outcome} ${took}, announced ${Math.round(run.initialRemainingS / 60)} min`,
        );
      }
      this.programStatsStore.persist(this.programStats);
    }
  }

  // Appliances whose program catalog should be (re)fetched: no complete catalog
  // yet (statistics file missing, new appliance), a stale one, or a selected
  // program the catalog does not know. Only idle appliances in a known state are
  // asked - while a program runs, /programs/available lists only that program. A
  // running unknown program marks the catalog stale, so it is fetched afterwards.
  findCatalogCandidates(devices, now = Date.now()) {
    const candidates = [];
    for (const device of devices) {
      if (!device?.haId || !isDeviceConnected(device) || (this.catalogRetryAfter.get(device.haId) || 0) > now) {
        continue;
      }
      const state = parseOperationState(device);
      const programKey = typeof device.ActiveProgramKey === "string" ? device.ActiveProgramKey : "";
      const unknownProgram =
        programKey && this.programStats[device.haId] && !catalogHasProgram(this.programStats, device.haId, programKey);
      if (!state.known || state.hasProgramInProgress) {
        if (unknownProgram && markCatalogStale(this.programStats, device.haId)) {
          this.programStatsStore.persist(this.programStats);
        }
        continue;
      }
      if (needsCatalog(this.programStats, device.haId)) {
        const appliance = this.programStats[device.haId];
        const reason = appliance?.catalogStale
          ? "stale catalog"
          : appliance?.catalog
            ? "incomplete catalog"
            : "no catalog";
        candidates.push({ device, reason });
        continue;
      }
      const requestKey = `${device.haId}|${programKey}`;
      if (unknownProgram && !this.catalogRequestedKeys.has(requestKey)) {
        candidates.push({ device, reason: `unknown program ${programKey}`, requestKey });
      }
    }
    return candidates;
  }

  syncProgramCatalogs(devices) {
    if (!this.programStatsStore || !this.hc || this.catalogFetchInFlight || this.isRateLimited()) {
      return;
    }
    const candidates = this.findCatalogCandidates(devices);
    if (candidates.length === 0) {
      return;
    }
    this.catalogFetchInFlight = true;
    this.fetchProgramCatalogs(candidates)
      .catch((err) => this.logger.warn("Program catalog fetch failed:", err?.message || err))
      .finally(() => {
        this.catalogFetchInFlight = false;
      });
  }

  async fetchProgramCatalogs(candidates) {
    for (const [index, { device, reason, requestKey }] of candidates.entries()) {
      if (this.isRateLimited()) {
        return;
      }
      if (index > 0) {
        await wait(DEVICE_DETAIL_PACING_MS);
      }
      if (requestKey) {
        this.catalogRequestedKeys.add(requestKey);
      }
      this.recordApiCall("availablePrograms");
      this.logger.debug(`Fetching program catalog for ${device.name} (${reason})`);
      const res = await this.hc.getAvailablePrograms(device.haId);
      const programs = res?.success ? extractProgramList(res.data) : [];
      if (!res?.success || programs.length === 0) {
        this.catalogRetryAfter.set(device.haId, Date.now() + CATALOG_RETRY_MS);
        if (isRateLimitError({ statusCode: res?.statusCode, message: res?.error || "" })) {
          this.noteDeviceFetchFailure("Program catalog", device, res);
          return;
        }
        this.logger.debug(
          `No program catalog for ${device.name} (${res?.statusCode || "empty"}) - next try in ${CATALOG_RETRY_MS / 60000} min`,
        );
        continue;
      }
      const added = mergeProgramCatalog(this.programStats, device, programs);
      this.programStatsStore.persist(this.programStats);
      if (added.length > 0) {
        const names = added.map((key) => this.programStats[device.haId].catalog[key].name);
        this.logger.info(`Program catalog of ${device.name}: ${added.length} new program(s): ${names.join(", ")}`);
      }
    }
  }

  // Re-reads the device from the live Map right before applying fetched data,
  // instead of mutating the object reference captured when the fetch started.
  // registerDevice() replaces that Map entry with a new merged object on every
  // refresh cycle - if a second refresh (or SSE resync) lands while this fetch
  // is still in flight, the originally captured reference is orphaned and
  // mutating it would silently discard the result.
  currentDevice(device) {
    return this.devices.get(device.haId) || device;
  }

  // getStatus()/getSettings() resolve with { success: false, statusCode, ... }
  // instead of rejecting, so a failed per-appliance fetch reaches neither the
  // apply branch nor the catch below. Dropping it silently also kept a 429 here
  // out of the shared backoff, so the next snapshot re-ran the very burst that
  // had just been throttled.
  noteDeviceFetchFailure(kind, device, result) {
    const statusCode = result?.statusCode || null;
    const message = result?.error || "unknown error";

    if (!isRateLimitError({ statusCode, message })) {
      this.logger.warn(`${kind} fetch failed for ${device.name} (${statusCode || "n/a"}): ${message}`);
      return;
    }

    const retryAfterSeconds = Number.isFinite(result?.retryAfterSeconds)
      ? Math.max(1, Math.ceil(result.retryAfterSeconds))
      : DEVICE_RATE_LIMIT_FALLBACK_S;

    this.setRateLimitUntil(Date.now() + retryAfterSeconds * 1000);
    this.logger.warn(`Rate limit on ${kind} fetch for ${device.name} - backing off for ${retryAfterSeconds}s`);
  }

  fetchDeviceStatus(device) {
    if (this.hc && typeof this.hc.getStatus === "function") {
      this.recordApiCall("status");
      return this.hc
        .getStatus(device.haId)
        .then((res) => {
          if (!res?.success) {
            this.noteDeviceFetchFailure("status", device, res);
            return;
          }
          if (res.data && Array.isArray(res.data.status)) {
            const liveDevice = this.currentDevice(device);
            liveDevice.connected = true;
            res.data.status.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(liveDevice, event);
              }
            });
          }
        })
        .catch((err) => {
          this.logger.error(`Status error for ${device.name}:`, err);
          return null;
        });
    }
    this.logger.error(`HomeConnect client missing getStatus wrapper - cannot fetch status for ${device.name}`);
    return Promise.resolve();
  }

  fetchDeviceSettings(device) {
    if (this.hc && typeof this.hc.getSettings === "function") {
      this.recordApiCall("settings");
      return this.hc
        .getSettings(device.haId)
        .then((res) => {
          if (!res?.success) {
            this.noteDeviceFetchFailure("settings", device, res);
            return;
          }
          if (res.data && Array.isArray(res.data.settings)) {
            const liveDevice = this.currentDevice(device);
            liveDevice.connected = true;
            res.data.settings.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(liveDevice, event);
              }
            });
            // Only on success: a transient failure must stay retryable on the
            // next refresh instead of leaving the appliance without settings.
            this.settingsFetchedHaIds.add(device.haId);
          }
        })
        .catch((err) => {
          this.logger.error(`Settings error for ${device.name}:`, err);
          return null;
        });
    }
    this.logger.error(`HomeConnect client missing getSettings wrapper - cannot fetch settings for ${device.name}`);
    return Promise.resolve();
  }

  // BSH.Common.Setting.PowerState (and the hood's Lighting) are settings, so they
  // never appear in /status - /settings is their only REST source. Without this
  // seed an appliance has no known power state until it happens to change it
  // while the module runs, which leaves e.g. a dishwasher that was switched on
  // before the mirror started showing no power icon at all.
  //
  // Fetched once per appliance rather than on every refresh: the live value comes
  // from SSE NOTIFY afterwards, and one call per appliance per session keeps this
  // far away from the API rate limit.
  shouldFetchInitialSettings(device) {
    return Boolean(device?.haId) && !this.settingsFetchedHaIds.has(device.haId);
  }

  noteTokenRefreshed(timestamp = Date.now()) {
    this._lastTokenRefreshedAt = timestamp;
  }

  /*
   * SSE watchdog: one timer, restarted by every message on the streams (the
   * KEEP-ALIVE included). It fires only after heartbeatStaleThresholdMs without
   * any, so a dead stream is noticed exactly then - no polling. It is armed by
   * the first message, so streams that never delivered anything (their errors
   * are handled by the stream itself) do not count as stale.
   */
  startHeartbeatMonitor() {
    if (!this.heartbeatEnabled || this.heartbeatActive) {
      return;
    }
    this.logger.debug(`Starting SSE heartbeat monitor (stale after ${this.heartbeatStaleThresholdMs}ms of silence)`);
    this.heartbeatActive = true;
    this.heartbeatStale = false;
    this.lastEventTimestamp = null;
    this.lastKeepAliveTimestamp = null;
  }

  stopHeartbeatMonitor() {
    this.heartbeatActive = false;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatStale = false;
    this.lastEventTimestamp = null;
    this.lastKeepAliveTimestamp = null;
  }

  markSseTraffic(timestamp = Date.now()) {
    this.lastEventTimestamp = timestamp;
    if (this.heartbeatStale) {
      this.heartbeatStale = false;
      this.logger.info("SSE heartbeat recovered via incoming traffic");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "sse_recovered",
        message: "Home Connect event stream recovered",
      });
    }
    if (this.heartbeatActive) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = setTimeout(() => this.handleSseSilence(), this.heartbeatStaleThresholdMs);
    }
  }

  // The streams stayed silent for the whole threshold. The rebuild restarts the
  // monitor, which waits for new traffic before it can fire again - so two
  // rebuilds are always more than one threshold apart without a separate cooldown.
  handleSseSilence() {
    this.heartbeatTimer = null;
    if (!this.heartbeatActive) {
      return;
    }
    const silenceMs = Date.now() - this.lastEventTimestamp;
    const durationLabel = this.formatSilenceDuration(silenceMs);
    this.heartbeatStale = true;
    this.logger.warn(`No SSE events received for ${durationLabel} - broadcasting stale status`);
    this.broadcastToAllClients("INIT_STATUS", {
      status: "sse_stale",
      message: `No Home Connect events received for ${durationLabel}`,
    });

    if (!this.devices || this.devices.size === 0) {
      this.logger.debug("Skipping SSE recovery because no devices are known yet");
      return;
    }
    Promise.resolve()
      .then(() => this.onSseStale({ silenceMs }))
      .catch((err) => {
        this.logger.warn("SSE stale recovery callback failed", err?.message ? err.message : err);
      });
  }

  handleKeepAliveEvent(data) {
    const now = Date.now();
    const sinceLastKeepAlive =
      Number.isFinite(this.lastKeepAliveTimestamp) && this.lastKeepAliveTimestamp > 0
        ? now - this.lastKeepAliveTimestamp
        : null;

    this.lastKeepAliveTimestamp = now;
    const keepAliveMessage = `SSE KEEP-ALIVE received${sinceLastKeepAlive !== null ? ` (${sinceLastKeepAlive}ms since last KEEP-ALIVE)` : ""}`;
    if (data && data.data !== undefined) {
      this.logger.debug(keepAliveMessage, data.data);
    } else {
      this.logger.debug(keepAliveMessage);
    }
    this.recordSseKeepAlive();
    this.markSseTraffic(now);
  }

  formatSilenceDuration(silenceMs) {
    const seconds = Math.max(1, Math.round(silenceMs / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.round(seconds / 60);
    return `${minutes} minute(s)`;
  }

  shutdown() {
    this.resetEventSubscriptions();
    // Only a real teardown invalidates the "settings already seeded" cache -
    // a plain channel rebuild must keep it, or /settings is refetched for every
    // appliance on every reconnect.
    this.settingsFetchedHaIds.clear();
  }

  resetEventSubscriptions() {
    this.stopHeartbeatMonitor();
    if (this.hc && typeof this.hc.closeEventSources === "function") {
      try {
        const wasSubscribed = this.subscribed;
        this.hc.closeEventSources({ devices: true, global: true });
        // Only worth a line when streams were actually open - at the first
        // subscribe there is nothing to close, and saying so read like a teardown.
        if (wasSubscribed) {
          this.logger.info("Closed Home Connect SSE channels");
        }
      } catch (err) {
        this.logger.warn("Failed to close existing Home Connect event sources", err?.message ? err.message : err);
      }
    }
    this.subscribed = false;
    this.subscribedHaIds.clear();
  }

  // Registration is deliberately synchronous and separate from enrichment: the
  // SSE subscriptions and the first broadcast are set up from this.devices right
  // after the whole snapshot is registered, so every appliance has to be in the
  // Map before the (now paced) detail fetches start.
  registerDevice(device, index) {
    this.logger.debug(`Device ${index + 1}: ${device.name} (${device.haId})`);

    // Merge with existing entry so runtime fields (RemainingProgramTime, OperationState, etc.)
    // survive periodic refreshes until the program service overwrites them.
    const existingDevice = this.devices.get(device.haId);
    const mergedDevice = existingDevice ? { ...existingDevice, ...device } : device;
    this.devices.set(device.haId, mergedDevice);

    return mergedDevice;
  }

  // One appliance at a time, paced: asking for status (plus the one-off settings
  // seed) for every appliance at once turned a snapshot into a burst of up to
  // 2xN parallel requests - which is what Home Connect's rate limiter answers
  // with 429. Status and settings of a single appliance still overlap; that is
  // two requests, and settings are only fetched once per appliance per session.
  async refreshDeviceDetailsSequentially(deviceRefs) {
    for (let index = 0; index < deviceRefs.length; index += 1) {
      if (index > 0) {
        await wait(DEVICE_DETAIL_PACING_MS);
      }
      await this.refreshDeviceDetails(deviceRefs[index]);
    }
  }

  refreshDeviceDetails(device) {
    const connected = isDeviceConnected(device);
    const appearsActive = deviceAppearsActive(device);

    const pendingFetches = [];

    if (connected) {
      this.logger.debug(`${device.name} connected; fetching status`);
      pendingFetches.push(this.fetchDeviceStatus(device));
      if (this.shouldFetchInitialSettings(device)) {
        pendingFetches.push(this.fetchDeviceSettings(device));
      }
    } else if (appearsActive) {
      this.logger.debug(`${device.name} not marked connected but appears active; fetching status anyway`, {
        rawConnected: device.connected,
      });
      pendingFetches.push(this.fetchDeviceStatus(device));
    } else {
      this.logger.warn(`Device ${device.name} is not connected`);
    }

    if (pendingFetches.length === 0) {
      return Promise.resolve();
    }

    return Promise.allSettled(pendingFetches);
  }

  // subscribeToDeviceEvents tears down and rebuilds every SSE channel whenever
  // the handler identity changes. Passing a fresh closure per refresh therefore
  // meant a full reconnect - plus a token refresh - on every device snapshot,
  // i.e. every 30 minutes, for channels that were working fine. Keep one handler
  // and swap only the broadcast sink it forwards to.
  getDeviceEventHandler(sendSocketNotification) {
    this._deviceEventNotifier = sendSocketNotification;
    if (!this._stableDeviceEventHandler) {
      this._stableDeviceEventHandler = (e) => this.deviceEvent(e, this._deviceEventNotifier);
    }
    return this._stableDeviceEventHandler;
  }

  subscribeToDeviceEvents(deviceEventHandler) {
    if (!this.hc) {
      this.logger.error("HomeConnect client not attached - cannot subscribe");
      return;
    }
    const handlerChanged = this.deviceEventHandler !== deviceEventHandler;
    this.deviceEventHandler = deviceEventHandler;

    if (this.subscribed && !handlerChanged) {
      this.logger.debug("SSE subscriptions already active - ensuring channels for known devices");
      this.establishEventSubscriptions();
      return;
    }

    if (this.subscribed) {
      this.logger.debug("SSE handler changed - reopening the channels");
      this.resetEventSubscriptions();
    }

    this.ensureFreshTokenForSSE()
      .catch((err) => {
        this.logger.warn(
          "Pre-SSE token refresh failed - continuing with existing token",
          err?.message ? err.message : err,
        );
      })
      .finally(() => {
        this.establishEventSubscriptions();
      });
  }

  reconnectEventSubscriptions() {
    if (!this.hc || !this.deviceEventHandler) {
      this.logger.warn("Cannot rebuild SSE subscriptions without HomeConnect client and handler");
      return Promise.resolve(false);
    }

    this.logger.warn("Rebuilding Home Connect SSE subscriptions");
    this.resetEventSubscriptions();

    return this.ensureFreshTokenForSSE()
      .catch((err) => {
        this.logger.warn(
          "Pre-SSE token refresh during rebuild failed - continuing with existing token",
          err?.message ? err.message : err,
        );
      })
      .then(() => {
        this.establishEventSubscriptions();
        return true;
      });
  }

  establishEventSubscriptions() {
    if (!this.hc || !this.deviceEventHandler) {
      return;
    }

    // Home Connect best practice: open one monitoring channel per appliance.
    // Respect the documented limit of 10 parallel monitoring channels.
    const allHaIds = Array.from(this.devices.keys()).filter(Boolean);
    const maxChannels = 10;
    const targetHaIds = allHaIds.slice(0, maxChannels);

    if (allHaIds.length > maxChannels) {
      this.logger.warn(
        `Only opening ${maxChannels} of ${allHaIds.length} SSE channels due to Home Connect channel limit`,
      );
    }

    if (typeof this.hc.subscribeDevice === "function") {
      let newSubscriptions = 0;
      targetHaIds.forEach((haId) => {
        if (this.subscribedHaIds.has(haId)) {
          return;
        }

        this.hc.subscribeDevice(haId, "KEEP-ALIVE", (e) => {
          this.handleKeepAliveEvent(e);
        });
        this.hc.subscribeDevice(haId, "NOTIFY", (e) => {
          this.deviceEventHandler?.(e);
        });
        this.hc.subscribeDevice(haId, "STATUS", (e) => {
          this.deviceEventHandler?.(e);
        });
        this.hc.subscribeDevice(haId, "EVENT", (e) => {
          this.deviceEventHandler?.(e);
        });

        this.subscribedHaIds.add(haId);
        newSubscriptions += 1;
      });

      if (newSubscriptions > 0) {
        this.logger.info(`Established SSE subscriptions for ${newSubscriptions} device(s)`);
      } else {
        this.logger.debug("No new device SSE subscriptions required");
      }
    } else if (!this.subscribed && typeof this.hc.subscribe === "function") {
      // Compatibility fallback for clients without per-device subscribe.
      this.logger.warn("Falling back to global SSE subscription (no subscribeDevice API)");
      this.hc.subscribe("KEEP-ALIVE", (e) => {
        this.handleKeepAliveEvent(e);
      });
      this.hc.subscribe("NOTIFY", (e) => {
        this.deviceEventHandler?.(e);
      });
      this.hc.subscribe("STATUS", (e) => {
        this.deviceEventHandler?.(e);
      });
      this.hc.subscribe("EVENT", (e) => {
        this.deviceEventHandler?.(e);
      });
    }

    this.subscribed = true;
    if (this.heartbeatEnabled) {
      this.startHeartbeatMonitor();
    }
  }

  sortDevices() {
    const array = [...this.devices.entries()];
    const sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1 : -1));
    this.devices = new Map(sortedArray);
  }

  handleGetDevicesSuccess(result, sendSocketNotification) {
    let appliances = [];
    if (Array.isArray(result?.body?.data?.homeappliances)) {
      appliances = result.body.data.homeappliances;
    } else if (Array.isArray(result?.data?.homeappliances)) {
      appliances = result.data.homeappliances;
    } else if (Array.isArray(result?.data)) {
      appliances = result.data;
    }

    this.logger.info(`Found ${appliances.length} appliance(s)`);

    if (appliances.length === 0) {
      this.logger.warn("No appliances found - check Home Connect app");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "no_devices",
        message: "No devices found - check Home Connect app",
      });
    }

    const deviceRefs = appliances.map((device, index) => this.registerDevice(device, index));

    this.subscribeToDeviceEvents(this.getDeviceEventHandler(sendSocketNotification));
    this.sortDevices();
    this.broadcastDevices(sendSocketNotification);

    this.refreshDeviceDetailsSequentially(deviceRefs)
      .catch(() => {})
      .finally(() => {
        this.logger.debug("Device details refreshed; broadcasting");
        this.broadcastDevices(sendSocketNotification);

        this.broadcastToAllClients("INIT_STATUS", {
          status: "complete",
          message: `${appliances.length} device(s) loaded`,
        });

        const onDetailsRefreshed = this._onDetailsRefreshed;
        this._onDetailsRefreshed = null;
        try {
          onDetailsRefreshed?.();
        } catch (err) {
          this.logger.warn("Device refresh follow-up failed", err?.message ? err.message : err);
        }

        this.settleDeviceRefresh();
      });
  }

  handleGetDevicesError(error) {
    this.logger.error("Failed to get devices:", error?.stack ? error.stack : error);

    const message = error?.message ? error.message : "Unknown device error";
    const isRateLimit = isRateLimitError(error);
    const retryAfterSeconds = Number.isFinite(error?.retryAfterSeconds)
      ? Math.max(1, Math.ceil(error.retryAfterSeconds))
      : null;

    // A 429 here used to be a UI message and nothing else, so the periodic
    // snapshot and the forced program fetches kept running straight into the
    // penalty. Engage the shared backoff the program service already honours.
    let backoffSeconds = null;
    if (isRateLimit) {
      backoffSeconds = retryAfterSeconds || DEVICE_RATE_LIMIT_FALLBACK_S;
      this.setRateLimitUntil(Date.now() + backoffSeconds * 1000);
      this.logger.warn(
        retryAfterSeconds
          ? `Rate limit on device fetch - honoring Retry-After=${retryAfterSeconds}s`
          : `Rate limit on device fetch - backing off for ${backoffSeconds}s`,
      );
    }

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: isRateLimit
        ? retryAfterSeconds
          ? `HTTP 429: ${message} (Retry-After ${retryAfterSeconds}s)`
          : `HTTP 429: ${message}`
        : `Device error: ${message}`,
      statusCode: isRateLimit ? 429 : error?.statusCode || error?.status || null,
      rateLimitSeconds: backoffSeconds,
      isRateLimit,
    });

    this.settleDeviceRefresh();
  }

  // Exactly one settle per getDevices() run - the guard keeps a late status
  // rejection from re-firing after the run already completed.
  settleDeviceRefresh() {
    if (!this._deviceRefreshPending) {
      return;
    }
    this._deviceRefreshPending = false;
    this._onDetailsRefreshed = null;
    try {
      this.onRefreshSettled();
    } catch (err) {
      this.logger.warn("Device refresh settle handler failed", err?.message ? err.message : err);
    }
  }

  /**
   * @param {Function} sendSocketNotification - Broadcast sink for DEVICES_UPDATE
   * @param {object} [options]
   * @param {Function} [options.onDetailsRefreshed] - Runs once the per-appliance
   *   status calls are done (success path only), so follow-up requests see fresh
   *   state and do not overlap with them
   */
  getDevices(sendSocketNotification, options = {}) {
    this._deviceRefreshPending = true;
    this._onDetailsRefreshed = typeof options.onDetailsRefreshed === "function" ? options.onDetailsRefreshed : null;

    if (!this.hc) {
      this.logger.error("HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready",
      });
      this.settleDeviceRefresh();
      return;
    }

    this.logger.debug("Fetching devices from Home Connect API");

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Fetching devices...",
    });

    if (this.hc && typeof this.hc.getHomeAppliances === "function") {
      this.recordApiCall("homeappliances");
      this.hc
        .getHomeAppliances()
        .then((res) => {
          if (res?.success && res.data) {
            this.handleGetDevicesSuccess(res, sendSocketNotification);
          } else {
            const err = new Error(res?.error ? res.error : "Failed to fetch appliances");
            err.statusCode = res?.statusCode ? res.statusCode : null;
            err.retryAfterSeconds = res && Number.isFinite(res.retryAfterSeconds) ? res.retryAfterSeconds : null;
            this.handleGetDevicesError(err);
          }
        })
        .catch((err) => this.handleGetDevicesError(err));
      return;
    }

    const err = new Error("HomeConnect client missing getHomeAppliances wrapper - cannot fetch devices");
    this.logger.error(err.message);
    this.handleGetDevicesError(err);
  }

  deviceEvent(data, sendSocketNotification) {
    try {
      const eventObj = JSON.parse(data.data);
      const items = this.normalizeEventItems(eventObj);
      let processed = false;
      const touchedHaIds = new Set();

      items.forEach((rawItem) => {
        const item = this.normalizeEventItem(rawItem, eventObj);
        if (!item?.haId || !item.key) {
          return;
        }
        const device = this.devices.get(item.haId);
        if (!device) {
          return;
        }

        device.connected = true;

        // Every applied key, not a hand-picked few: when an appliance does not show
        // the state it should, the first question is always whether the event for
        // it arrived at all.
        this.logger.debug("SSE event applied", {
          haId: item.haId,
          device: device.name,
          key: item.key,
          value: item.value,
        });

        if (this.hc && typeof this.hc.applyEventToDevice === "function") {
          this.hc.applyEventToDevice(device, item);
          processed = true;
        } else {
          this.logger.warn("No event parser available for device events; update homeconnect-api client");
        }

        touchedHaIds.add(item.haId);
      });

      if (processed) {
        this.recordSseEvent();
        this.broadcastDevices(sendSocketNotification);
        this.markSseTraffic();
      }

      for (const haId of touchedHaIds) {
        this.requestActiveProgramOnStart(this.devices.get(haId));
      }
    } catch (error) {
      this.logger.error("Error processing device event:", error);
    }
  }

  /*
   * SSE only updates raw runtime fields (state, remaining time, progress). The
   * program's name, phase and options come from /programs/active, which nothing
   * else asks for when an appliance starts - so a program that sat on the dial
   * as "selected" kept showing that way, without phase, until the next snapshot.
   * Asked once per run: the flag clears when the appliance is idle again, so a
   * run whose REST answer stays "selected" cannot turn every SSE delta into a
   * request.
   */
  requestActiveProgramOnStart(device) {
    if (!device?.haId) {
      return;
    }
    if (!deviceAppearsActive(device)) {
      this.activeProgramRequestedHaIds.delete(device.haId);
      return;
    }
    if (device.ActiveProgramSource === "active" || this.activeProgramRequestedHaIds.has(device.haId)) {
      return;
    }
    this.activeProgramRequestedHaIds.add(device.haId);
    this.logger.debug(`${device.name} started - fetching its active program`);
    this.onActiveProgramNeeded(device.haId);
  }

  normalizeEventItems(payload) {
    if (!payload) {
      return [];
    }
    if (Array.isArray(payload.items) && payload.items.length) {
      return payload.items;
    }
    return [payload];
  }

  normalizeEventItem(item, fallback) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const normalized = { ...item };
    if (!normalized.key && normalized.data && normalized.data.key) {
      normalized.key = normalized.data.key;
    }
    if (normalized.value === undefined && normalized.data && normalized.data.value !== undefined) {
      normalized.value = normalized.data.value;
    } else if (normalized.value === undefined && normalized.data && normalized.data.value === undefined) {
      normalized.value = normalized.data;
    }
    if (!normalized.uri && normalized.data && normalized.data.uri) {
      normalized.uri = normalized.data.uri;
    }

    normalized.haId = normalized.haId || fallback?.haId || this.extractHaIdFromUri(normalized.uri || fallback?.uri);

    return normalized;
  }

  extractHaIdFromUri(uri) {
    if (!uri || typeof uri !== "string") {
      return null;
    }
    const parts = uri.split("/");
    const index = parts.indexOf("homeappliances");
    if (index !== -1 && parts.length > index + 1) {
      return parts[index + 1];
    }
    // Legacy URIs like /notifications/homeappliances/<haId>/events/...
    if (parts.length >= 4) {
      return parts[3];
    }
    return null;
  }

  ensureFreshTokenForSSE() {
    if (!this.hc || typeof this.hc.refreshTokens !== "function") {
      return Promise.resolve();
    }

    if (this._sseTokenRefreshPromise) {
      return this._sseTokenRefreshPromise;
    }

    if (typeof this.hc.tokenRefreshBackoffRemainingMs === "function" && this.hc.tokenRefreshBackoffRemainingMs() > 0) {
      this.logger.warn("Skipping pre-SSE token refresh - token endpoint is in backoff; using existing token");
      return Promise.resolve();
    }

    const now = Date.now();
    if (this._lastTokenRefreshedAt && now - this._lastTokenRefreshedAt < SSE_TOKEN_RECENT_REFRESH_MS) {
      return Promise.resolve();
    }

    // An access token lives for a day. Refreshing it before every rebuild spent a
    // request - and one of only 100 token refreshes a day - per SSE hiccup; the
    // new streams only need a token that outlives the connect (a 401 later is
    // handled by the stream's own auth recovery).
    const tokens = this.hc.tokens;
    if (Number.isFinite(tokens?.timestamp) && Number.isFinite(tokens?.expires_in)) {
      const validForMs = (tokens.timestamp + tokens.expires_in) * 1000 - now;
      if (validForMs > SSE_TOKEN_MIN_VALIDITY_MS) {
        this.logger.debug(
          `Access token valid for another ${Math.round(validForMs / 60000)} min - no refresh before SSE`,
        );
        return Promise.resolve();
      }
    }

    this.logger.debug("Refreshing Home Connect token before establishing SSE streams");

    this._sseTokenRefreshPromise = this.hc
      .refreshTokens()
      .catch((err) => {
        this.logger.error("Token refresh before SSE failed", err?.message ? err.message : err);
        throw err;
      })
      .finally(() => {
        this._lastTokenRefreshedAt = Date.now();
        this._sseTokenRefreshPromise = null;
      });

    return this._sseTokenRefreshPromise;
  }
}

module.exports = DeviceService;
