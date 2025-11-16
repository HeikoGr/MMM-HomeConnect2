"use strict";

const assert = require("assert");
const DeviceService = require("../lib/device-service");

function createDeviceService(overrides = {}) {
  const globalSession = { clientInstances: new Set(["test"]) };
  const logs = [];
  const logger = (level, ...args) =>
    logs.push({ level, message: args.join(" ") });
  const notifications = [];
  const broadcastToAllClients = (n, p) => notifications.push({ n, p });
  const service = new DeviceService({
    logger,
    broadcastToAllClients,
    globalSession,
    ...overrides
  });
  return { service, logs, notifications };
}

(async () => {
  // broadcastDevices: sends current devices to all instances
  {
    const { service, notifications } = createDeviceService();
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    const sendSocketNotification = (n, payload) => {
      notifications.push({ n, payload });
    };
    service.broadcastDevices(sendSocketNotification);
    assert.ok(notifications.some((e) => e.n === "MMM-HomeConnect_Update"));
  }

  // handleGetDevicesError: broadcasts device_error
  {
    const { service, notifications } = createDeviceService();
    service.handleGetDevicesError(new Error("boom"));
    const errEvent = notifications.find((e) => e.n === "INIT_STATUS");
    assert.ok(errEvent);
    assert.strictEqual(errEvent.p.status, "device_error");
  }

  console.log("device-service.test.js OK");
})();
