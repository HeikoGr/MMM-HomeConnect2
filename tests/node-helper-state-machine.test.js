"use strict";

const assert = require("assert");
const Module = require("module");
const os = require("os");
const path = require("path");

// retryAuthentication() deletes the refresh token file. Redirect that path into a
// temp directory so running the tests never touches a real Home Connect session.
const testRefreshTokenPath = path.join(os.tmpdir(), "mmm-homeconnect2-test-refresh-token.json");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Timer assertions must not race the event loop under load: poll for the expected
// state instead of sleeping for a fixed margin and hoping the timer already fired.
async function waitForSessionState(expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (helper.sessionState !== expected && Date.now() < deadline) {
    await wait(10);
  }
  return helper.sessionState;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node_helper") {
    return {
      create(definition) {
        return definition;
      }
    };
  }
  if (request.endsWith("module-paths")) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, refreshTokenPath: testRefreshTokenPath };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const helper = require("../node_helper");
Module._load = originalLoad;

const originalFetchActiveProgramsForDevices = helper.fetchActiveProgramsForDevices;

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
  helper.sharedConfigHash = null;
  helper.sharedSessionConfig = null;
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

// globalSession lives in the helper's module scope, so the registered clients are
// read back through the only path that enumerates them: a broadcast.
function registeredInstances() {
  const ids = [];
  const originalSendEventToInstance = helper.sendEventToInstance;
  helper.sendEventToInstance = (instanceId) => {
    ids.push(instanceId);
  };
  helper.broadcastToAllClients("DEBUG_STATS", {});
  helper.sendEventToInstance = originalSendEventToInstance;
  return ids;
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

  assert.strictEqual(
    await waitForSessionState("ready"),
    "ready",
    "A release timer firing early must re-arm instead of stranding the session"
  );

  // Race path: extending rate limit before timer fires must keep state rate_limited.
  helper.setRateLimitUntil(Date.now() + 25);
  helper.syncRateLimitState();
  assert.strictEqual(helper.sessionState, "rate_limited");

  await wait(10);
  helper.setRateLimitUntil(Date.now() + 80);
  helper.scheduleRateLimitRelease(helper.getRateLimitUntil());

  await wait(35);
  assert.strictEqual(helper.sessionState, "rate_limited");

  assert.strictEqual(await waitForSessionState("ready"), "ready");

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

  // Active-looking devices should enter limited active-program retry loops
  // when the API momentarily reports no active program.
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

  assert.strictEqual(scheduledRetries.length, 1);

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

  // A request for a *different* device arriving while another fetch is in
  // flight is dropped for timing reasons only, not because anything failed -
  // it must be retried automatically as soon as the in-flight fetch finishes,
  // instead of relying on another SSE delta to re-trigger it.
  resetHelperState();
  helper.hc = {};
  helper.sessionState = "ready";
  helper.fetchActiveProgramsForDevices = originalFetchActiveProgramsForDevices;
  helper.deviceService = {
    devices: new Map([
      ["ha-1", { haId: "ha-1", name: "Washer", connected: true }],
      ["ha-2", { haId: "ha-2", name: "Dryer", connected: true }]
    ])
  };
  helper.programService = { applyProgramResult: () => null };
  helper.activeProgramManager = {
    clear() { },
    schedule() { }
  };
  helper.broadcastProgramData = () => { };

  const overlapFetchOrder = [];
  let releaseWasherFetch;
  helper.fetchActiveProgramForDevice = async (haId) => {
    overlapFetchOrder.push(haId);
    if (haId === "ha-1") {
      await new Promise((resolve) => {
        releaseWasherFetch = resolve;
      });
    }
    return { haId, success: false, error: "No active program" };
  };

  helper.handleGetActivePrograms({
    instanceId: "resume-followup",
    haIds: ["ha-1"],
    force: true
  });
  await wait(10); // let the ha-1 fetch start and block on releaseWasherFetch

  helper.handleGetActivePrograms({
    instanceId: "sse_program_detected",
    haIds: ["ha-2"],
    force: true
  });
  await wait(10);

  assert.deepStrictEqual(
    overlapFetchOrder,
    ["ha-1"],
    "ha-2 must not be fetched while ha-1's fetch is in flight"
  );
  assert.strictEqual(helper.pendingActiveProgramHaIds.has("ha-2"), true);

  releaseWasherFetch();
  // fetchActiveProgramsForDevices waits 500ms between devices to avoid
  // hammering the API before its finally block (which drains the pending
  // queue) runs.
  await wait(600);

  assert.deepStrictEqual(
    overlapFetchOrder,
    ["ha-1", "ha-2"],
    "ha-2 must be retried automatically once ha-1's fetch finishes"
  );
  assert.strictEqual(helper.pendingActiveProgramHaIds.size, 0);

  helper.fetchActiveProgramsForDevices = () => { };

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

  // Only session-relevant config takes part in the hash. Display-local drift keeps
  // the client connected, foreign credentials are rejected.
  resetHelperState();
  const authConfigs = [];
  const deviceConfigs = [];
  const acceptLanguages = [];
  const configuredInstances = [];
  const configMismatchStatuses = [];
  const sessionConfigEvents = [];
  const originalEmitInitStatus = helper.emitInitStatus;
  const originalSendEventToInstance = helper.sendEventToInstance;
  helper.emitInitStatus = (status, payload = {}) => {
    if (payload.isConfigMismatch) {
      configMismatchStatuses.push({ status, payload });
    }
  };
  helper.sendEventToInstance = (instanceId, action, data) => {
    if (action === "SESSION_CONFIG") {
      sessionConfigEvents.push({ instanceId, data });
    }
  };
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
    clientId: "client-1",
    apiLanguage: "de",
    minActiveProgramIntervalMs: 1111,
    enableSSEHeartbeat: true,
    showDeviceIcon: true
  });

  // Display-only options must not register as drift at all.
  helper.handleConfigNotification({
    instanceId: "frontend-b",
    clientId: "client-1",
    apiLanguage: "de",
    minActiveProgramIntervalMs: 1111,
    enableSSEHeartbeat: true,
    showDeviceIcon: false,
    showAlwaysAllDevices: true,
    header: "Another header"
  });

  // Session-relevant drift: client stays registered but is told what applies.
  helper.handleConfigNotification({
    instanceId: "frontend-c",
    clientId: "client-1",
    apiLanguage: "de",
    minActiveProgramIntervalMs: 9999,
    enableSSEHeartbeat: false
  });

  // Foreign credentials cannot be served by this session.
  helper.handleConfigNotification({
    instanceId: "frontend-d",
    clientId: "client-2",
    apiLanguage: "de",
    minActiveProgramIntervalMs: 1111,
    enableSSEHeartbeat: true
  });

  assert.strictEqual(helper.instanceId, "frontend-a");
  assert.strictEqual(helper.sharedConfigOwnerInstanceId, "frontend-a");
  assert.strictEqual(helper.config.apiLanguage, "de");
  assert.strictEqual(helper.config.minActiveProgramIntervalMs, 1111);
  assert.ok(typeof helper.sharedConfigHash === "string" && helper.sharedConfigHash.length > 0);
  assert.deepStrictEqual(configuredInstances, [
    "first:frontend-a",
    "next:frontend-b",
    "next:frontend-c"
  ]);
  assert.strictEqual(authConfigs.length, 1);
  assert.strictEqual(deviceConfigs.length, 3);
  assert.deepStrictEqual(acceptLanguages, ["de", "de", "de"]);
  const registeredAfterDrift = registeredInstances();
  ["frontend-a", "frontend-b", "frontend-c"].forEach((instanceId) => {
    assert.ok(registeredAfterDrift.includes(instanceId), `${instanceId} must stay registered`);
  });
  assert.ok(
    !registeredAfterDrift.includes("frontend-d"),
    "The rejected client must not receive broadcasts"
  );

  // Exactly one hard rejection, and only for the credential mismatch.
  assert.strictEqual(configMismatchStatuses.length, 1);
  assert.strictEqual(configMismatchStatuses[0].status, "device_error");
  assert.strictEqual(configMismatchStatuses[0].payload.instanceId, "frontend-d");
  assert.deepStrictEqual(configMismatchStatuses[0].payload.mismatchKeys, ["clientId"]);
  assert.strictEqual(
    typeof configMismatchStatuses[0].payload.message === "string" &&
    configMismatchStatuses[0].payload.message.length > 0,
    false
  );

  // Every accepted client learns the effective session config, credentials excluded.
  assert.deepStrictEqual(
    sessionConfigEvents.map((event) => event.instanceId),
    ["frontend-a", "frontend-b", "frontend-c"]
  );
  assert.strictEqual(sessionConfigEvents[0].data.drift, null);
  assert.strictEqual(sessionConfigEvents[1].data.drift, null);
  assert.deepStrictEqual(sessionConfigEvents[2].data.drift.keys.sort(), [
    "enableSSEHeartbeat",
    "minActiveProgramIntervalMs"
  ]);
  assert.strictEqual(sessionConfigEvents[2].data.ownerInstanceId, "frontend-a");
  assert.strictEqual(sessionConfigEvents[2].data.sessionConfig.apiLanguage, "de");
  assert.strictEqual(sessionConfigEvents[2].data.sessionConfig.minActiveProgramIntervalMs, 1111);
  assert.strictEqual(
    Object.hasOwn(sessionConfigEvents[2].data.sessionConfig, "clientId"),
    false
  );
  assert.strictEqual(
    Object.hasOwn(sessionConfigEvents[2].data.sessionConfig, "clientSecret"),
    false
  );

  // A browser-derived language only fills the gap when nothing is configured.
  resetHelperState();
  helper.emitInitStatus = () => { };
  helper.sendEventToInstance = () => { };
  helper.authService = { setConfig() { } };
  helper.deviceService = { setConfig() { } };
  helper.hc = null;
  helper.handleConfigNotificationFirstTime = () => {
    helper.configReceived = true;
  };
  helper.handleConfigNotificationSubsequent = () => { };

  helper.handleConfigNotification({
    instanceId: "kiosk",
    clientId: "client-1",
    apiLanguage: "",
    preferredApiLanguage: "de-DE"
  });
  helper.handleConfigNotification({
    instanceId: "phone",
    clientId: "client-1",
    apiLanguage: "",
    preferredApiLanguage: "en-GB"
  });

  assert.strictEqual(helper.config.apiLanguage, "de-DE");
  assert.strictEqual(helper.sharedSessionConfig.apiLanguage, "de-DE");
  const registeredAfterLanguage = registeredInstances();
  assert.ok(registeredAfterLanguage.includes("kiosk"));
  assert.ok(registeredAfterLanguage.includes("phone"));

  // A client whose browser hint resolves to the session language must not be
  // reported as drift, even when another session key differs.
  const languageDriftEvents = [];
  helper.sendEventToInstance = (instanceId, action, data) => {
    if (action === "SESSION_CONFIG") {
      languageDriftEvents.push({ instanceId, data });
    }
  };
  helper.handleConfigNotification({
    instanceId: "tablet",
    clientId: "client-1",
    apiLanguage: "",
    preferredApiLanguage: "de-DE",
    enableSSEHeartbeat: false
  });

  assert.deepStrictEqual(languageDriftEvents[0].data.drift.keys, ["enableSSEHeartbeat"]);

  helper.emitInitStatus = originalEmitInitStatus;
  helper.sendEventToInstance = originalSendEventToInstance;

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
