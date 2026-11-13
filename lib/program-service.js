"use strict";

const {
  collectProgramOptionLabels,
  findProgramPhaseLabel,
  isRateLimitError,
  parseDurationSeconds,
} = require("./device-utils");
const { applyEventToDevice } = require("./device-events");

function findPlannedDurationSeconds(programData) {
  const options = Array.isArray(programData?.options) ? programData.options : [];
  const durationKeys = ["BSH.Common.Option.EstimatedTotalProgramTime"];

  for (const durationKey of durationKeys) {
    const option = options.find((item) => item && item.key === durationKey);
    const seconds = parseDurationSeconds(option?.value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  }

  return null;
}

class ProgramService {
  constructor(options) {
    this.logger = options.logger;
    this.globalSession = options.globalSession;
    this.activeProgramManager = options.activeProgramManager;
    this.hc = null;
    // Accept a getter so callers can pass () => deviceService.devices and
    // always reach the live map even after sortDevices() replaces it.
    this.getDevices =
      typeof options.getDevices === "function" ? options.getDevices : () => options.devices || new Map();
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => {});
    this.setRateLimitUntil = options.setRateLimitUntil || (() => {});
  }

  attachClient(hc) {
    this.hc = hc;
  }

  async fetchActiveProgramForDevice(haId, deviceName) {
    const LONG_ACTIVE_PROGRAM_REQUEST_MS = 4000;
    const started = Date.now();
    try {
      this.recordApiCall("activeProgram");
      this.logger.debug(`Fetching active program for ${deviceName} (${haId})`);
      if (this.hc) {
        const res = await this.hc.getActiveProgram(haId);
        if (res.success) {
          const durationMs = Date.now() - started;
          this.logger.debug(`Active program data received for ${deviceName} in ${durationMs}ms`);
          if (durationMs > LONG_ACTIVE_PROGRAM_REQUEST_MS) {
            this.logger.warn(`Slow active program response for ${deviceName}: ${durationMs}ms`);
          }
          return { haId, success: true, data: res.data, source: "active" };
        }
        if (res.statusCode === 404) {
          const durationMs = Date.now() - started;
          this.logger.debug(`No active program payload for ${deviceName} (status 404, ${durationMs}ms)`);

          this.recordApiCall("selectedProgram");
          const selectedRes = await this.hc.getSelectedProgram(haId);
          if (selectedRes.success) {
            this.logger.debug(`Selected program data received for ${deviceName} in ${Date.now() - started}ms`);
            return { haId, success: true, data: selectedRes.data, source: "selected" };
          }

          return { haId, success: false, statusCode: 404, error: "No active program" };
        }
        if (res.statusCode === 429) {
          this.logger.warn(`Rate limit hit for ${deviceName}`);
          const err = new Error(res.error || "rate limit");
          err.statusCode = 429;
          if (Number.isFinite(res.retryAfterSeconds)) {
            err.retryAfterSeconds = res.retryAfterSeconds;
          }
          throw err;
        }
        const durationMs = Date.now() - started;
        this.logger.debug(
          `Active program request for ${deviceName} failed (${res.statusCode || "n/a"}) in ${durationMs}ms`,
        );
        return {
          haId,
          success: false,
          statusCode: res.statusCode || null,
          error: res.error || "Unknown error",
        };
      }

      const err = new Error("HomeConnect client not attached");
      this.logger.error(err.message);
      return { haId, success: false, statusCode: null, error: err.message };
    } catch (error) {
      // Status codes come from the error fields only: a "404" inside a message text can be a
      // port or an id, and treating that as "no program" would hide a real failure.
      if (error.statusCode === 404 || error.status === 404) {
        this.logger.debug(`No active program for ${deviceName}`);
        return { haId, success: false, statusCode: 404, error: "No active program" };
      }

      if (isRateLimitError(error)) {
        this.logger.warn(`Rate limit hit for ${deviceName}`);
        throw error;
      }

      const durationMs = Date.now() - started;
      this.logger.error(
        `Error fetching active program for ${deviceName} after ${durationMs}ms:`,
        error.message || error,
      );
      return {
        haId,
        success: false,
        statusCode: error.statusCode || error.status || null,
        error: error.message || "Unknown error",
      };
    }
  }

  applyProgramResult(result) {
    const device = this.getDevices().get(result.haId);
    if (!device || !result.data) {
      return null;
    }

    device.connected = true;

    device.ActiveProgramKey = result.data.key || null;
    device.ActiveProgramName = result.data.name || result.data.key || null;
    device.ActiveProgramSource = result.source || "active";
    device.ActiveProgramPhase = findProgramPhaseLabel(result.data);
    device.ActiveProgramDetails = collectProgramOptionLabels(result.data, { maxItems: 4 });

    const plannedDurationSeconds = findPlannedDurationSeconds(result.data);
    if (Number.isFinite(plannedDurationSeconds) && plannedDurationSeconds > 0) {
      device.EstimatedTotalProgramTime = plannedDurationSeconds;
    } else {
      delete device.EstimatedTotalProgramTime;
    }

    if (result.data.options) {
      this.logger.debug(`Applying ${result.data.options.length} option update(s) for ${device.name}`);
      for (const option of result.data.options) {
        applyEventToDevice(device, option);
      }
    }

    return {
      name: device.name,
      program: result.data,
    };
  }

  broadcastProgramData(programData, requestingIdentifier, broadcastDevices, broadcastToAllClients) {
    const deviceNames = Object.values(programData).map((item) => item.name);
    this.logger.info(`Active programs fetched: ${deviceNames.length} with data`);
    this.logger.debug("Active program payload", {
      devicesWithProgram: deviceNames,
    });

    broadcastDevices();

    broadcastToAllClients("ACTIVE_PROGRAMS_DATA", {
      programs: programData,
      timestamp: Date.now(),
      identifier: requestingIdentifier,
    });
  }

  handleActiveProgramFetchError(error, broadcastToAllClients) {
    this.logger.error("Failed to fetch active programs:", error.message);

    if (isRateLimitError(error)) {
      const retryAfterSeconds = Number.isFinite(error.retryAfterSeconds)
        ? Math.max(1, Math.ceil(error.retryAfterSeconds))
        : null;
      const backoffMinutes = Math.min(2 * 2 ** Math.floor(Math.random() * 3), 10);
      const fallbackBackoffMs = backoffMinutes * 60 * 1000;
      const backoffMs = retryAfterSeconds ? retryAfterSeconds * 1000 : fallbackBackoffMs;

      this.setRateLimitUntil(Date.now() + backoffMs);

      this.logger.warn(
        retryAfterSeconds
          ? `Rate limit detected - honoring Retry-After=${retryAfterSeconds}s`
          : `Rate limit detected - backing off for ${backoffMinutes} minutes`,
      );

      broadcastToAllClients("INIT_STATUS", {
        status: "device_error",
        message: retryAfterSeconds
          ? `Rate limit detected - wait ${retryAfterSeconds}s`
          : `Rate limit detected - wait ${backoffMinutes} minutes`,
        rateLimitSeconds: retryAfterSeconds || backoffMinutes * 60,
        statusCode: 429,
        isRateLimit: true,
      });

      return;
    }

    broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Error loading programs: ${error.message}`,
    });
  }
}

module.exports = ProgramService;
