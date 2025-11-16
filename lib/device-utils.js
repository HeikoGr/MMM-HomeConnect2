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
  if (
    typeof progressValue === "number" &&
    progressValue > 0 &&
    progressValue < 100
  ) {
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
    if (
      s === "true" ||
      s === "connected" ||
      s === "online" ||
      s === "available"
    )
      return true;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  return !!v;
}

module.exports = {
  getNumericValue,
  getStringValue,
  deviceAppearsActive,
  isDeviceConnected
};
