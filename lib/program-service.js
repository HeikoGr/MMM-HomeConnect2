"use strict";

const { parseDurationSeconds } = require("./device-utils");

function getOptionByKey(programData, key) {
  const options = Array.isArray(programData?.options) ? programData.options : [];
  return options.find((item) => item && item.key === key) || null;
}

function getOptionLabel(option, options = {}) {
  if (!option) {
    return "";
  }

  const preferName = options.preferName === true;

  if (preferName && typeof option.name === "string" && option.name.trim()) {
    return option.name.trim();
  }

  if (typeof option.displayvalue === "string" && option.displayvalue.trim()) {
    return option.displayvalue.trim();
  }

  if (typeof option.displayValue === "string" && option.displayValue.trim()) {
    return option.displayValue.trim();
  }

  if (option.value === true && typeof option.name === "string" && option.name.trim()) {
    return option.name.trim();
  }

  if (typeof option.value === "number" && typeof option.name === "string" && option.name.trim()) {
    const unit =
      typeof option.unit === "string" && option.unit.trim() ? ` ${option.unit.trim()}` : "";
    return `${option.name.trim()} ${option.value}${unit}`;
  }

  return "";
}

function collectProgramDetails(programData) {
  const detailKeys = [
    { key: "LaundryCare.Dryer.Option.DryingTarget" },
    { key: "LaundryCare.Dryer.Option.WrinkleGuard", preferName: true },
    { key: "LaundryCare.Dryer.Option.Gentle" }
  ];

  return detailKeys
    .map(({ key, preferName }) => getOptionLabel(getOptionByKey(programData, key), { preferName }))
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
}

function findProgramPhase(programData) {
  const phaseKeys = [
    "LaundryCare.Dryer.Option.ProcessPhase",
    "LaundryCare.Common.Option.ProcessPhase"
  ];

  for (const key of phaseKeys) {
    const label = getOptionLabel(getOptionByKey(programData, key));
    if (label) {
      return label;
    }
  }

  return null;
}

function findPlannedDurationSeconds(programData) {
  const options = Array.isArray(programData?.options) ? programData.options : [];
  const durationKeys = [
    "BSH.Common.Option.EstimatedTotalProgramTime",
    "BSH.Common.Option.ProgramDuration",
    "BSH.Common.Option.Duration"
  ];

  for (const durationKey of durationKeys) {
    const option = options.find((item) => item && item.key === durationKey);
    const seconds = parseDurationSeconds(option?.value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  }

  return null;
}

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

          if (typeof this.hc.getSelectedProgram === "function") {
            this.recordApiCall("selectedProgram");
            const selectedRes = await this.hc.getSelectedProgram(haId);
            if (selectedRes.success) {
              this.logger(
                "debug",
                `Selected program data received for ${deviceName} in ${Date.now() - started}ms`
              );
              return {
                haId,
                success: true,
                data: selectedRes.data,
                source: "selected"
              };
            }
          }

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

    device.ActiveProgramKey = result.data.key || null;
    device.ActiveProgramName = result.data.name || result.data.key || null;
    device.ActiveProgramSource = result.source || "active";
    device.ActiveProgramPhase = findProgramPhase(result.data);
    device.ActiveProgramDetails = collectProgramDetails(result.data);

    const plannedDurationSeconds = findPlannedDurationSeconds(result.data);
    if (Number.isFinite(plannedDurationSeconds) && plannedDurationSeconds > 0) {
      device.EstimatedTotalProgramTime = plannedDurationSeconds;
    } else {
      delete device.EstimatedTotalProgramTime;
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
