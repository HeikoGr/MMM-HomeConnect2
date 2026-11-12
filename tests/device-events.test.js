"use strict";

const assert = require("node:assert");
const { applyEventToDevice } = require("../lib/device-events");

// The event handling needs no API client: services and the client share one pure function.
(() => {
  const device = { connected: false };
  applyEventToDevice(device, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Run",
  });
  applyEventToDevice(device, { key: "BSH.Common.Option.RemainingProgramTime", value: 600 });
  assert.strictEqual(device.connected, true);
  assert.strictEqual(device.OperationState, "BSH.Common.EnumType.OperationState.Run");
  assert.strictEqual(device.RemainingProgramTime, 600);
  assert.strictEqual(device._initialRemaining, 600);
  assert.strictEqual(device["BSH.Common.Option.RemainingProgramTime"], undefined, "normalized keys are stored once");
})();

(() => {
  const device = {};
  applyEventToDevice(device, { key: "__proto__", value: { polluted: true } });
  assert.strictEqual(Object.getPrototypeOf(device), Object.prototype);
  assert.strictEqual(device.connected, undefined, "a rejected key changes nothing");
})();

(() => {
  const device = {};
  applyEventToDevice(device, { key: "ConsumerProducts.CleaningRobot.Status.DustBoxInserted", value: false });
  assert.deepStrictEqual(device.DeviceAlertsByKey, {
    "ConsumerProducts.CleaningRobot.Status.DustBoxInserted": "Dust box missing",
  });
})();

console.log("device-events tests passed");
