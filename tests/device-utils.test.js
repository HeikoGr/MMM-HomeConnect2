"use strict";

const assert = require("assert");
const {
  getNumericValue,
  parseDurationSeconds,
  parseRemainingSeconds,
  parseEstimatedTotalSeconds,
  isEstimatedDuration,
  isDoorOpen,
  hasInformativeState,
  shouldDisplayDevice,
  deviceAppearsActive
} = require("../lib/device-utils");

(() => {
  assert.strictEqual(getNumericValue({ value: "42" }), 42);
  assert.strictEqual(getNumericValue({ displayValue: "17.5" }), 17.5);

  assert.strictEqual(parseDurationSeconds(95), 95);
  assert.strictEqual(parseDurationSeconds("120"), 120);
  assert.strictEqual(parseDurationSeconds("PT1H2M3S"), 3723);
  assert.strictEqual(parseDurationSeconds({ value: "PT45M" }), 2700);
  assert.strictEqual(parseDurationSeconds({ displayValue: "PT30S" }), 30);
  assert.strictEqual(parseRemainingSeconds({ RemainingProgramTime: { value: "PT20M" } }), 1200);
  assert.strictEqual(
    parseEstimatedTotalSeconds({
      "BSH.Common.Option.EstimatedTotalProgramTime": { value: "PT1H" }
    }),
    3600
  );
  assert.strictEqual(
    isEstimatedDuration({ RemainingProgramTimeIsEstimated: { value: true } }),
    true
  );
  assert.strictEqual(isDoorOpen({ DoorState: "Open" }), true);
  assert.strictEqual(
    hasInformativeState({
      ActiveProgramName: "Eco 40-60"
    }),
    true
  );
  assert.strictEqual(
    shouldDisplayDevice(
      {
        ActiveProgramName: "Eco 40-60"
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: true
      }
    ),
    true
  );
  assert.strictEqual(
    shouldDisplayDevice(
      {
        PowerState: "Off"
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: false
      }
    ),
    false
  );

  assert.strictEqual(
    deviceAppearsActive({ RemainingProgramTime: { value: "PT20M" } }),
    true,
    "Duration objects should mark device as active"
  );

  console.log("device-utils.test.js OK");
})();
