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
      logger: () => { },
      broadcastToAllClients: () => { },
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

  // handleGetDevicesSuccess: broadcasts the base device list immediately before slow enrichment settles
  {
    const { service, notifications } = createDeviceService();
    const sendSocketNotificationCalls = [];
    service.attachClient({
      subscribe: () => { },
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => { }
    });
    service.setConfig({ enableSSEHeartbeat: false });
    service.fetchDeviceStatus = () => wait(40);
    service.fetchDeviceSettings = () => wait(40);

    service.handleGetDevicesSuccess(
      {
        data: {
          homeappliances: [{ haId: "ha-1", name: "Washer", connected: true }]
        }
      },
      (n, payload) => {
        sendSocketNotificationCalls.push({ n, payload });
      }
    );

    assert.ok(
      sendSocketNotificationCalls.some((entry) => entry.n === "MMM-HomeConnect_Update"),
      "Expected an immediate device broadcast"
    );
    assert.strictEqual(
      notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "complete"),
      false,
      "Expected device enrichment to still be pending immediately after the first broadcast"
    );

    await wait(70);

    assert.ok(
      notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "complete"),
      "Expected completion status after slow enrichment settles"
    );
  }

  // noteTokenRefreshed: prevents immediate redundant token refresh before first SSE subscribe
  {
    const { service } = createDeviceService();
    let refreshCalls = 0;
    service.attachClient({
      refreshTokens: async () => {
        refreshCalls += 1;
      }
    });
    service.noteTokenRefreshed(Date.now());

    await service.ensureFreshTokenForSSE();

    assert.strictEqual(refreshCalls, 0);
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
      closeEventSources: () => { }
    };
    sseService.attachClient(hcMock);
    sseService.setConfig({ enableSSEHeartbeat: false });

    const handler = () => { };

    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["KEEP-ALIVE", "NOTIFY", "STATUS", "EVENT"]),
      "Expected a single immediate subscription for KEEP-ALIVE/NOTIFY/STATUS/EVENT"
    );

    // Calling subscribeToDeviceEvents again with the same handler should not
    // create additional subscriptions.
    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["KEEP-ALIVE", "NOTIFY", "STATUS", "EVENT"]),
      "Expected no additional subscriptions when reusing same handler"
    );
  }

  // SSE keep-alive: logs debug traffic and refreshes heartbeat state
  {
    const { service, logs, notifications } = createDeviceService();
    service.heartbeatStale = true;

    service.handleKeepAliveEvent({ data: "ping" });

    assert.strictEqual(service.heartbeatArmed, true);
    assert.ok(Number.isFinite(service.lastKeepAliveTimestamp));
    assert.ok(
      logs.some((entry) => entry.level === "debug" && entry.message.includes("SSE KEEP-ALIVE received"))
    );
    assert.ok(!logs.some((entry) => entry.message.includes("undefined")));
    assert.ok(
      notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_recovered")
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

  // SSE heartbeat: a silent stream before the first event must not trigger recovery
  {
    let staleRecoveries = 0;
    const { service, notifications } = createDeviceService({
      onSseStale: () => {
        staleRecoveries += 1;
      }
    });
    const subscribeCalls = [];
    const hcMock = {
      subscribe: (type) => subscribeCalls.push(type),
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => { }
    };

    service.attachClient(hcMock);
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    service.setConfig({
      enableSSEHeartbeat: true,
      sseHeartbeatCheckIntervalMs: 10,
      sseHeartbeatStaleThresholdMs: 20,
      sseRecoveryCooldownMs: 1000
    });

    service.subscribeToDeviceEvents(() => { });
    await wait(80);

    const staleEvent = notifications.find(
      (entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_stale"
    );
    assert.strictEqual(staleEvent, undefined);
    assert.strictEqual(staleRecoveries, 0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["KEEP-ALIVE", "NOTIFY", "STATUS", "EVENT"])
    );

    service.shutdown();
  }

  // SSE heartbeat: after at least one event, prolonged silence still triggers recovery once
  {
    let staleRecoveries = 0;
    const { service, notifications } = createDeviceService({
      onSseStale: () => {
        staleRecoveries += 1;
      }
    });
    const hcMock = {
      subscribe: () => { },
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => { },
      applyEventToDevice: (device, item) => {
        device[item.key] = item.value;
      }
    };

    service.attachClient(hcMock);
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    service.setConfig({
      enableSSEHeartbeat: true,
      sseHeartbeatCheckIntervalMs: 10,
      sseHeartbeatStaleThresholdMs: 20,
      sseRecoveryCooldownMs: 1000
    });

    const socketNotifications = [];
    service.subscribeToDeviceEvents((payload) => service.deviceEvent(payload, (n, data) => {
      socketNotifications.push({ n, data });
    }));
    await wait(0);

    service.deviceEvent(
      {
        data: JSON.stringify({
          items: [
            {
              key: "BSH.Common.Option.ProgramProgress",
              value: 42,
              uri: "/api/homeappliances/ha-1/events"
            }
          ]
        })
      },
      (n, data) => {
        socketNotifications.push({ n, data });
      }
    );

    await wait(80);

    const staleEvent = notifications.find(
      (entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_stale"
    );
    assert.ok(staleEvent);
    assert.strictEqual(staleRecoveries, 1);
    assert.ok(
      socketNotifications.some((entry) => entry.n === "MMM-HomeConnect_Update"),
      "Expected the incoming SSE event to update the frontend cache"
    );

    service.shutdown();
  }

  console.log("device-service.test.js OK");
})();
