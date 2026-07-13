"use strict";

const assert = require("assert");
const Module = require("module");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node_helper") {
    return {
      create(definition) {
        return definition;
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const helper = require("../node_helper");
Module._load = originalLoad;

function resetHelperState() {
  helper.sessionState = "boot";
  helper.sessionStateMeta = {
    updatedAt: 0,
    event: "init",
    reason: null
  };
  helper.debugStats = {
    lastApiCallTs: null,
    lastSseEventTs: null,
    lastSseTrafficTs: null,
    sse: {
      sampleCount: 0,
      lastGapMs: null,
      minGapMs: null,
      maxGapMs: null,
      avgGapMs: null,
      totalGapMs: 0
    },
    keepAlive: {
      sampleCount: 0,
      lastGapMs: null,
      minGapMs: null,
      maxGapMs: null,
      avgGapMs: null,
      totalGapMs: 0,
      lastTs: null
    },
    apiCounters: {}
  };
  helper.hc = null;
  helper.instanceId = null;
  helper.sharedConfigOwnerInstanceId = null;
  if (helper.clientConfigs && typeof helper.clientConfigs.clear === "function") {
    helper.clientConfigs.clear();
  }
  helper.activeProgramFetchInFlight = false;
  helper.activeProgramFetchSignature = null;
  helper.recentForcedProgramFetch = null;
  if (helper.fullSnapshotTimer) {
    clearInterval(helper.fullSnapshotTimer);
    helper.fullSnapshotTimer = null;
  }
  helper.setRateLimitUntil(0);
  if (helper.rateLimitReleaseTimer) {
    clearTimeout(helper.rateLimitReleaseTimer);
    helper.rateLimitReleaseTimer = null;
  }
  helper.notifications = {
    REQUEST: "MMM-HomeConnect2_REQUEST",
    EVENT: "MMM-HomeConnect2_EVENT"
  };
  helper.config = null;
  helper.configReceived = false;
}

(async () => {
  resetHelperState();

  // Unknown events must be ignored.
  const unknownResult = helper.transitionSessionState("UNKNOWN_EVENT", {
    reason: "test_unknown"
  });
  assert.strictEqual(unknownResult, "boot");
  assert.strictEqual(helper.sessionState, "boot");

  // Invalid transition must be blocked by guard.
  const invalidResult = helper.transitionSessionState("PROGRAM_FETCH_DONE", {
    reason: "test_invalid"
  });
  assert.strictEqual(invalidResult, "boot");
  assert.strictEqual(helper.sessionState, "boot");

  // Happy path: auth bootstrap to ready.
  helper.transitionSessionState("AUTH_START", {
    reason: "test_auth_start"
  });
  assert.strictEqual(helper.sessionState, "authenticating");

  helper.transitionSessionState("HC_INIT_START", {
    reason: "test_hc_init"
  });
  assert.strictEqual(helper.sessionState, "initializing");

  helper.transitionSessionState("AUTH_SUCCESS", {
    reason: "test_auth_success"
  });
  assert.strictEqual(helper.sessionState, "ready");

  // Refresh/program flow transitions are allowed from authenticated states.
  helper.transitionSessionState("DEVICE_REFRESH_START", {
    reason: "test_refresh_start"
  });
  assert.strictEqual(helper.sessionState, "refreshing_devices");

  helper.transitionSessionState("DEVICE_REFRESH_DONE", {
    reason: "test_refresh_done"
  });
  assert.strictEqual(helper.sessionState, "ready");

  helper.transitionSessionState("PROGRAM_FETCH_START", {
    reason: "test_program_start"
  });
  assert.strictEqual(helper.sessionState, "refreshing_programs");

  helper.transitionSessionState("PROGRAM_FETCH_DONE", {
    reason: "test_program_done"
  });
  assert.strictEqual(helper.sessionState, "ready");

  // Guard: rate-limit clear is only valid from rate_limited.
  helper.transitionSessionState("RATE_LIMIT_CLEARED", {
    reason: "test_invalid_clear"
  });
  assert.strictEqual(helper.sessionState, "ready");

  // Edge case: auth start from rate_limited is blocked until limiter clears.
  helper.transitionSessionState("RATE_LIMIT_HIT", {
    reason: "test_rate_limit"
  });
  assert.strictEqual(helper.sessionState, "rate_limited");

  helper.transitionSessionState("AUTH_START", {
    reason: "test_blocked_auth_start_while_rate_limited"
  });
  assert.strictEqual(helper.sessionState, "rate_limited");

  helper.setRateLimitUntil(Date.now() - 1);
  helper.transitionSessionState("RATE_LIMIT_CLEARED", {
    reason: "test_manual_rate_limit_clear"
  });
  assert.strictEqual(helper.sessionState, "ready");

  // Timer path: syncRateLimitState should move to rate_limited and later auto-clear.
  helper.setRateLimitUntil(Date.now() + 30);
  const active = helper.syncRateLimitState();
  assert.strictEqual(active, true);
  assert.strictEqual(helper.sessionState, "rate_limited");

  await wait(100);
  assert.strictEqual(helper.sessionState, "ready");

  // Race path: extending rate limit before timer fires must keep state rate_limited.
  helper.setRateLimitUntil(Date.now() + 25);
  helper.syncRateLimitState();
  assert.strictEqual(helper.sessionState, "rate_limited");

  await wait(10);
  helper.setRateLimitUntil(Date.now() + 80);
  helper.scheduleRateLimitRelease(helper.getRateLimitUntil());

  await wait(35);
  assert.strictEqual(helper.sessionState, "rate_limited");

  await wait(120);
  assert.strictEqual(helper.sessionState, "ready");

  // SSE debug stats should track real gaps between events.
  resetHelperState();
  const originalDateNow = Date.now;
  const fakeTimes = [1000, 1600, 2200];
  Date.now = () => fakeTimes.shift();
  helper.broadcastDebugStats = () => { };

  helper.recordSseEvent();
  helper.recordSseEvent();
  helper.recordSseEvent();

  Date.now = originalDateNow;

  assert.strictEqual(helper.debugStats.lastSseEventTs, 2200);
  assert.strictEqual(helper.debugStats.lastSseTrafficTs, 2200);
  assert.strictEqual(helper.debugStats.sse.sampleCount, 2);
  assert.strictEqual(helper.debugStats.sse.lastGapMs, 600);
  assert.strictEqual(helper.debugStats.sse.minGapMs, 600);
  assert.strictEqual(helper.debugStats.sse.maxGapMs, 600);
  assert.strictEqual(helper.debugStats.sse.avgGapMs, 600);

  // KEEP-ALIVE debug stats should track transport traffic even without domain events.
  resetHelperState();
  const originalKeepAliveDateNow = Date.now;
  const keepAliveTimes = [5000, 10500, 16000];
  Date.now = () => keepAliveTimes.shift();
  helper.broadcastDebugStats = () => { };

  helper.recordSseKeepAlive();
  helper.recordSseKeepAlive();
  helper.recordSseKeepAlive();

  Date.now = originalKeepAliveDateNow;

  assert.strictEqual(helper.debugStats.lastSseTrafficTs, 16000);
  assert.strictEqual(helper.debugStats.keepAlive.lastTs, 16000);
  assert.strictEqual(helper.debugStats.keepAlive.sampleCount, 2);
  assert.strictEqual(helper.debugStats.keepAlive.lastGapMs, 5500);
  assert.strictEqual(helper.debugStats.keepAlive.avgGapMs, 5500);

  // SSE stale should rebuild subscriptions and then perform one full resync.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  const staleSequence = [];
  helper.deviceService = {
    reconnectEventSubscriptions() {
      staleSequence.push("rebuild");
      return Promise.resolve(true);
    },
    getDevices(callback) {
      staleSequence.push("device_refresh_start");
      callback("DEVICES_UPDATE", [{ haId: "ha-1", name: "Washer" }]);
    }
  };
  helper.sendSocketNotification = (notification, payload) => {
    if (notification === "MMM-HomeConnect2_EVENT" && payload?.action === "DEVICES_UPDATE") {
      staleSequence.push("device_update_sent");
    }
  };
  const staleOriginalHandleGetActivePrograms = helper.handleGetActivePrograms;
  helper.handleGetActivePrograms = (payload = {}) => {
    staleSequence.push(`program_fetch:${payload.instanceId || "unknown"}:${payload.force}`);
  };

  helper.handleSseStale({ silenceMs: 71000 });
  await wait(0);

  assert.deepStrictEqual(staleSequence, [
    "rebuild",
    "device_refresh_start",
    "program_fetch:sse_watchdog:true"
  ]);

  helper.handleGetActivePrograms = staleOriginalHandleGetActivePrograms;

  // An already authenticated session should start the initial device fetch immediately.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  let immediateGetDevicesCalls = 0;
  helper.deviceService = {
    getDevices() {
      immediateGetDevicesCalls += 1;
    }
  };
  helper.sendSocketNotification = () => { };
  helper.emitInitStatus = () => { };

  helper.handleSessionAlreadyActive();

  assert.strictEqual(immediateGetDevicesCalls, 1);

  // Initial device fetch after HomeConnect init should start immediately and trigger one program snapshot.
  resetHelperState();
  helper.hc = {};
  const initSequence = [];
  helper.deviceService = {
    getDevices(callback) {
      immediateGetDevicesCalls += 1;
      initSequence.push("device_refresh_start");
      callback("DEVICES_UPDATE", []);
    }
  };
  helper.sendSocketNotification = (notification, payload) => {
    if (notification === "MMM-HomeConnect2_EVENT" && payload?.action === "DEVICES_UPDATE") {
      initSequence.push("device_update_sent");
    }
  };
  helper.emitInitStatus = () => { };
  immediateGetDevicesCalls = 0;
  const originalInitHandleGetActivePrograms = helper.handleGetActivePrograms;
  helper.handleGetActivePrograms = (payload = {}) => {
    initSequence.push(`program_fetch:${payload.instanceId || "unknown"}:${payload.force}`);
  };

  helper.handleHomeConnectInitSuccess();

  assert.strictEqual(immediateGetDevicesCalls, 1);
  assert.deepStrictEqual(initSequence, [
    "device_refresh_start",
    "program_fetch:initial_sync:false"
  ]);

  helper.handleGetActivePrograms = originalInitHandleGetActivePrograms;

  // Successful init should arm the periodic 30-minute full snapshot refresh.
  resetHelperState();
  helper.hc = {};
  helper.deviceService = {
    getDevices(callback) {
      callback("DEVICES_UPDATE", []);
    }
  };
  helper.sessionState = "ready";
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalHandleGetActiveProgramsForScheduler = helper.handleGetActivePrograms;
  const scheduledIntervals = [];
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay };
    scheduledIntervals.push(timer);
    return timer;
  };
  global.clearInterval = () => { };
  helper.handleGetActivePrograms = () => { };

  try {
    helper.handleHomeConnectInitSuccess();
    helper.handleSessionAlreadyActive();

    assert.strictEqual(scheduledIntervals.length, 1);
    assert.strictEqual(scheduledIntervals[0].delay, 30 * 60 * 1000);
    assert.ok(helper.fullSnapshotTimer);
  } finally {
    helper.clearPeriodicFullSnapshotRefresh();
    helper.handleGetActivePrograms = originalHandleGetActiveProgramsForScheduler;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  // Washers should not enter active-program retry loops when the API reports no active program.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  const washerDevice = {
    haId: "ha-washer",
    name: "Washer",
    type: "Washer",
    connected: true,
    OperationState: "BSH.Common.EnumType.OperationState.Run",
    RemainingProgramTime: { value: "PT10M" }
  };
  helper.deviceService = {
    devices: new Map([["ha-washer", washerDevice]])
  };
  const scheduledRetries = [];
  helper.activeProgramManager = {
    schedule(devices) {
      scheduledRetries.push(...devices);
    },
    clear() { }
  };
  helper.programService = {
    applyProgramResult() {
      return null;
    }
  };
  helper.fetchActiveProgramForDevice = async () => ({
    haId: "ha-washer",
    success: false,
    error: "No active program"
  });
  helper.broadcastProgramData = () => { };

  await helper.fetchActiveProgramsForDevices([washerDevice], "frontend-a");

  assert.strictEqual(scheduledRetries.length, 0);

  // Overlapping forced active-program requests should be deduplicated while one fetch is in flight.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  helper.deviceService = {
    devices: new Map([["ha-1", { haId: "ha-1", name: "Washer" }]])
  };
  let fetchCalls = 0;
  helper.fetchActiveProgramsForDevices = () => {
    fetchCalls += 1;
  };

  helper.handleGetActivePrograms({
    instanceId: "resume-followup",
    haIds: ["ha-1"],
    force: true
  });
  helper.handleGetActivePrograms({
    instanceId: "resume-followup",
    haIds: ["ha-1"],
    force: true
  });

  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(helper.activeProgramFetchInFlight, true);

  // Recently completed forced requests for the same devices should be deduplicated
  // across different frontend instances for a short window.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  helper.deviceService = {
    devices: new Map([["ha-1", { haId: "ha-1", name: "Washer" }]])
  };
  fetchCalls = 0;
  helper.fetchActiveProgramsForDevices = (_devices, _instanceId, requestMeta = {}) => {
    fetchCalls += 1;
    if (requestMeta.force && requestMeta.scopeKey) {
      helper.rememberForcedProgramFetch(requestMeta.scopeKey, Date.now());
    }
    helper.activeProgramFetchInFlight = false;
    helper.activeProgramFetchSignature = null;
  };

  helper.handleGetActivePrograms({
    instanceId: "frontend-a",
    haIds: ["ha-1"],
    force: true
  });
  helper.handleGetActivePrograms({
    instanceId: "frontend-b",
    haIds: ["ha-1"],
    force: true
  });

  assert.strictEqual(fetchCalls, 1);

  // Shared backend config must remain stable when additional frontend instances connect.
  resetHelperState();
  const authConfigs = [];
  const deviceConfigs = [];
  const acceptLanguages = [];
  const configuredInstances = [];
  helper.authService = {
    setConfig(config) {
      authConfigs.push(config);
    }
  };
  helper.deviceService = {
    setConfig(config) {
      deviceConfigs.push(config);
    }
  };
  helper.hc = {
    setAcceptLanguage(language) {
      acceptLanguages.push(language);
    }
  };
  helper.handleConfigNotificationFirstTime = (instanceId) => {
    configuredInstances.push(`first:${instanceId}`);
    helper.configReceived = true;
  };
  helper.handleConfigNotificationSubsequent = (instanceId) => {
    configuredInstances.push(`next:${instanceId}`);
  };

  helper.handleConfigNotification({
    instanceId: "frontend-a",
    apiLanguage: "de",
    minActiveProgramIntervalMs: 1111,
    enableSSEHeartbeat: true
  });
  helper.handleConfigNotification({
    instanceId: "frontend-b",
    apiLanguage: "en",
    minActiveProgramIntervalMs: 9999,
    enableSSEHeartbeat: false
  });

  assert.strictEqual(helper.instanceId, "frontend-a");
  assert.strictEqual(helper.sharedConfigOwnerInstanceId, "frontend-a");
  assert.strictEqual(helper.config.apiLanguage, "de");
  assert.strictEqual(helper.config.minActiveProgramIntervalMs, 1111);
  assert.deepStrictEqual(configuredInstances, ["first:frontend-a", "next:frontend-b"]);
  assert.strictEqual(authConfigs.length, 1);
  assert.strictEqual(deviceConfigs.length, 2);
  assert.deepStrictEqual(acceptLanguages, ["de", "de"]);

  // Manual auth retry must preserve all registered frontend instances.
  resetHelperState();
  helper.authService = {
    setConfig() { }
  };
  helper.deviceService = {
    devices: new Map(),
    setConfig() { },
    shutdown() { }
  };
  helper.activeProgramManager = {
    clearAll() { }
  };
  helper.handleConfigNotificationFirstTime = () => {
    helper.configReceived = true;
  };
  helper.handleConfigNotificationSubsequent = () => { };
  helper.checkTokenAndInitialize = () => { };

  helper.handleConfigNotification({ instanceId: "frontend-a" });
  helper.handleConfigNotification({ instanceId: "frontend-b" });

  const retryNotifications = [];
  helper.sendSocketNotification = (notification, payload) => {
    retryNotifications.push({ notification, payload });
  };

  helper.retryAuthentication();
  helper.broadcastToAllClients("INIT_STATUS", {
    status: "post_retry"
  });

  assert.strictEqual(
    retryNotifications.filter((entry) => entry.payload?.instanceId === "frontend-a").length,
    1
  );
  assert.strictEqual(
    retryNotifications.filter((entry) => entry.payload?.instanceId === "frontend-b").length,
    1
  );

  helper.transitionSessionState("RESET", {
    reason: "test_reset"
  });
  assert.strictEqual(helper.sessionState, "boot");

  console.log("node-helper-state-machine.test.js OK");
})();
