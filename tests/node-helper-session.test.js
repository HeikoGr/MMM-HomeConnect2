"use strict";

const assert = require("assert");
const Module = require("module");
const os = require("os");
const path = require("path");

// retryAuthentication() deletes the refresh token file. Redirect that path into a
// temp directory so running the tests never touches a real Home Connect session.
const testRefreshTokenPath = path.join(os.tmpdir(), "mmm-homeconnect2-test-refresh-token.json");

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
  helper.sessionAuthenticated = false;
  helper.authFlowInProgress = false;
  helper.deviceRefreshInFlight = false;
  helper.programFetchInFlight = false;
  helper.debugStats = {
    lastApiCallTs: null,
    lastSseEventTs: null,
    lastSseTrafficTs: null,
    apiCounters: {}
  };
  helper.lastDebugStatsBroadcastTs = 0;
  helper.hc = null;
  helper.instanceId = null;
  helper.sharedConfigOwnerInstanceId = null;
  helper.sessionOwnerConfig = null;
  helper.activeProgramFetchInFlight = false;
  helper.activeProgramFetchSignature = null;
  helper.recentForcedProgramFetch = null;
  if (helper.fullSnapshotTimer) {
    clearInterval(helper.fullSnapshotTimer);
    helper.fullSnapshotTimer = null;
  }
  helper.setRateLimitUntil(0);
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

  // Session lifecycle flags: a fresh helper is neither authenticated nor busy.
  assert.strictEqual(helper.isSessionAuthenticated(), false);
  assert.strictEqual(helper.isAuthFlowInProgress(), false);

  // Rate limiting is derived from the deadline alone - no state to get out of sync.
  assert.strictEqual(helper.isRateLimited(), false);

  helper.setRateLimitUntil(Date.now() + 30);
  assert.strictEqual(helper.isRateLimited(), true);

  await wait(40);
  assert.strictEqual(
    helper.isRateLimited(),
    false,
    "An elapsed rate limit must clear itself without a release timer"
  );

  helper.setRateLimitUntil(Date.now() + 30);
  assert.strictEqual(helper.isRateLimited(), true);
  helper.setRateLimitUntil(0);
  assert.strictEqual(helper.isRateLimited(), false);

  // Debug stats record the latest traffic timestamps and API counts.
  resetHelperState();
  const originalDateNow = Date.now;
  const originalBroadcastDebugStats = helper.broadcastDebugStats;
  const fakeTimes = [1000, 1600, 2200, 2300];
  Date.now = () => fakeTimes.shift();
  helper.broadcastDebugStats = () => { };

  helper.recordSseEvent();
  helper.recordSseKeepAlive();
  helper.recordApiCall("homeappliances");
  helper.recordApiCall("homeappliances");

  Date.now = originalDateNow;

  assert.strictEqual(helper.debugStats.lastSseEventTs, 1000);
  assert.strictEqual(helper.debugStats.lastSseTrafficTs, 1600);
  assert.strictEqual(helper.debugStats.lastApiCallTs, 2300);
  assert.deepStrictEqual(helper.debugStats.apiCounters, { homeappliances: 2 });

  // Broadcasts are throttled so a busy SSE stream cannot re-render every client
  // per event - but a forced call (a client that just connected) always goes out.
  resetHelperState();
  helper.broadcastDebugStats = originalBroadcastDebugStats;
  let debugBroadcasts = 0;
  const originalBroadcastToAllClients = helper.broadcastToAllClients;
  helper.broadcastToAllClients = (notification) => {
    if (notification === "DEBUG_STATS") {
      debugBroadcasts += 1;
    }
  };

  helper.recordSseEvent();
  helper.recordSseEvent();
  helper.recordSseEvent();
  assert.strictEqual(debugBroadcasts, 1, "Bursts of events must collapse into one broadcast");

  helper.broadcastDebugStats(true);
  assert.strictEqual(debugBroadcasts, 2, "A forced broadcast must ignore the throttle");

  helper.broadcastToAllClients = originalBroadcastToAllClients;

  // SSE stale should rebuild subscriptions and then perform one full resync.
  resetHelperState();
  helper.hc = {};
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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
  helper.sessionAuthenticated = true;
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

  // Foreign credentials are rejected; every other config difference only keeps the
  // client connected against the session's settings (and is logged).
  resetHelperState();
  const authConfigs = [];
  const deviceConfigs = [];
  const acceptLanguages = [];
  const configuredInstances = [];
  const configMismatchStatuses = [];
  const ignoredConfigWarnings = [];
  const originalEmitInitStatus = helper.emitInitStatus;
  const originalWarnAboutIgnoredSessionConfig = helper.warnAboutIgnoredSessionConfig;
  helper.emitInitStatus = (status, payload = {}) => {
    if (payload.isConfigMismatch) {
      configMismatchStatuses.push({ status, payload });
    }
  };
  helper.warnAboutIgnoredSessionConfig = function patched(instanceId, clientSessionConfig) {
    ignoredConfigWarnings.push(instanceId);
    return originalWarnAboutIgnoredSessionConfig.call(this, instanceId, clientSessionConfig);
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

  // Display-only options must not be reported as ignored session settings.
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

  // Session-relevant difference: the client stays registered, its values are ignored.
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
  assert.strictEqual(helper.sessionOwnerConfig.minActiveProgramIntervalMs, 1111);
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

  // Every accepted late client is checked, and only real differences are logged.
  assert.deepStrictEqual(ignoredConfigWarnings, ["frontend-b", "frontend-c"]);

  // A browser-derived language only fills the gap when nothing is configured.
  resetHelperState();
  helper.emitInitStatus = () => { };
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
  assert.strictEqual(helper.sessionOwnerConfig.apiLanguage, "de-DE");
  const registeredAfterLanguage = registeredInstances();
  assert.ok(registeredAfterLanguage.includes("kiosk"));
  assert.ok(registeredAfterLanguage.includes("phone"));

  // A client whose browser hint resolves to the session language must not be
  // reported as ignored, even when another session key differs.
  const languageDriftKeys = [];
  helper.warnAboutIgnoredSessionConfig = function patched(_instanceId, clientSessionConfig) {
    languageDriftKeys.push(
      Object.keys(clientSessionConfig).filter(
        (key) => this.sessionOwnerConfig[key] !== clientSessionConfig[key]
      )
    );
  };
  helper.handleConfigNotification({
    instanceId: "tablet",
    clientId: "client-1",
    apiLanguage: "",
    preferredApiLanguage: "de-DE",
    enableSSEHeartbeat: false
  });

  assert.deepStrictEqual(languageDriftKeys[0], ["instanceId", "enableSSEHeartbeat"]);

  helper.emitInitStatus = originalEmitInitStatus;
  helper.warnAboutIgnoredSessionConfig = originalWarnAboutIgnoredSessionConfig;

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

  assert.strictEqual(
    helper.isSessionAuthenticated(),
    false,
    "retryAuthentication() must drop the authenticated session"
  );
  assert.strictEqual(helper.isAuthFlowInProgress(), false);

  console.log("node-helper-session.test.js OK");
})();
