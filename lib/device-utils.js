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

function getBooleanValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "boolean") {
    return optionValue;
  }
  if (typeof optionValue === "string") {
    const normalized = optionValue.trim().toLowerCase();
    if (["true", "on", "open", "active", "enabled", "present"].includes(normalized)) {
      return true;
    }
    if (["false", "off", "closed", "inactive", "disabled", "absent"].includes(normalized)) {
      return false;
    }
  }
  if (typeof optionValue === "object") {
    const nestedValue = getBooleanValue(optionValue.value);
    if (nestedValue !== null) {
      return nestedValue;
    }
    return getBooleanValue(optionValue.displayValue);
  }
  return null;
}

function getOptionDisplayText(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return "";
  }

  if (typeof optionValue === "object") {
    if (typeof optionValue.displayvalue === "string" && optionValue.displayvalue.trim()) {
      return optionValue.displayvalue.trim();
    }
    if (typeof optionValue.displayValue === "string" && optionValue.displayValue.trim()) {
      return optionValue.displayValue.trim();
    }
    if (typeof optionValue.name === "string" && optionValue.name.trim()) {
      return optionValue.name.trim();
    }
    const nestedValue = getOptionDisplayText(optionValue.value);
    if (nestedValue) {
      return nestedValue;
    }
  }

  if (typeof optionValue === "string") {
    return optionValue.trim();
  }

  return String(optionValue);
}

function humanizeApiToken(value) {
  if (typeof value !== "string") {
    return "";
  }

  let token = value.trim();
  if (!token) {
    return "";
  }

  if (token.includes(".")) {
    token = token.split(".").pop();
  }

  token = token.replace(/_/g, " ");
  token = token.replace(/^GC(\d+)$/, "$1 °C");
  token = token.replace(/^(\d+)C$/i, "$1 °C");
  token = token.replace(/^(\d+)F$/i, "$1 °F");
  token = token.replace(/^RPM(\d+)$/i, "$1 rpm");
  token = token.replace(/^(\d+)Percent$/i, "$1%");
  token = token.replace(/([a-z])([A-Z])/g, "$1 $2");
  token = token.replace(/([A-Z]+)(\d+)/g, "$1 $2");
  token = token.replace(/([a-zA-Z])(\d+)/g, "$1 $2");
  token = token.replace(/(\d+)([A-Z]+)/g, "$1 $2");
  token = token.replace(/\bIdos\b/i, "i-Dos");
  token = token.replace(/\bGc\b/i, "°C");
  token = token.replace(/\s+/g, " ").trim();

  return token;
}

function humanizeApiKey(key) {
  if (typeof key !== "string" || !key.trim()) {
    return "";
  }
  return humanizeApiToken(key.split(".").pop());
}

function getEnumToggleValue(optionValue) {
  const stringValue = getStringValue(optionValue);
  if (!stringValue) {
    return null;
  }

  const trimmed = stringValue.trim();
  if (/\.on$/i.test(trimmed)) {
    return true;
  }
  if (/\.off$/i.test(trimmed)) {
    return false;
  }

  return null;
}

function formatOptionValueLabel(option) {
  if (!option || typeof option !== "object") {
    return "";
  }

  if (typeof option.displayvalue === "string" && option.displayvalue.trim()) {
    return option.displayvalue.trim();
  }
  if (typeof option.displayValue === "string" && option.displayValue.trim()) {
    return option.displayValue.trim();
  }

  const booleanValue = getBooleanValue(option.value);
  if (booleanValue === true) {
    return option.name ? option.name.trim() : humanizeApiKey(option.key);
  }
  if (booleanValue === false) {
    return "";
  }

  const enumToggleValue = getEnumToggleValue(option.value);
  if (enumToggleValue === true) {
    return option.name ? option.name.trim() : humanizeApiKey(option.key);
  }
  if (enumToggleValue === false) {
    return "";
  }

  const numericValue = getNumericValue(option.value);
  if (numericValue !== null) {
    const unit =
      typeof option.unit === "string" && option.unit.trim() ? ` ${option.unit.trim()}` : "";
    return `${numericValue}${unit}`;
  }

  const stringValue = getStringValue(option.value);
  if (stringValue) {
    return humanizeApiToken(stringValue);
  }

  return getOptionDisplayText(option.value);
}

function shouldIncludeProgramOption(option) {
  if (!option || typeof option !== "object") {
    return false;
  }

  const booleanValue = getBooleanValue(option.value);
  if (booleanValue === true) {
    return true;
  }
  if (booleanValue === false) {
    return false;
  }

  const enumToggleValue = getEnumToggleValue(option.value);
  if (enumToggleValue === true) {
    return true;
  }
  if (enumToggleValue === false) {
    return false;
  }

  return true;
}

function getProgramOptionPriority(option) {
  const key = typeof option?.key === "string" ? option.key : "";
  if (/(?:^|\.)(?:Temperature|TempSetting|DryingTargetTemperature)$/.test(key)) {
    return 0;
  }
  if (/(?:^|\.)(?:SpinSpeed|RPM|DryingTarget)$/.test(key)) {
    return 1;
  }
  return 2;
}

function getOptionDisplayLabel(option, options = {}) {
  if (!option) {
    return "";
  }

  const preferName = options.preferName === true;
  const includeKeyLabel = options.includeKeyLabel !== false;
  const keyLabel = humanizeApiKey(option.key);
  const nameLabel = typeof option.name === "string" && option.name.trim() ? option.name.trim() : "";
  const valueLabel = formatOptionValueLabel(option);

  if (preferName && nameLabel) {
    return nameLabel;
  }

  if (valueLabel && nameLabel && valueLabel !== nameLabel) {
    return `${nameLabel}: ${valueLabel}`;
  }

  if (valueLabel && keyLabel && includeKeyLabel && valueLabel !== keyLabel && !nameLabel) {
    return `${keyLabel}: ${valueLabel}`;
  }

  return valueLabel || nameLabel || keyLabel;
}

function isProgramPhaseOptionKey(key) {
  return typeof key === "string" && /(?:^|\.)(?:ProcessPhase|ProgramPhase)$/.test(key);
}

function isRuntimeOptionKey(key) {
  if (typeof key !== "string") {
    return false;
  }

  return /(?:RemainingProgramTime|ProgramProgress|EstimatedTotalProgramTime|ElapsedProgramTime|StartInRelative|FinishInRelative|RemainingProgramTimeIsEstimated)$/.test(
    key
  );
}

function dedupeStrings(values, maxItems = Infinity) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    if (result.length < maxItems) {
      result.push(normalized);
    }
  });

  return result;
}

function getProgramOptions(programData) {
  return Array.isArray(programData?.options) ? programData.options : [];
}

function collectProgramOptionLabels(programData, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 4;
  const labels = getProgramOptions(programData)
    .map((option, index) => ({ option, index }))
    .filter(
      ({ option }) =>
        option &&
        !isProgramPhaseOptionKey(option.key) &&
        !isRuntimeOptionKey(option.key) &&
        shouldIncludeProgramOption(option)
    )
    .sort(
      (left, right) =>
        getProgramOptionPriority(left.option) - getProgramOptionPriority(right.option) ||
        left.index - right.index
    )
    .map(({ option }) => getOptionDisplayLabel(option))
    .filter(Boolean);

  return dedupeStrings(labels, maxItems);
}

function findProgramPhaseLabel(programData) {
  const phaseOption = getProgramOptions(programData).find(
    (option) => option && isProgramPhaseOptionKey(option.key)
  );
  return phaseOption ? getOptionDisplayLabel(phaseOption, { includeKeyLabel: false }) : null;
}

function summarizeConstraint(option) {
  if (!option || typeof option !== "object") {
    return "";
  }

  const keyLabel = humanizeApiKey(option.key);
  const constraints =
    option.constraints && typeof option.constraints === "object" ? option.constraints : {};
  const unit =
    typeof option.unit === "string" && option.unit.trim() ? ` ${option.unit.trim()}` : "";

  if (Number.isFinite(constraints.min) && Number.isFinite(constraints.max)) {
    return `${keyLabel}: ${constraints.min}-${constraints.max}${unit}`;
  }

  if (Array.isArray(constraints.allowedvalues) && constraints.allowedvalues.length > 0) {
    return keyLabel;
  }

  if (constraints.default !== undefined) {
    return `${keyLabel}: ${humanizeApiToken(String(constraints.default))}`;
  }

  return keyLabel;
}

function summarizeProgramConstraints(programData, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 4;
  const labels = getProgramOptions(programData)
    .filter(
      (option) => option && !isProgramPhaseOptionKey(option.key) && !isRuntimeOptionKey(option.key)
    )
    .map((option) => summarizeConstraint(option))
    .filter(Boolean);

  return dedupeStrings(labels, maxItems);
}

function extractProgramList(programPayload) {
  if (Array.isArray(programPayload)) {
    return programPayload;
  }
  if (Array.isArray(programPayload?.programs)) {
    return programPayload.programs;
  }
  if (Array.isArray(programPayload?.items)) {
    return programPayload.items;
  }
  return [];
}

function summarizeAvailablePrograms(programPayload, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 3;
  const labels = extractProgramList(programPayload)
    .map((program) => {
      if (!program || typeof program !== "object") {
        return "";
      }
      if (typeof program.name === "string" && program.name.trim()) {
        return program.name.trim();
      }
      return humanizeApiToken(program.key || "");
    })
    .filter(Boolean);

  return dedupeStrings(labels, maxItems);
}

function normalizeDeviceType(type) {
  return typeof type === "string" ? type.replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
}

function getDeviceTypeMeta(type) {
  const normalizedType = normalizeDeviceType(type);
  const aliases = {
    airconditioner: {
      canonicalType: "AirConditioner",
      iconName: null,
      fallbackIconClass: "fa-thermometer-half"
    },
    cleaningrobot: {
      canonicalType: "CleaningRobot",
      iconName: "Cleaningrobot.png",
      fallbackIconClass: "fa-cog"
    },
    coffeemachine: {
      canonicalType: "CoffeeMaker",
      iconName: "CoffeeMaker.png",
      fallbackIconClass: "fa-coffee"
    },
    coffeemaker: {
      canonicalType: "CoffeeMaker",
      iconName: "CoffeeMaker.png",
      fallbackIconClass: "fa-coffee"
    },
    cookprocessor: {
      canonicalType: "CookProcessor",
      iconName: "Cookprocessor.png",
      fallbackIconClass: "fa-cutlery"
    },
    cooktop: { canonicalType: "Cooktop", iconName: "Hob.png", fallbackIconClass: "fa-fire" },
    hob: { canonicalType: "Cooktop", iconName: "Hob.png", fallbackIconClass: "fa-fire" },
    dishwasher: {
      canonicalType: "Dishwasher",
      iconName: "Dishwasher.png",
      fallbackIconClass: "fa-tint"
    },
    dryer: { canonicalType: "Dryer", iconName: "Dryer.png", fallbackIconClass: "fa-refresh" },
    freezer: {
      canonicalType: "Freezer",
      iconName: "Freezer.png",
      fallbackIconClass: "fa-snowflake-o"
    },
    fridgefreezer: {
      canonicalType: "FridgeFreezer",
      iconName: "FridgeFreezer.png",
      fallbackIconClass: "fa-snowflake-o"
    },
    hood: { canonicalType: "Hood", iconName: "Hood.png", fallbackIconClass: "fa-sliders" },
    microwave: { canonicalType: "Microwave", iconName: null, fallbackIconClass: "fa-bullseye" },
    oven: { canonicalType: "Oven", iconName: "Oven.png", fallbackIconClass: "fa-fire" },
    refrigerator: {
      canonicalType: "Refrigerator",
      iconName: "Refrigerator.png",
      fallbackIconClass: "fa-snowflake-o"
    },
    washer: { canonicalType: "Washer", iconName: "Washer.png", fallbackIconClass: "fa-tint" },
    washerdryer: {
      canonicalType: "WasherDryer",
      iconName: "WasherDryer.png",
      fallbackIconClass: "fa-refresh"
    },
    warmingdrawer: {
      canonicalType: "WarmingDrawer",
      iconName: null,
      fallbackIconClass: "fa-square-o"
    },
    winecooler: {
      canonicalType: "WineCooler",
      iconName: "Winecooler.png",
      fallbackIconClass: "fa-glass"
    }
  };

  return (
    aliases[normalizedType] || {
      canonicalType: type || "Unknown",
      iconName: null,
      fallbackIconClass: "fa-plug"
    }
  );
}

function getObjectSummaryValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return dedupeStrings(Object.values(value), Infinity);
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

function parseStartInRelativeSeconds(device) {
  if (!device) {
    return null;
  }

  const startCandidates = [
    device.StartInRelative,
    device.startInRelative,
    device.start_in_relative,
    device["BSH.Common.Status.StartInRelative"],
    device["BSH.Common.Option.StartInRelative"]
  ];

  for (const candidate of startCandidates) {
    const parsed = parseDurationSeconds(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseFinishInRelativeSeconds(device) {
  if (!device) {
    return null;
  }

  const finishCandidates = [
    device.FinishInRelative,
    device.finishInRelative,
    device.finish_in_relative,
    device["BSH.Common.Status.FinishInRelative"],
    device["BSH.Common.Option.FinishInRelative"]
  ];

  for (const candidate of finishCandidates) {
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

  if (device.DoorOpen || device.DoorState === "Open" || device.doorState === "Open") {
    return true;
  }

  if (getObjectSummaryValues(device.RefrigerationDoorStates).some((value) => /open/i.test(value))) {
    return true;
  }

  return Object.entries(device).some(
    ([key, value]) => /Door(State)?$/i.test(key) && getStringValue(value) === "Open"
  );
}

function shouldSuppressSelectedProgramDisplay(device) {
  if (!device || device.ActiveProgramSource !== "selected") {
    return false;
  }

  const startInRelativeSeconds = parseStartInRelativeSeconds(device);
  return !(typeof startInRelativeSeconds === "number" && startInRelativeSeconds > 0);
}

function hasInformativeState(device) {
  if (!device) {
    return false;
  }

  const suppressSelectedProgramDisplay = shouldSuppressSelectedProgramDisplay(device);

  if (!suppressSelectedProgramDisplay) {
    const remainingSeconds = parseRemainingSeconds(device);
    if (typeof remainingSeconds === "number" && remainingSeconds >= 0) {
      return true;
    }

    const startInRelativeSeconds = parseStartInRelativeSeconds(device);
    if (typeof startInRelativeSeconds === "number" && startInRelativeSeconds > 0) {
      return true;
    }

    const progressValue = parseProgress(device);
    if (progressValue !== undefined && progressValue !== null) {
      return true;
    }
  }

  return Boolean(
    (!suppressSelectedProgramDisplay && device.ActiveProgramName) ||
    (!suppressSelectedProgramDisplay && device.ActiveProgramPhase) ||
    (!suppressSelectedProgramDisplay &&
      Array.isArray(device.ActiveProgramDetails) &&
      device.ActiveProgramDetails.length) ||
    (Array.isArray(device.AvailablePrograms) && device.AvailablePrograms.length) ||
    (Array.isArray(device.AvailableOptionDetails) && device.AvailableOptionDetails.length) ||
    getObjectSummaryValues(device.DeviceStatusByKey).length ||
    getObjectSummaryValues(device.DeviceAlertsByKey).length ||
    getObjectSummaryValues(device.RefrigerationDoorStates).length ||
    (!suppressSelectedProgramDisplay && device.OperationState) ||
    (!suppressSelectedProgramDisplay && device.operationState) ||
    (!suppressSelectedProgramDisplay && device.RemainingProgramTime) ||
    (!suppressSelectedProgramDisplay && parseEstimatedTotalSeconds(device) !== null)
  );
}

function shouldDisplayDevice(device, config = {}) {
  if (!device) {
    return false;
  }

  if (config.showAlwaysAllDevices) {
    return true;
  }
  if (isDeviceExplicitlyDisconnected(device)) {
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
  if (device.PowerState === "On" && !shouldSuppressSelectedProgramDisplay(device)) {
    return true;
  }
  if (config.showDeviceIfInfoIsAvailable && hasInformativeState(device)) {
    return true;
  }

  return false;
}

function deviceAppearsActive(device) {
  if (!device) return false;
  if (shouldSuppressSelectedProgramDisplay(device)) {
    return false;
  }
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

function isDeviceExplicitlyDisconnected(device) {
  if (!device || !Object.prototype.hasOwnProperty.call(device, "connected")) {
    return false;
  }

  return !isDeviceConnected(device);
}

const exportsObj = {
  collectProgramOptionLabels,
  extractProgramList,
  findProgramPhaseLabel,
  getBooleanValue,
  getDeviceTypeMeta,
  getEnumToggleValue,
  getNumericValue,
  getOptionDisplayLabel,
  getProgramOptionPriority,
  getStringValue,
  humanizeApiKey,
  humanizeApiToken,
  parseDurationSeconds,
  parseStartInRelativeSeconds,
  parseFinishInRelativeSeconds,
  summarizeAvailablePrograms,
  summarizeProgramConstraints,
  parseRemainingSeconds,
  parseProgress,
  parseEstimatedTotalSeconds,
  isEstimatedDuration,
  isDoorOpen,
  hasInformativeState,
  shouldIncludeProgramOption,
  shouldDisplayDevice,
  deviceAppearsActive,
  isDeviceConnected,
  isDeviceExplicitlyDisconnected
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
    window.HomeConnectDeviceUtils.parseStartInRelativeSeconds =
      exportsObj.parseStartInRelativeSeconds;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.parseFinishInRelativeSeconds =
      exportsObj.parseFinishInRelativeSeconds;
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
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.isDeviceExplicitlyDisconnected =
      exportsObj.isDeviceExplicitlyDisconnected;
    // eslint-disable-next-line no-undef
    window.HomeConnectDeviceUtils.getDeviceTypeMeta = exportsObj.getDeviceTypeMeta;
  })();
}
