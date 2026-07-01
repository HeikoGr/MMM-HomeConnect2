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
  helper.hc = null;
  helper.activeProgramFetchInFlight = false;
  helper.activeProgramFetchSignature = null;
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

  helper.transitionSessionState("RESET", {
    reason: "test_reset"
  });
  assert.strictEqual(helper.sessionState, "boot");

  console.log("node-helper-state-machine.test.js OK");
})();
