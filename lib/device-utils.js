"use strict";

function getNumericValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "number") {
    return optionValue;
  }
  if (typeof optionValue === "object") {
    if (typeof optionValue.value === "number") {
      return optionValue.value;
    }
    if (typeof optionValue.displayValue === "number") {
      return optionValue.displayValue;
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
    if (typeof optionValue.value === "string") {
      return optionValue.value;
    }
    if (typeof optionValue.displayValue === "string") {
      return optionValue.displayValue;
    }
  }
  return null;
}

function deviceAppearsActive(device) {
  if (!device) return false;
  const remainingSeconds = getNumericValue(device.RemainingProgramTime);
  if (typeof remainingSeconds === "number" && remainingSeconds > 0) {
    return true;
  }
  const progressValue = getNumericValue(device.ProgramProgress);
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
    function parseRemainingSeconds(device) {
      const remCandidates = [
        device?.RemainingProgramTime,
        device?.remainingProgramTime,
        device?.remaining_time,
        device?.remaining,
        device?.["BSH.Common.Status.RemainingProgramTime"],
        device?.["BSH.Common.Option.RemainingProgramTime"]
      ];
      for (const v of remCandidates) {
        if (v === undefined || v === null) continue;
        if (typeof v === "number" && !Number.isNaN(v)) return v;
        if (typeof v === "string") {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n)) return n;
          const m = v.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) {
            return (
              parseInt(m[1] || "0", 10) * 3600 +
              parseInt(m[2] || "0", 10) * 60 +
              parseInt(m[3] || "0", 10)
            );
          }
        }
      }
      return null;
    }

    function parseProgress(device) {
      return (
        device?.ProgramProgress ??
        device?.programProgress ??
        device?.program_progress ??
        device?.["BSH.Common.Option.ProgramProgress"] ??
        device?.["BSH.Common.Status.ProgramProgress"] ??
        undefined
      );
    }

    function deviceAppearsActiveClient(device) {
      if (!device) return false;
      const rem = parseRemainingSeconds(device);
      if (typeof rem === "number" && rem > 0) return true;
      const prog = parseProgress(device);
      if (typeof prog === "number" && prog > 0 && prog < 100) return true;
      const op = device?.OperationState || device?.operationState || null;
      if (op && /(Run|Active|DelayedStart)/i.test(op)) return true;
      return false;
    }

    // Attach to window for frontend consumption
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils = window.HomeConnectDeviceUtils || {};
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseRemainingSeconds = parseRemainingSeconds;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseProgress = parseProgress;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.deviceAppearsActive = deviceAppearsActiveClient;
    // also expose generic helpers
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.getNumericValue = exportsObj.getNumericValue;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.getStringValue = exportsObj.getStringValue;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.isDeviceConnected = exportsObj.isDeviceConnected;
  })();
}
