"use strict";

// Import removed unused helpers; kept minimal to satisfy linter

class ProgramService {
  constructor(options) {
    this.logger = options.logger;
    this.globalSession = options.globalSession;
    this.activeProgramManager = options.activeProgramManager;
    this.hc = null;
    this.devices = options.devices; // shared map
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => {});
  }

  attachClient(hc) {
    this.hc = hc;
  }

  async fetchActiveProgramForDevice(haId, deviceName) {
    const LONG_ACTIVE_PROGRAM_REQUEST_MS = 4000;
    const started = Date.now();
    try {
      this.recordApiCall("activeProgram");
      this.logger("debug", `Fetching active program for ${deviceName} (${haId})`);
      if (this.hc && typeof this.hc.getActiveProgram === "function") {
        this.recordApiCall("activeProgram");
        const res = await this.hc.getActiveProgram(haId);
        if (res.success) {
          const durationMs = Date.now() - started;
          this.logger("debug", `Active program data received for ${deviceName} in ${durationMs}ms`);
          if (durationMs > LONG_ACTIVE_PROGRAM_REQUEST_MS) {
            this.logger("warn", `Slow active program response for ${deviceName}: ${durationMs}ms`);
          }
          return { haId, success: true, data: res.data };
        }
        if (res.statusCode === 404) {
          const durationMs = Date.now() - started;
          this.logger(
            "debug",
            `No active program payload for ${deviceName} (status 404, ${durationMs}ms)`
          );
          return { haId, success: false, error: "No active program" };
        }
        if (res.statusCode === 429) {
          this.logger("warn", `Rate limit hit for ${deviceName}`);
          const err = new Error(res.error || "rate limit");
          err.statusCode = 429;
          throw err;
        }
        const durationMs = Date.now() - started;
        this.logger(
          "debug",
          `Active program request for ${deviceName} failed (${res.statusCode || "n/a"}) in ${durationMs}ms`
        );
        return { haId, success: false, error: res.error || "Unknown error" };
      }

      const err = new Error("HomeConnect client missing getActiveProgram wrapper");
      this.logger("error", err.message);
      return { haId, success: false, error: err.message };
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.status === 404 ||
        (error.message && error.message.includes("404"))
      ) {
        this.logger("debug", `No active program for ${deviceName}`);
        return { haId, success: false, error: "No active program" };
      }

      if (
        error.statusCode === 429 ||
        error.status === 429 ||
        (error.message && (error.message.includes("429") || error.message.includes("rate limit")))
      ) {
        this.logger("warn", `Rate limit hit for ${deviceName}`);
        throw error;
      }

      const durationMs = Date.now() - started;
      this.logger(
        "error",
        `Error fetching active program for ${deviceName} after ${durationMs}ms:`,
        error.message || error
      );
      return {
        haId,
        success: false,
        error: error.message || "Unknown error"
      };
    }
  }

  applyProgramResult(result) {
    const device = this.devices.get(result.haId);
    if (!device || !result.data) {
      return null;
    }

    if (result.data.options) {
      this.logger(
        "debug",
        `Applying ${result.data.options.length} option update(s) for ${device.name}`
      );
      result.data.options.forEach((option) => {
        if (this.hc && typeof this.hc.applyEventToDevice === "function") {
          this.hc.applyEventToDevice(device, option);
        }
      });
    }

    return {
      name: device.name,
      program: result.data
    };
  }

  broadcastProgramData(programData, requestingInstanceId, broadcastDevices, broadcastToAllClients) {
    const deviceNames = Object.values(programData).map((item) => item.name);
    this.logger("info", `Active programs fetched: ${deviceNames.length} with data`);
    this.logger("debug", "Active program payload", {
      devicesWithProgram: deviceNames
    });

    broadcastDevices();

    broadcastToAllClients("ACTIVE_PROGRAMS_DATA", {
      programs: programData,
      timestamp: Date.now(),
      instanceId: requestingInstanceId
    });
  }

  handleActiveProgramFetchError(error, broadcastToAllClients) {
    this.logger("error", "Failed to fetch active programs:", error.message);

    if (
      error.statusCode === 429 ||
      error.message?.includes("429") ||
      error.message?.includes("rate limit")
    ) {
      const backoffMinutes = Math.min(2 * Math.pow(2, Math.floor(Math.random() * 3)), 10);
      const backoffMs = backoffMinutes * 60 * 1000;

      this.globalSession.rateLimitUntil = Date.now() + backoffMs;

      this.logger("warn", `Rate limit detected - backing off for ${backoffMinutes} minutes`);

      broadcastToAllClients("INIT_STATUS", {
        status: "device_error",
        message: `Rate limit detected - wait ${backoffMinutes} minutes`,
        rateLimitSeconds: backoffMinutes * 60
      });

      return;
    }

    broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Error loading programs: ${error.message}`
    });
  }
}

module.exports = ProgramService;
