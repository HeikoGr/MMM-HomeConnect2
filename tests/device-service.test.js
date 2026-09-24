"use strict";

const assert = require("node:assert");
const DeviceService = require("../lib/device-service");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeviceService(overrides = {}) {
  const globalSession = { clientInstances: new Set(["test"]) };
  const logs = [];
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args) => logs.push({ level, message: args.join(" ") }),
    ]),
  );
  const notifications = [];
  const broadcastToAllClients = (n, p) => notifications.push({ n, p });
  const service = new DeviceService({
    logger,
    broadcastToAllClients,
    globalSession,
    ...overrides,
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
    assert.ok(notifications.some((e) => e.n === "DEVICES_UPDATE"));
  }

  // broadcastDevices: emits only one socket notification even with multiple clients
  {
    const globalSession = { clientInstances: new Set(["frontend-a", "frontend-b", "frontend-c"]) };
    const notifications = [];
    const service = new DeviceService({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      broadcastToAllClients: () => {},
      globalSession,
    });
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });

    service.broadcastDevices((n, payload) => {
      notifications.push({ n, payload });
    });

    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].n, "DEVICES_UPDATE");
    assert.deepStrictEqual(notifications[0].payload, [{ haId: "ha-1", name: "Washer" }]);
  }

  // registerDevice: API payload values overwrite stale local values for same appliance
  {
    const { service } = createDeviceService();
    service.devices.set("ha-dryer", {
      haId: "ha-dryer",
      name: "Dryer",
      PowerState: "On",
      connected: true,
      ProgramProgress: 55,
      RemainingProgramTime: 1800,
    });

    const registered = service.registerDevice(
      {
        haId: "ha-dryer",
        name: "Dryer",
        PowerState: "Off",
        connected: false,
      },
      0,
    );
    await service.refreshDeviceDetails(registered);

    const updated = service.devices.get("ha-dryer");
    assert.ok(updated);
    assert.strictEqual(updated.PowerState, "Off");
    assert.strictEqual(updated.connected, false);
  }

  // refreshDeviceDetails: settings are seeded once per appliance, for every type. They
  // carry BSH.Common.Setting.PowerState, which /status never returns.
  {
    const { service } = createDeviceService();
    let statusCalls = 0;
    let settingsCalls = 0;
    service.fetchDeviceStatus = async () => {
      statusCalls += 1;
    };
    service.fetchDeviceSettings = async (device) => {
      settingsCalls += 1;
      service.settingsFetchedHaIds.add(device.haId);
    };

    const dishwasher = {
      haId: "ha-dishwasher",
      name: "Dishwasher",
      type: "Dishwasher",
      connected: true,
    };

    await service.refreshDeviceDetails(service.registerDevice(dishwasher, 0));
    assert.strictEqual(statusCalls, 1);
    assert.strictEqual(settingsCalls, 1);

    // A later refresh must not spend another call on the same appliance.
    await service.refreshDeviceDetails(service.registerDevice(dishwasher, 0));
    assert.strictEqual(statusCalls, 2);
    assert.strictEqual(settingsCalls, 1);
  }

  // fetchDeviceSettings: a failed fetch stays retryable on the next refresh.
  {
    const { service } = createDeviceService();
    service.attachClient({
      getSettings: async () => ({ success: false, error: "boom" }),
    });

    await service.fetchDeviceSettings({ haId: "ha-oven", name: "Oven" });
    assert.strictEqual(
      service.shouldFetchInitialSettings({ haId: "ha-oven" }),
      true,
      "A failed settings fetch must not mark the appliance as seeded",
    );
  }

  // fetchDeviceStatus: successful status snapshot refreshes stale connected=false
  {
    const { service } = createDeviceService();
    const device = {
      haId: "ha-status",
      name: "Washer",
      connected: false,
    };
    service.attachClient({
      getStatus: async () => ({
        success: true,
        data: { status: [] },
      }),
      applyEventToDevice() {},
    });

    await service.fetchDeviceStatus(device);

    assert.strictEqual(device.connected, true);
  }

  // fetchDeviceStatus: applies fetched events to the live device in the Map,
  // not the (possibly orphaned) object reference captured when the fetch
  // started. registerDevice() replaces the Map entry with a new merged object
  // on every refresh cycle, so a status fetch that resolves after a second,
  // overlapping refresh must not silently write into a discarded object.
  {
    const { service } = createDeviceService();
    const originalDevice = { haId: "ha-race", name: "Washer", connected: true };
    service.devices.set("ha-race", originalDevice);

    let releaseStatus;
    service.attachClient({
      getStatus: async () =>
        new Promise((resolve) => {
          releaseStatus = () =>
            resolve({ success: true, data: { status: [{ key: "BSH.Common.Status.OperationState" }] } });
        }),
      applyEventToDevice(device) {
        device.sawEvent = true;
      },
    });

    const statusPromise = service.fetchDeviceStatus(originalDevice);

    // Simulate a concurrent refresh cycle replacing the Map entry before the
    // in-flight status fetch above resolves.
    const replacementDevice = { haId: "ha-race", name: "Washer", connected: true };
    service.devices.set("ha-race", replacementDevice);

    releaseStatus();
    await statusPromise;

    assert.strictEqual(
      replacementDevice.sawEvent,
      true,
      "status update must land on the live device, not the orphaned reference",
    );
    assert.strictEqual(originalDevice.sawEvent, undefined, "the orphaned reference must not be the one mutated");
  }

  // handleGetDevicesSuccess: broadcasts the base device list immediately before slow enrichment settles
  {
    const { service, notifications } = createDeviceService();
    const sendSocketNotificationCalls = [];
    service.attachClient({
      subscribe: () => {},
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
    });
    service.setConfig({ enableSSEHeartbeat: false });
    service.fetchDeviceStatus = () => wait(40);
    service.fetchDeviceSettings = () => wait(40);

    service.handleGetDevicesSuccess(
      {
        data: {
          homeappliances: [{ haId: "ha-1", name: "Washer", connected: true }],
        },
      },
      (n, payload) => {
        sendSocketNotificationCalls.push({ n, payload });
      },
    );

    assert.ok(
      sendSocketNotificationCalls.some((entry) => entry.n === "DEVICES_UPDATE"),
      "Expected an immediate device broadcast",
    );
    assert.strictEqual(
      notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "complete"),
      false,
      "Expected device enrichment to still be pending immediately after the first broadcast",
    );

    await wait(70);

    assert.ok(
      notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "complete"),
      "Expected completion status after slow enrichment settles",
    );
  }

  // noteTokenRefreshed: prevents immediate redundant token refresh before first SSE subscribe
  {
    const { service } = createDeviceService();
    let refreshCalls = 0;
    service.attachClient({
      refreshTokens: async () => {
        refreshCalls += 1;
      },
    });
    service.noteTokenRefreshed(Date.now());

    await service.ensureFreshTokenForSSE();

    assert.strictEqual(refreshCalls, 0);
  }

  // SSE rebuild: an access token that is still valid for long is not refreshed
  // (each refresh is a request and one of 100 per day); one about to expire is.
  {
    const { service } = createDeviceService();
    let refreshCalls = 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const hcMock = {
      tokens: { timestamp: nowSeconds - 3600, expires_in: 86400 },
      refreshTokens: async () => {
        refreshCalls += 1;
      },
    };
    service.attachClient(hcMock);

    await service.ensureFreshTokenForSSE();
    assert.strictEqual(refreshCalls, 0, "a token valid for ~23 h needs no refresh");

    hcMock.tokens = { timestamp: nowSeconds - 86400 + 300, expires_in: 86400 };
    await service.ensureFreshTokenForSSE();
    assert.strictEqual(refreshCalls, 1, "a token expiring in 5 min is refreshed first");
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
    service.handleGetDevicesError(Object.assign(new Error("Too many requests"), { statusCode: 429 }));
    const errEvent = notifications.find((e) => e.n === "INIT_STATUS");
    assert.ok(errEvent);
    assert.strictEqual(errEvent.p.statusCode, 429);
    assert.strictEqual(errEvent.p.isRateLimit, true);
    assert.ok(errEvent.p.message.includes("HTTP 429"));
  }

  // SSE per-device subscription establishes immediately and is idempotent
  {
    const { service: sseService } = createDeviceService();
    const subscribeCalls = [];
    const hcMock = {
      subscribeDevice: (haId, type) => subscribeCalls.push(`${haId}:${type}`),
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
    };
    sseService.attachClient(hcMock);
    sseService.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    sseService.setConfig({ enableSSEHeartbeat: false });

    const handler = () => {};

    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["ha-1:KEEP-ALIVE", "ha-1:NOTIFY", "ha-1:STATUS", "ha-1:EVENT"]),
      "Expected one device channel subscription for KEEP-ALIVE/NOTIFY/STATUS/EVENT",
    );

    // Calling subscribeToDeviceEvents again with the same handler should not
    // create additional subscriptions.
    sseService.subscribeToDeviceEvents(handler);
    await wait(0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["ha-1:KEEP-ALIVE", "ha-1:NOTIFY", "ha-1:STATUS", "ha-1:EVENT"]),
      "Expected no additional subscriptions when reusing same handler",
    );
  }

  // SSE keep-alive: logs debug traffic and refreshes heartbeat state
  {
    const { service, logs, notifications } = createDeviceService();
    service.heartbeatStale = true;

    service.handleKeepAliveEvent({ data: "ping" });

    assert.strictEqual(service.heartbeatArmed, true);
    assert.ok(Number.isFinite(service.lastKeepAliveTimestamp));
    assert.ok(logs.some((entry) => entry.level === "debug" && entry.message.includes("SSE KEEP-ALIVE received")));
    assert.ok(!logs.some((entry) => entry.message.includes("undefined")));
    assert.ok(notifications.some((entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_recovered"));
  }

  // Attaching a new HomeConnect client closes previous event sources
  {
    const { service } = createDeviceService();
    const closeCalls = [];
    const oldClient = {
      setEventSourceRetryConfig: () => {},
      closeEventSources: (opts) => closeCalls.push(opts),
    };
    const newClient = {
      setEventSourceRetryConfig: () => {},
      closeEventSources: () => {},
    };

    service.attachClient(oldClient);
    service.attachClient(newClient);

    assert.strictEqual(closeCalls.length, 1, "Previous client should be closed when new client attached");
    assert.deepStrictEqual(closeCalls[0], { devices: true, global: true });
  }

  // SSE heartbeat: a silent stream before the first event must not trigger recovery
  {
    let staleRecoveries = 0;
    const { service, notifications } = createDeviceService({
      onSseStale: () => {
        staleRecoveries += 1;
      },
    });
    const subscribeCalls = [];
    const hcMock = {
      subscribeDevice: (haId, type) => subscribeCalls.push(`${haId}:${type}`),
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
    };

    service.attachClient(hcMock);
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    service.setConfig({
      enableSSEHeartbeat: true,
      sseHeartbeatCheckIntervalMs: 10,
      sseHeartbeatStaleThresholdMs: 20,
      sseRecoveryCooldownMs: 1000,
    });

    service.subscribeToDeviceEvents(() => {});
    await wait(80);

    const staleEvent = notifications.find((entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_stale");
    assert.strictEqual(staleEvent, undefined);
    assert.strictEqual(staleRecoveries, 0);
    assert.strictEqual(
      JSON.stringify(subscribeCalls),
      JSON.stringify(["ha-1:KEEP-ALIVE", "ha-1:NOTIFY", "ha-1:STATUS", "ha-1:EVENT"]),
    );

    service.shutdown();
  }

  // SSE heartbeat: after at least one event, prolonged silence still triggers recovery once
  {
    let staleRecoveries = 0;
    const { service, notifications } = createDeviceService({
      onSseStale: () => {
        staleRecoveries += 1;
      },
    });
    const hcMock = {
      subscribe: () => {},
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
      applyEventToDevice: (device, item) => {
        device[item.key] = item.value;
      },
    };

    service.attachClient(hcMock);
    service.devices.set("ha-1", { haId: "ha-1", name: "Washer" });
    service.setConfig({
      enableSSEHeartbeat: true,
      sseHeartbeatCheckIntervalMs: 10,
      sseHeartbeatStaleThresholdMs: 20,
      sseRecoveryCooldownMs: 1000,
    });

    const socketNotifications = [];
    service.subscribeToDeviceEvents((payload) =>
      service.deviceEvent(payload, (n, data) => {
        socketNotifications.push({ n, data });
      }),
    );
    await wait(0);

    service.deviceEvent(
      {
        data: JSON.stringify({
          items: [
            {
              key: "BSH.Common.Option.ProgramProgress",
              value: 42,
              uri: "/api/homeappliances/ha-1/events",
            },
          ],
        }),
      },
      (n, data) => {
        socketNotifications.push({ n, data });
      },
    );

    await wait(80);

    const staleEvent = notifications.find((entry) => entry.n === "INIT_STATUS" && entry.p.status === "sse_stale");
    assert.ok(staleEvent);
    assert.strictEqual(staleRecoveries, 1);
    assert.ok(
      socketNotifications.some((entry) => entry.n === "DEVICES_UPDATE"),
      "Expected the incoming SSE event to update the frontend cache",
    );

    service.shutdown();
  }

  // A repeated device snapshot must not tear down healthy SSE channels: the
  // refresh callback changes per run, but the event handler identity must not.
  {
    const { service } = createDeviceService();
    const subscribeCalls = [];
    let closeCalls = 0;
    let tokenRefreshes = 0;
    let settingsFetches = 0;
    const hcMock = {
      subscribeDevice: (haId, type) => subscribeCalls.push(`${haId}:${type}`),
      refreshTokens: () => {
        tokenRefreshes += 1;
        return Promise.resolve();
      },
      closeEventSources: () => {
        closeCalls += 1;
      },
      getStatus: () => Promise.resolve({ success: true, data: { status: [] } }),
      getSettings: () => {
        settingsFetches += 1;
        return Promise.resolve({ success: true, data: { settings: [] } });
      },
      applyEventToDevice: () => {},
    };
    service.attachClient(hcMock);
    service.setConfig({ enableSSEHeartbeat: false });

    const apiResult = {
      data: { homeappliances: [{ haId: "ha-1", name: "Washer", connected: true }] },
    };

    service.handleGetDevicesSuccess(apiResult, () => {});
    await wait(10);

    const subscribesAfterFirst = subscribeCalls.length;
    const closesAfterFirst = closeCalls;
    assert.strictEqual(subscribesAfterFirst, 4, "Expected one channel with four event types");
    assert.strictEqual(settingsFetches, 1, "Expected settings to be seeded once");

    // Second snapshot with a brand new callback - the SSE session must survive.
    service.handleGetDevicesSuccess(apiResult, () => {});
    await wait(10);

    assert.strictEqual(
      subscribeCalls.length,
      subscribesAfterFirst,
      "Expected no re-subscription on a follow-up device snapshot",
    );
    assert.strictEqual(closeCalls, closesAfterFirst, "Expected no SSE teardown on a follow-up device snapshot");
    assert.strictEqual(tokenRefreshes, 1, "Expected no extra token refresh per snapshot");
    assert.strictEqual(settingsFetches, 1, "Expected /settings not to be refetched per snapshot");

    service.shutdown();
  }

  // The SSE watchdog rebuild is a channel-level operation: it must not invalidate
  // the "settings already seeded" cache and cause a /settings refetch per device.
  {
    const { service } = createDeviceService();
    let settingsFetches = 0;
    service.attachClient({
      subscribeDevice: () => {},
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
      getStatus: () => Promise.resolve({ success: true, data: { status: [] } }),
      getSettings: () => {
        settingsFetches += 1;
        return Promise.resolve({ success: true, data: { settings: [] } });
      },
      applyEventToDevice: () => {},
    });
    service.setConfig({ enableSSEHeartbeat: false });

    const apiResult = {
      data: { homeappliances: [{ haId: "ha-1", name: "Washer", connected: true }] },
    };
    service.handleGetDevicesSuccess(apiResult, () => {});
    await wait(10);
    assert.strictEqual(settingsFetches, 1);

    await service.reconnectEventSubscriptions();
    await wait(10);

    service.handleGetDevicesSuccess(apiResult, () => {});
    await wait(10);

    assert.strictEqual(settingsFetches, 1, "Expected the settings cache to survive an SSE channel rebuild");

    service.shutdown();
  }

  // A 429 on the device fetch must engage the shared backoff and settle the run.
  {
    const rateLimitCalls = [];
    let settled = 0;
    const { service } = createDeviceService({
      setRateLimitUntil: (ts) => rateLimitCalls.push(ts),
      onRefreshSettled: () => {
        settled += 1;
      },
    });
    service.attachClient({
      getHomeAppliances: () =>
        Promise.resolve({
          success: false,
          statusCode: 429,
          retryAfterSeconds: 120,
          error: "Too Many Requests",
        }),
    });

    const before = Date.now();
    let followUps = 0;
    service.getDevices(() => {}, {
      onDetailsRefreshed: () => {
        followUps += 1;
      },
    });
    await wait(10);

    assert.strictEqual(followUps, 0, "A failed device fetch must not start the program follow-up");
    assert.strictEqual(rateLimitCalls.length, 1, "Expected the global rate limit to be set");
    assert.ok(rateLimitCalls[0] >= before + 120 * 1000, "Expected Retry-After to drive the backoff window");
    assert.strictEqual(settled, 1, "Expected the failed refresh to settle exactly once");
  }

  // The program follow-up runs once, after every status call has finished - not
  // alongside them (a burst) and not on stale state.
  {
    const order = [];
    const { service } = createDeviceService();
    service.attachClient({
      getHomeAppliances: () =>
        Promise.resolve({
          success: true,
          data: {
            homeappliances: [
              { haId: "ha-1", name: "Washer", connected: true },
              { haId: "ha-2", name: "Dryer", connected: true },
            ],
          },
        }),
      getStatus: (haId) => {
        order.push(`status:${haId}`);
        return Promise.resolve({ success: true, data: { status: [] } });
      },
      getSettings: () => Promise.resolve({ success: true, data: { settings: [] } }),
      refreshTokens: () => Promise.resolve(),
      subscribeDevice() {},
      closeEventSources() {},
    });

    service.getDevices(() => {}, { onDetailsRefreshed: () => order.push("programs") });
    await wait(700);

    assert.deepStrictEqual(order, ["status:ha-1", "status:ha-2", "programs"]);
    service.shutdown();
  }

  // A refresh that never reaches the API must still settle its in-flight state.
  {
    let settled = 0;
    const { service } = createDeviceService({
      onRefreshSettled: () => {
        settled += 1;
      },
    });
    service.getDevices(() => {});
    assert.strictEqual(settled, 1, "Expected the hc-not-ready exit to settle the refresh");
  }

  // A 429 on a per-appliance status fetch must engage the shared backoff as well.
  // getStatus() resolves with success:false instead of rejecting, so this used to
  // pass by unnoticed - no log, and no backoff to stop the next snapshot from
  // repeating the burst that had just been throttled.
  {
    const rateLimitCalls = [];
    const { service, logs } = createDeviceService({
      setRateLimitUntil: (ts) => rateLimitCalls.push(ts),
    });
    service.attachClient({
      getStatus: () =>
        Promise.resolve({
          success: false,
          statusCode: 429,
          retryAfterSeconds: 90,
          error: "Too Many Requests",
        }),
    });

    const before = Date.now();
    await service.fetchDeviceStatus({ haId: "ha-1", name: "Washer" });

    assert.strictEqual(rateLimitCalls.length, 1, "Expected a 429 on /status to set the backoff");
    assert.ok(rateLimitCalls[0] >= before + 90 * 1000, "Expected Retry-After to drive the backoff window");
    assert.ok(
      logs.some((entry) => entry.level === "warn" && entry.message.includes("Rate limit on status fetch")),
      "Expected the rate limit to be logged",
    );
  }

  // Same for /settings, and without Retry-After the fallback window applies. The
  // appliance must stay unseeded so the settings fetch is retried later.
  {
    const rateLimitCalls = [];
    const { service } = createDeviceService({
      setRateLimitUntil: (ts) => rateLimitCalls.push(ts),
    });
    service.attachClient({
      getSettings: () => Promise.resolve({ success: false, statusCode: 429, error: "Too Many Requests" }),
    });

    const before = Date.now();
    await service.fetchDeviceSettings({ haId: "ha-oven", name: "Oven" });

    assert.strictEqual(rateLimitCalls.length, 1, "Expected a 429 on /settings to set the backoff");
    assert.ok(
      rateLimitCalls[0] >= before + 5 * 60 * 1000,
      "Expected the fallback backoff without a Retry-After header",
    );
    assert.strictEqual(
      service.shouldFetchInitialSettings({ haId: "ha-oven" }),
      true,
      "A rate limited settings fetch must stay retryable",
    );
  }

  // A snapshot must not fire every appliance's detail fetches at once: that burst
  // is what the Home Connect rate limiter answers with 429 in the first place.
  {
    const { service } = createDeviceService();
    let inFlight = 0;
    let maxInFlight = 0;
    const statusFetches = [];
    service.setConfig({ enableSSEHeartbeat: false });
    service.attachClient({
      subscribeDevice: () => {},
      refreshTokens: () => Promise.resolve(),
      closeEventSources: () => {},
      applyEventToDevice: () => {},
      getStatus: async (haId) => {
        statusFetches.push(haId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(20);
        inFlight -= 1;
        return { success: true, data: { status: [] } };
      },
      getSettings: async () => {
        await wait(20);
        return { success: true, data: { settings: [] } };
      },
    });

    service.handleGetDevicesSuccess(
      {
        data: {
          homeappliances: [
            { haId: "ha-1", name: "Washer", connected: true },
            { haId: "ha-2", name: "Dryer", connected: true },
          ],
        },
      },
      () => {},
    );

    await wait(700);

    assert.deepStrictEqual(statusFetches, ["ha-1", "ha-2"], "Expected every appliance of the snapshot to be enriched");
    assert.strictEqual(maxInFlight, 1, "Expected appliances to be enriched one at a time");

    service.shutdown();
  }

  console.log("device-service.test.js OK");
})();
