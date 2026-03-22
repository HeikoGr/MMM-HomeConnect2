"use strict";

function parseIsoDurationSeconds(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) {
    return null;
  }

  return (
    parseInt(match[1] || "0", 10) * 3600 +
    parseInt(match[2] || "0", 10) * 60 +
    parseInt(match[3] || "0", 10)
  );
}

function getNumericValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "number") {
    return optionValue;
  }
  if (typeof optionValue === "object") {
    const nestedValue = getNumericValue(optionValue.value);
    if (nestedValue !== null) {
      return nestedValue;
    }
    const nestedDisplayValue = getNumericValue(optionValue.displayValue);
    if (nestedDisplayValue !== null) {
      return nestedDisplayValue;
    }
  }
  const parsed = Number(optionValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "string") {
    return optionValue;
  }
  if (typeof optionValue === "object") {
    const nestedValue = getStringValue(optionValue.value);
    if (nestedValue !== null) {
      return nestedValue;
    }
    const nestedDisplayValue = getStringValue(optionValue.displayValue);
    if (nestedDisplayValue !== null) {
      return nestedDisplayValue;
    }
  }
  return null;
}

function parseDurationSeconds(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }

  const numericValue = getNumericValue(optionValue);
  if (numericValue !== null) {
    return numericValue;
  }

  if (typeof optionValue === "object") {
    const nestedValue = parseDurationSeconds(optionValue.value);
    if (nestedValue !== null) {
      return nestedValue;
    }
    return parseDurationSeconds(optionValue.displayValue);
  }

  return parseIsoDurationSeconds(String(optionValue));
}

function parseRemainingSeconds(device) {
  if (!device) {
    return null;
  }

  const remainingCandidates = [
    device.RemainingProgramTime,
    device.remainingProgramTime,
    device.remaining_time,
    device.remaining,
    device["BSH.Common.Status.RemainingProgramTime"],
    device["BSH.Common.Option.RemainingProgramTime"]
  ];

  for (const candidate of remainingCandidates) {
    const parsed = parseDurationSeconds(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseProgress(device) {
  if (!device) {
    return undefined;
  }

  const progressCandidates = [
    device.ProgramProgress,
    device.programProgress,
    device.program_progress,
    device["BSH.Common.Option.ProgramProgress"],
    device["BSH.Common.Status.ProgramProgress"]
  ];

  for (const candidate of progressCandidates) {
    const parsed = getNumericValue(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return undefined;
}

function parseEstimatedTotalSeconds(device) {
  if (!device) {
    return null;
  }

  const durationCandidates = [
    device.EstimatedTotalProgramTime,
    device.estimatedTotalProgramTime,
    device.programDuration,
    device["BSH.Common.Option.EstimatedTotalProgramTime"],
    device["BSH.Common.Status.EstimatedTotalProgramTime"],
    device["BSH.Common.Option.ProgramDuration"]
  ];

  for (const candidate of durationCandidates) {
    const parsed = parseDurationSeconds(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function isEstimatedDuration(device) {
  if (!device) {
    return false;
  }

  const candidates = [
    device.RemainingProgramTimeIsEstimated,
    device.remainingProgramTimeIsEstimated,
    device["BSH.Common.Option.RemainingProgramTimeIsEstimated"],
    device["BSH.Common.Status.RemainingProgramTimeIsEstimated"]
  ];

  for (const candidate of candidates) {
    if (candidate === true) {
      return true;
    }
    if (candidate === false) {
      return false;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    if (typeof candidate === "object" && candidate !== null) {
      if (candidate.value === true || candidate.displayValue === true) {
        return true;
      }
      if (candidate.value === false || candidate.displayValue === false) {
        return false;
      }
    }
  }

  return false;
}

function isDoorOpen(device) {
  if (!device) {
    return false;
  }

  return Boolean(device.DoorOpen || device.DoorState === "Open" || device.doorState === "Open");
}

function hasInformativeState(device) {
  if (!device) {
    return false;
  }

  const remainingSeconds = parseRemainingSeconds(device);
  if (typeof remainingSeconds === "number" && remainingSeconds >= 0) {
    return true;
  }

  const progressValue = parseProgress(device);
  if (progressValue !== undefined && progressValue !== null) {
    return true;
  }

  return Boolean(
    device.ActiveProgramName ||
    device.ActiveProgramPhase ||
    device.OperationState ||
    device.operationState ||
    device.RemainingProgramTime ||
    parseEstimatedTotalSeconds(device) !== null
  );
}

function shouldDisplayDevice(device, config = {}) {
  if (!device) {
    return false;
  }

  if (config.showAlwaysAllDevices) {
    return true;
  }
  if (device.PowerState === "On") {
    return true;
  }
  if (device.Lighting) {
    return true;
  }
  if (config.showDeviceIfDoorIsOpen && isDoorOpen(device)) {
    return true;
  }
  if (config.showDeviceIfFailure && device.Failure) {
    return true;
  }
  if (config.showDeviceIfInfoIsAvailable && hasInformativeState(device)) {
    return true;
  }

  return false;
}

function deviceAppearsActive(device) {
  if (!device) return false;
  const remainingSeconds = parseRemainingSeconds(device);
  if (typeof remainingSeconds === "number" && remainingSeconds > 0) {
    return true;
  }
  const progressValue = parseProgress(device);
  if (typeof progressValue === "number" && progressValue > 0 && progressValue < 100) {
    return true;
  }
  const operationState = getStringValue(device.OperationState);
  if (operationState && /(Run|Active|DelayedStart)/i.test(operationState)) {
    return true;
  }
  return false;
}

function isDeviceConnected(device) {
  if (!device) return false;
  const v = device.connected;
  if (v === true) return true;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "true" || s === "connected" || s === "online" || s === "available") return true;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  return !!v;
}

const exportsObj = {
  getNumericValue,
  getStringValue,
  parseDurationSeconds,
  parseRemainingSeconds,
  parseProgress,
  parseEstimatedTotalSeconds,
  isEstimatedDuration,
  isDoorOpen,
  hasInformativeState,
  shouldDisplayDevice,
  deviceAppearsActive,
  isDeviceConnected
};

// Export for Node.js if available
if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}

// Browser compatibility: expose parsing helpers to the frontend via
// `window.HomeConnectDeviceUtils` so the client-side module can reuse
// the same parsing logic as the backend. This mirrors the former
// `device-utils-client.js` behavior but keeps a single source of truth.
if (typeof window !== "undefined") {
  (function () {
    // Attach to window for frontend consumption
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils = window.HomeConnectDeviceUtils || {};
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseRemainingSeconds = exportsObj.parseRemainingSeconds;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseProgress = exportsObj.parseProgress;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseEstimatedTotalSeconds =
      exportsObj.parseEstimatedTotalSeconds;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.isEstimatedDuration = exportsObj.isEstimatedDuration;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.isDoorOpen = exportsObj.isDoorOpen;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.hasInformativeState = exportsObj.hasInformativeState;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.shouldDisplayDevice = exportsObj.shouldDisplayDevice;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.deviceAppearsActive = exportsObj.deviceAppearsActive;
    // also expose generic helpers
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.getNumericValue = exportsObj.getNumericValue;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseDurationSeconds = exportsObj.parseDurationSeconds;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.getStringValue = exportsObj.getStringValue;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.isDeviceConnected = exportsObj.isDeviceConnected;
  })();
}
