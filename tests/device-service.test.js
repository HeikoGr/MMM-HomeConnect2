"use strict";

const assert = require("assert");
const DeviceService = require("../lib/device-service");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeviceService(overrides = {}) {
  const globalSession = { clientInstances: new Set(["test"]) };
  const logs = [];
  const logger = (level, ...args) => logs.push({ level, message: args.join(" ") });
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

  // SSE global subscription establishes immediately and is idempotent
  {
    const { service: sseService } = createDeviceService();
    const subscribeCalls = [];
    const hcMock = {
      subscribe: (type) => subscribeCalls.push(type),
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => { }
    };
    sseService.attachClient(hcMock);
    sseService.setConfig({ enableSSEHeartbeat: false });

    const handler = () => { };

    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["NOTIFY", "STATUS", "EVENT"]),
      "Expected a single immediate subscription for NOTIFY/STATUS/EVENT"
    );

    // Calling subscribeToDeviceEvents again with the same handler should not
    // create additional subscriptions.
    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["NOTIFY", "STATUS", "EVENT"]),
      "Expected no additional subscriptions when reusing same handler"
    );
  }

  // Attaching a new HomeConnect client closes previous event sources
  {
    const { service } = createDeviceService();
    const closeCalls = [];
    const oldClient = {
      setEventSourceRetryConfig: () => { },
      closeEventSources: (opts) => closeCalls.push(opts)
    };
    const newClient = {
      setEventSourceRetryConfig: () => { },
      closeEventSources: () => { }
    };

    service.attachClient(oldClient);
    service.attachClient(newClient);

    assert.strictEqual(
      closeCalls.length,
      1,
      "Previous client should be closed when new client attached"
    );
    assert.deepStrictEqual(closeCalls[0], { devices: true, global: true });
  }

  console.log("device-service.test.js OK");
})();
