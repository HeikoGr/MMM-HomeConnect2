"use strict";

/*
 * What an API payload or SSE event changes on a device object. Pure functions,
 * no I/O: the API client (lib/homeconnect-api.js), the device snapshot and the
 * program fetches all apply events through applyEventToDevice().
 */

const {
  clearDeviceFields,
  extractValueByType,
  getOptionDisplayLabel,
  humanizeApiKey,
  parseDurationSeconds,
  parseProgressValue,
  OBSERVED_RUNTIME_KEYS,
} = require("./device-utils");

// Event keys end up as property names on device objects. Nothing Home Connect
// sends today is a problem; this keeps it so.
const UNSAFE_PROPERTY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const DELAYED_START_STATE = "BSH.Common.EnumType.OperationState.DelayedStart";
const RUN_STATE = "BSH.Common.EnumType.OperationState.Run";
const FINISHED_STATE = "BSH.Common.EnumType.OperationState.Finished";

// First sighting of a positive remaining time: the start of the run as far as this
// process knows (_remainingObservedAt), and the duration it announced then. With a
// delayed start the program has not begun - the remaining time does not count down
// yet, and its first sighting is not the program start (see trackDelayedStart).
function noteRemainingSeen(device, remainingSeconds, now) {
  if (device.OperationState === DELAYED_START_STATE) {
    return;
  }
  if (!device._initialRemaining) {
    device._initialRemaining = remainingSeconds;
  }
  if (!device._remainingObservedAt) {
    device._remainingObservedAt = now;
  }
  device._lastRemainingSeenAt = now;
}

// The program start is when a delayed start ends, not when its remaining time was
// first reported: waiting for the start and the run itself are kept apart (progress
// bar, run_state.json, program statistics).
function trackDelayedStart(device, previousState, now) {
  if (device.OperationState === DELAYED_START_STATE) {
    clearDeviceFields(device, ...OBSERVED_RUNTIME_KEYS);
    return;
  }
  if (previousState !== DELAYED_START_STATE || device.OperationState !== RUN_STATE) {
    return;
  }
  clearDeviceFields(device, ...OBSERVED_RUNTIME_KEYS);
  const remainingSeconds = parseDurationSeconds(device.RemainingProgramTime);
  if (Number.isFinite(remainingSeconds) && remainingSeconds > 0) {
    noteRemainingSeen(device, remainingSeconds, now);
  }
}

function ensureSummaryBucket(device, bucketKey) {
  if (!device[bucketKey] || typeof device[bucketKey] !== "object" || Array.isArray(device[bucketKey])) {
    device[bucketKey] = {};
  }
  return device[bucketKey];
}

function setSummaryEntry(device, bucketKey, entryKey, label) {
  const bucket = ensureSummaryBucket(device, bucketKey);
  if (typeof label !== "string" || !label.trim()) {
    delete bucket[entryKey];
    if (Object.keys(bucket).length === 0) {
      delete device[bucketKey];
    }
    return;
  }
  bucket[entryKey] = label.trim();
}

function setAlertEntry(device, key, value, label) {
  if (shouldRetainAlert(value)) {
    setSummaryEntry(device, "DeviceAlertsByKey", key, label);
    return;
  }
  setSummaryEntry(device, "DeviceAlertsByKey", key, "");
}

function shouldRetainAlert(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const token = value.split(".").pop().trim().toLowerCase();
    if (!token) {
      return false;
    }
    if (["false", "off", "inactive", "closed", "none", "normal", "ok"].includes(token)) {
      return false;
    }
    return true;
  }

  if (typeof value === "object") {
    return shouldRetainAlert(value.value !== undefined ? value.value : value.displayValue);
  }

  return true;
}

function getEventLabel(event, options = {}) {
  if (!event || typeof event !== "object") {
    return "";
  }
  return getOptionDisplayLabel(event, options) || humanizeApiKey(event.key);
}

// Keys the switch in applyEventToDevice() converts into a friendly field. Storing
// the raw key as well would leave two spellings of the same observable on the
// device: every reader would have to know both, and clearing only one lets the
// other resurface through the parsers (a finished cycle would keep a full
// progress bar alive). Everything not listed here has no friendly field and
// is therefore still stored under its raw key.
const NORMALIZED_EVENT_KEYS = new Set([
  "BSH.Common.Option.RemainingProgramTime",
  "BSH.Common.Status.RemainingProgramTime",
  "BSH.Common.Option.ProgramProgress",
  "BSH.Common.Status.ProgramProgress",
  "BSH.Common.Option.EstimatedTotalProgramTime",
  "BSH.Common.Status.EstimatedTotalProgramTime",
  "BSH.Common.Option.FinishInRelative",
  "BSH.Common.Status.FinishInRelative",
  "BSH.Common.Option.RemainingProgramTimeIsEstimated",
  "BSH.Common.Status.RemainingProgramTimeIsEstimated",
  "BSH.Common.Status.OperationState",
  "Cooking.Common.Setting.Lighting",
  "BSH.Common.Setting.PowerState",
  "BSH.Common.Status.DoorState",
]);

// "active" is a claim that a program is running right now. The appliance backs
// that claim with BSH.Common.Root.ActiveProgram and an operation state that has a
// program in it; once either says otherwise, what is left is the program sitting
// on the dial - still worth knowing, but merely selected. The name and its options
// therefore stay, the claim and the run-specific phase do not.
//
// Without this an appliance that finished while the helper was running keeps
// announcing an active program for the lifetime of the process, while a helper
// started afterwards correctly shows it as selected.
function demoteActiveProgramClaim(device) {
  if (device.ActiveProgramSource === "active") {
    device.ActiveProgramSource = "selected";
  }
  delete device.ActiveProgramPhase;
}

// "BSH.Common.EnumType.PowerState.Standby" -> "Standby"; the same for door states.
function getEnumLabel(value) {
  const stringValue = extractValueByType(value, "string");
  return stringValue ? stringValue.split(".").pop() : "";
}

function deriveTrailingLabel(key, marker) {
  if (typeof key !== "string" || !key.includes(marker)) {
    return humanizeApiKey(key);
  }
  return humanizeApiKey(key.slice(key.indexOf(marker) + marker.length));
}

function applyRefrigerationState(device, event) {
  const { key, value } = event;
  if (!/Refrigeration\./.test(key)) {
    return;
  }

  if (/Door/i.test(key)) {
    const compartment = deriveTrailingLabel(key, ".Door.");
    const doorState = getEnumLabel(value) || getEventLabel(event, { includeKeyLabel: false });
    if (doorState) {
      setSummaryEntry(device, "RefrigerationDoorStates", compartment, `${compartment}: ${doorState}`);
      setSummaryEntry(device, "DeviceStatusByKey", `refrigeration-door-${compartment}`, `${compartment}: ${doorState}`);
      if (/open/i.test(doorState)) {
        device.DoorOpen = true;
        device.DoorState = "Open";
      }
    }
  }

  if (/Alarm/i.test(key)) {
    const alarmLabel = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, alarmLabel);
  }
}

function applyCoffeeState(device, event) {
  const { key, value } = event;
  if (!/CoffeeMaker\./.test(key)) {
    return;
  }

  if (/\.Option\./.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/\.Event\./.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applyHoodState(device, event) {
  const { key, value } = event;
  if (!/Hood\./.test(key) && !/Cooking\.Common\.Program\.Hood\./.test(key)) {
    return;
  }

  if (/VentingLevel|IntensiveLevel/.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/Filter|Saturation|CleaningRequired/i.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applyOvenState(device, event) {
  const { key, value } = event;
  if (!/^Cooking\.Oven\./.test(key) && !/^Cooking\.Common\./.test(key)) {
    return;
  }

  if (/SetpointTemperature|FastPreHeat|WarmingLevel/.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/PreheatFinished/.test(key)) {
    setAlertEntry(device, key, value, humanizeApiKey(key));
  }
}

function applyRobotState(device, event) {
  const { key, value } = event;
  if (!/CleaningRobot\./.test(key)) {
    return;
  }

  if (
    /CleaningMode|SuctionPower|ReferenceMapId|ProcessPhase|BatteryLevel|BatteryChargingState|ChargingConnection|LastSelectedMap/.test(
      key,
    )
  ) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/DustBoxInserted/.test(key)) {
    if (shouldRetainAlert(value) === false) {
      setSummaryEntry(device, "DeviceAlertsByKey", key, "Dust box missing");
    } else {
      setSummaryEntry(device, "DeviceAlertsByKey", key, "");
    }
    return;
  }

  if (/RobotIsStuck|DockingStationNotFound|EmptyDustBoxAndCleanFilter|Lost|Lifted/i.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applySpecializedEventState(device, event) {
  applyRefrigerationState(device, event);
  applyCoffeeState(device, event);
  applyHoodState(device, event);
  applyOvenState(device, event);
  applyRobotState(device, event);
}

function applyEventToDevice(device, event) {
  if (!device || !event?.key || UNSAFE_PROPERTY_KEYS.has(event.key)) return;
  const key = event.key;
  const value = event.value;
  const now = Date.now();

  // Any successfully applied API payload or SSE event proves the appliance is
  // currently reachable via Home Connect, even if the last /homeappliances
  // snapshot still carries a stale connected=false flag.
  device.connected = true;
  if (!NORMALIZED_EVENT_KEYS.has(key)) {
    device[key] = value;
  }

  switch (key) {
    case "BSH.Common.Option.RemainingProgramTime":
    case "BSH.Common.Status.RemainingProgramTime": {
      device.RemainingProgramTime = value;
      const remainingSeconds = parseDurationSeconds(value);
      if (remainingSeconds > 0) {
        // A new run: whatever the last one left behind (Finished, 100 %) is stale now.
        if (device.OperationState === FINISHED_STATE) {
          delete device.OperationState;
        }
        if (Number(device.ProgramProgress) >= 100) {
          delete device.ProgramProgress;
        }
        noteRemainingSeen(device, remainingSeconds, now);
      } else if (remainingSeconds === 0) {
        clearDeviceFields(device, ...OBSERVED_RUNTIME_KEYS);
      }
      break;
    }
    case "BSH.Common.Option.ProgramProgress":
    case "BSH.Common.Status.ProgramProgress": {
      const progress = parseProgressValue(value);
      device.ProgramProgress = progress !== null ? progress : value;
      // A finished run: the estimate derived from its remaining time no longer applies.
      if (Number.isFinite(progress) && Math.round(progress) >= 100) {
        clearDeviceFields(device, ...OBSERVED_RUNTIME_KEYS);
      }
      break;
    }
    case "BSH.Common.Option.EstimatedTotalProgramTime":
    case "BSH.Common.Status.EstimatedTotalProgramTime": {
      const totalSeconds = parseDurationSeconds(value);
      device.EstimatedTotalProgramTime = totalSeconds !== null ? totalSeconds : value;
      break;
    }
    case "BSH.Common.Option.FinishInRelative":
    case "BSH.Common.Status.FinishInRelative":
      device.FinishInRelative = value;
      break;
    case "BSH.Common.Option.RemainingProgramTimeIsEstimated":
    case "BSH.Common.Status.RemainingProgramTimeIsEstimated":
      device.RemainingProgramTimeIsEstimated = value;
      break;
    case "BSH.Common.Status.OperationState": {
      const stateValue =
        typeof value === "string" ? value : value && typeof value.value === "string" ? value.value : value;
      const previousState = device.OperationState;
      device.OperationState = stateValue;
      trackDelayedStart(device, previousState, now);
      const stateLabel = typeof stateValue === "string" ? stateValue.split(".").pop() : "";
      // "Inactive"/"Ready" mean no program is running any more - typically
      // reported when the door is opened after a finished cycle. The appliance
      // stops updating its runtime values at that point, so leftovers (a reset
      // progress of 0, a remaining time stuck at 0) would survive for the
      // lifetime of the process and paint a stale bar on long-running
      // instances, while a freshly started one shows nothing. A remaining time
      // of 0 is the worse of the two: combined with the planned duration it
      // computes to a permanent 100 %.
      //
      // The planned duration and the program identity are deliberately kept -
      // an idle appliance legitimately reports the program sitting on its dial.
      if (stateLabel === "Inactive" || stateLabel === "Ready") {
        clearDeviceFields(device, "ProgramProgress", "RemainingProgramTime", ...OBSERVED_RUNTIME_KEYS);
        demoteActiveProgramClaim(device);
      }
      if (stateValue === FINISHED_STATE) {
        // finished -> drop the whole runtime block and the program, then restate remaining as zero.
        clearDeviceFields(
          device,
          ...OBSERVED_RUNTIME_KEYS,
          "EstimatedTotalProgramTime",
          "RemainingProgramTimeIsEstimated",
          "ActiveProgramKey",
          "ActiveProgramName",
          "ActiveProgramSource",
          "ActiveProgramPhase",
          "ActiveProgramDetails",
        );
        device.RemainingProgramTime = 0;
      }
      break;
    }
    case "BSH.Common.Root.ActiveProgram": {
      // Home Connect clears this to null the moment a program ends. It is the
      // appliance stating outright that nothing is running, which outranks any
      // program data left over from the run that just ended.
      if (!extractValueByType(value, "string")) {
        demoteActiveProgramClaim(device);
      }
      break;
    }
    case "Cooking.Common.Setting.Lighting":
      device.Lighting = value;
      break;
    case "BSH.Common.Setting.PowerState":
      {
        // A value this does not understand must not wipe a known power state:
        // the appliance is telling us something, just not something we map.
        const powerStateLabel = getEnumLabel(value);
        if (powerStateLabel) {
          device.PowerState = powerStateLabel;
        }
      }
      break;
    case "BSH.Common.Status.DoorState":
      {
        device.DoorState = getEnumLabel(value);
      }
      break;
    default:
      break;
  }

  applySpecializedEventState(device, event);
}

module.exports = { applyEventToDevice };
