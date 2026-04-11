"use strict";

const {
  collectProgramOptionLabels,
  extractProgramList,
  findProgramPhaseLabel,
  getDeviceTypeMeta,
  parseDurationSeconds,
  summarizeAvailablePrograms,
  summarizeProgramConstraints
} = require("./device-utils");

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

function clearProgramFields(device) {
  delete device.ActiveProgramKey;
  delete device.ActiveProgramName;
  delete device.ActiveProgramSource;
  delete device.ActiveProgramPhase;
  delete device.ActiveProgramDetails;
  delete device.EstimatedTotalProgramTime;
}

function pickProgramName(program) {
  if (!program || typeof program !== "object") {
    return null;
  }
  return program.name || program.key || null;
}

function shouldUseAvailableProgramsFallback(device) {
  const canonicalType = getDeviceTypeMeta(device?.type).canonicalType;
  const blockedTypes = new Set([
    "Washer",
    "Dryer",
    "WasherDryer",
    "Dishwasher",
    "CoffeeMaker",
    "Hood",
    "Oven"
  ]);

  return !blockedTypes.has(canonicalType);
}

class ProgramService {
  constructor(options) {
    this.logger = options.logger;
    this.globalSession = options.globalSession;
    this.activeProgramManager = options.activeProgramManager;
    this.hc = null;
    this.devices = options.devices; // shared map
    this.availableProgramDefinitionCache = new Map();
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => {});
    this.setRateLimitUntil = options.setRateLimitUntil || (() => {});
  }

  attachClient(hc) {
    this.hc = hc;
    this.availableProgramDefinitionCache.clear();
  }

  getAvailableProgramDefinitionCacheKey(haId, programKey) {
    return `${haId}::${programKey}`;
  }

  async fetchAvailableProgramDefinition(haId, programKey, deviceName) {
    if (!programKey || !this.hc || typeof this.hc.getAvailableProgram !== "function") {
      return null;
    }

    const cacheKey = this.getAvailableProgramDefinitionCacheKey(haId, programKey);
    if (this.availableProgramDefinitionCache.has(cacheKey)) {
      return this.availableProgramDefinitionCache.get(cacheKey);
    }

    this.recordApiCall("availableProgram");
    this.logger(
      "debug",
      `Fetching available program constraints for ${deviceName} (${programKey})`
    );

    const res = await this.hc.getAvailableProgram(haId, programKey);
    if (res.success) {
      this.availableProgramDefinitionCache.set(cacheKey, res.data);
      return res.data;
    }

    if (res.statusCode === 429) {
      const err = new Error(res.error || "rate limit");
      err.statusCode = 429;
      throw err;
    }

    this.logger(
      "debug",
      `No available program constraints for ${deviceName} (${programKey})`,
      res.error || res.statusCode || "unknown"
    );
    return null;
  }

  async fetchAvailableProgramsSnapshot(haId, deviceName) {
    if (!this.hc || typeof this.hc.getAvailablePrograms !== "function") {
      return null;
    }

    this.recordApiCall("availablePrograms");
    this.logger("debug", `Fetching available programs for ${deviceName} (${haId})`);
    const res = await this.hc.getAvailablePrograms(haId);

    if (!res.success) {
      if (res.statusCode === 429) {
        const err = new Error(res.error || "rate limit");
        err.statusCode = 429;
        throw err;
      }
      return null;
    }

    const programs = extractProgramList(res.data);
    const firstProgram = programs.find((program) => program && program.key);
    const programDefinition = firstProgram
      ? await this.fetchAvailableProgramDefinition(haId, firstProgram.key, deviceName)
      : null;

    return {
      programs,
      programDefinition
    };
  }

  async enrichProgramResult(haId, deviceName, result) {
    if (!result?.success || !result?.data?.key) {
      return result;
    }

    result.availableProgram = await this.fetchAvailableProgramDefinition(
      haId,
      result.data.key,
      deviceName
    );
    return result;
  }

  async fetchActiveProgramForDevice(haId, deviceName) {
    const LONG_ACTIVE_PROGRAM_REQUEST_MS = 4000;
    const started = Date.now();
    const device = this.devices.get(haId);
    try {
      this.recordApiCall("activeProgram");
      this.logger("debug", `Fetching active program for ${deviceName} (${haId})`);
      if (this.hc && typeof this.hc.getActiveProgram === "function") {
        const res = await this.hc.getActiveProgram(haId);
        if (res.success) {
          const durationMs = Date.now() - started;
          this.logger("debug", `Active program data received for ${deviceName} in ${durationMs}ms`);
          if (durationMs > LONG_ACTIVE_PROGRAM_REQUEST_MS) {
            this.logger("warn", `Slow active program response for ${deviceName}: ${durationMs}ms`);
          }
          return this.enrichProgramResult(haId, deviceName, {
            haId,
            success: true,
            data: res.data,
            source: "active"
          });
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
              return this.enrichProgramResult(haId, deviceName, {
                haId,
                success: true,
                data: selectedRes.data,
                source: "selected"
              });
            }
          }

          if (!shouldUseAvailableProgramsFallback(device)) {
            this.logger(
              "debug",
              `Skipping available program fallback for ${deviceName} (${device?.type || "unknown type"})`
            );
            return { haId, success: false, error: "No active program" };
          }

          const availableSnapshot = await this.fetchAvailableProgramsSnapshot(haId, deviceName);
          if (availableSnapshot && availableSnapshot.programs.length) {
            return {
              haId,
              success: true,
              data: availableSnapshot,
              source: "available"
            };
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

    if (result.source === "available") {
      clearProgramFields(device);

      const availablePrograms = summarizeAvailablePrograms(result.data.programs, { maxItems: 4 });
      device.AvailablePrograms = availablePrograms;
      device.AvailableProgramCount = extractProgramList(result.data.programs).length;
      device.AvailableProgramName =
        pickProgramName(result.data.programDefinition) || availablePrograms[0] || null;
      device.AvailableOptionDetails = summarizeProgramConstraints(result.data.programDefinition, {
        maxItems: 4
      });

      return {
        name: device.name,
        program: {
          availablePrograms,
          availableOptionDetails: device.AvailableOptionDetails
        }
      };
    }

    device.ActiveProgramKey = result.data.key || null;
    device.ActiveProgramName = result.data.name || result.data.key || null;
    device.ActiveProgramSource = result.source || "active";
    device.ActiveProgramPhase = findProgramPhaseLabel(result.data);
    device.ActiveProgramDetails = collectProgramOptionLabels(result.data, { maxItems: 4 });

    if (result.availableProgram) {
      device.AvailableProgramName = pickProgramName(result.availableProgram);
      device.AvailableOptionDetails = summarizeProgramConstraints(result.availableProgram, {
        maxItems: 4
      });
    } else {
      delete device.AvailableProgramName;
      delete device.AvailableOptionDetails;
    }

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

    delete device.AvailablePrograms;
    delete device.AvailableProgramCount;

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

      this.setRateLimitUntil(Date.now() + backoffMs);

      this.logger("warn", `Rate limit detected - backing off for ${backoffMinutes} minutes`);

      broadcastToAllClients("INIT_STATUS", {
        status: "device_error",
        message: `Rate limit detected - wait ${backoffMinutes} minutes`,
        rateLimitSeconds: backoffMinutes * 60,
        statusCode: 429,
        isRateLimit: true
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
