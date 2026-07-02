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
  helper.activeProgramFetchInFlight = false;
  helper.activeProgramFetchSignature = null;
  helper.recentForcedProgramFetch = null;
  helper.setRateLimitUntil(0);
  if (helper.rateLimitReleaseTimer) {
    clearTimeout(helper.rateLimitReleaseTimer);
    helper.rateLimitReleaseTimer = null;
  }
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

  await wait(70);
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

  // Forced state refresh should fetch active programs only after refreshed device data arrived.
  resetHelperState();
  const sequence = [];
  helper.hc = {};
  helper.sessionState = "ready";
  helper.instanceId = "test-instance";
  helper.deviceService = {
    devices: new Map([["ha-1", { haId: "ha-1", name: "Washer" }]]),
    subscribed: false,
    heartbeatStale: true,
    getDevices(callback) {
      sequence.push("device_refresh_start");
      callback("MMM-HomeConnect_Update", [{ haId: "ha-1", name: "Washer" }]);
    }
  };
  helper.sendSocketNotification = (notification) => {
    if (notification === "MMM-HomeConnect_Update") {
      sequence.push("device_update_sent");
    }
  };
  const originalHandleGetActivePrograms = helper.handleGetActivePrograms;
  helper.handleGetActivePrograms = (payload = {}) => {
    sequence.push(`program_fetch:${payload.instanceId || "unknown"}`);
  };

  helper.handleStateRefreshRequest({
    instanceId: "test-instance",
    forceRefresh: true,
    bypassActiveProgramThrottle: true,
    haIds: ["ha-1"]
  });

  assert.deepStrictEqual(sequence, [
    "device_refresh_start",
    "device_update_sent",
    "program_fetch:test-instance"
  ]);

  helper.handleGetActivePrograms = originalHandleGetActivePrograms;

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

  // Initial device fetch after HomeConnect init should start immediately without a timer delay.
  resetHelperState();
  helper.hc = {};
  helper.deviceService = {
    getDevices(callback) {
      immediateGetDevicesCalls += 1;
      callback("MMM-HomeConnect_Update", []);
    }
  };
  helper.sendSocketNotification = () => { };
  helper.emitInitStatus = () => { };
  immediateGetDevicesCalls = 0;

  helper.handleHomeConnectInitSuccess();

  assert.strictEqual(immediateGetDevicesCalls, 1);

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

  helper.transitionSessionState("RESET", {
    reason: "test_reset"
  });
  assert.strictEqual(helper.sessionState, "boot");

  console.log("node-helper-state-machine.test.js OK");
})();
