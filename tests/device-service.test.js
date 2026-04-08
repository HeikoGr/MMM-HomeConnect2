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

  // broadcastDevices: emits only one socket notification even with multiple clients
  {
    const globalSession = { clientInstances: new Set(["frontend-a", "frontend-b", "frontend-c"]) };
    const notifications = [];
    const service = new DeviceService({
      logger: () => {},
      broadcastToAllClients: () => {},
      globalSession
    });
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });

    service.broadcastDevices((n, payload) => {
      notifications.push({ n, payload });
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].n, "MMM-HomeConnect_Update");
    assert.deepStrictEqual(notifications[0].payload, [{ haId: "ha-1", name: "Washer" }]);
  }

  // processDevice: API payload values overwrite stale local values for same appliance
  {
    const { service } = createDeviceService();
    service.devices.set("ha-dryer", {
      haId: "ha-dryer",
      name: "Dryer",
      PowerState: "On",
      connected: true,
      ProgramProgress: 55,
      RemainingProgramTime: 1800
    });

    await service.processDevice(
      {
        haId: "ha-dryer",
        name: "Dryer",
        PowerState: "Off",
        connected: false
      },
      0
    );

    const updated = service.devices.get("ha-dryer");
    assert.ok(updated);
    assert.strictEqual(updated.PowerState, "Off");
    assert.strictEqual(updated.connected, false);
  }

  // handleGetDevicesError: broadcasts device_error
  {
    const { service, notifications } = createDeviceService();
    service.handleGetDevicesError(new Error("boom"));
    const errEvent = notifications.find((e) => e.n === "INIT_STATUS");
    assert.ok(errEvent);
    assert.strictEqual(errEvent.p.status, "device_error");
  }

  // handleGetDevicesError: marks HTTP 429 for the frontend
  {
    const { service, notifications } = createDeviceService();
    service.handleGetDevicesError(
      Object.assign(new Error("Too many requests"), { statusCode: 429 })
    );
    const errEvent = notifications.find((e) => e.n === "INIT_STATUS");
    assert.ok(errEvent);
    assert.strictEqual(errEvent.p.statusCode, 429);
    assert.strictEqual(errEvent.p.isRateLimit, true);
    assert.ok(errEvent.p.message.includes("HTTP 429"));
  }

  // SSE global subscription establishes immediately and is idempotent
  {
    const { service: sseService } = createDeviceService();
    const subscribeCalls = [];
    const hcMock = {
      subscribe: (type) => subscribeCalls.push(type),
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {}
    };
    sseService.attachClient(hcMock);
    sseService.setConfig({ enableSSEHeartbeat: false });

    const handler = () => {};

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
      setEventSourceRetryConfig: () => {},
      closeEventSources: (opts) => closeCalls.push(opts)
    };
    const newClient = {
      setEventSourceRetryConfig: () => {},
      closeEventSources: () => {}
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
