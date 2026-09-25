"use strict";

/*
 * A HomeConnect init that takes too long (MODULE-PLAN HC-F5): the displays get
 * a status and a retry is scheduled; a late answer from a replaced client is
 * discarded instead of flipping the session.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const created = [];
class FakeHomeConnect extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.init = () =>
      new Promise((resolve, reject) => {
        this.finish = resolve;
        this.fail = reject;
      });
    created.push(this);
  }

  destroy() {
    this.destroyed = true;
  }
}

function loadHelper() {
  const hcPath = require.resolve("../lib/homeconnect-api.js");
  require.cache[hcPath] = { id: hcPath, filename: hcPath, loaded: true, exports: FakeHomeConnect };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node_helper") {
      return { create: (definition) => definition };
    }
    if (request.endsWith("module-paths")) {
      const actual = originalLoad.call(this, request, parent, isMain);
      return {
        ...actual,
        refreshTokenPath: path.join(os.tmpdir(), "mmm-homeconnect2-init-timeout-token.json"),
        rateLimitPath: path.join(os.tmpdir(), "mmm-homeconnect2-init-timeout-rate-limit.json"),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const file of ["../node_helper", "../lib/auth-orchestration"]) {
    delete require.cache[require.resolve(file)];
  }
  try {
    return require("../node_helper");
  } finally {
    Module._load = originalLoad;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(t) {
  created.length = 0;
  const helper = loadHelper();
  const statuses = [];
  helper.config = { clientId: "id", clientSecret: "secret" };
  helper.refreshToken = "saved";
  helper.deviceService = null;
  helper.programService = null;
  helper.hcInitTimeoutMs = 20;
  helper.emitInitStatus = (status, payload = {}) => statuses.push({ status, ...payload });
  helper.handleHomeConnectInitSuccess = function success() {
    this.clearHomeConnectInitRetry();
    this.authFlowInProgress = false;
    this.sessionAuthenticated = true;
    statuses.push({ status: "success" });
  };
  t.after(() => {
    // Attempts still pending when the test ends would time out and schedule
    // further retries; stop that chain.
    helper.scheduleHomeConnectInitRetry = () => null;
    helper.clearHomeConnectInitRetry();
  });
  return { helper, statuses };
}

test("an init that takes too long reports hc_error with the retry delay and schedules a retry", async (t) => {
  const { helper, statuses } = setup(t);

  await assert.rejects(helper.initializeHomeConnect("saved"), /timeout after/);

  const status = statuses.find((entry) => entry.status === "hc_error");
  assert.ok(status, "the displays learn that the init failed");
  assert.match(status.message, /timeout/);
  assert.ok(status.retryInSeconds > 0);
  assert.ok(helper.hcInitRetryTimer, "a retry is scheduled");
  assert.equal(helper.authFlowInProgress, false);
});

test("a late success of the current client still opens the session", async (t) => {
  const { helper, statuses } = setup(t);
  await assert.rejects(helper.initializeHomeConnect("saved"));

  created[0].finish();
  await settle();

  assert.equal(helper.sessionAuthenticated, true);
  assert.equal(helper.hcInitRetryTimer, null, "the pending retry is no longer needed");
  assert.ok(statuses.some((entry) => entry.status === "success"));
});

test("a late answer from a client that a retry already replaced is discarded", async (t) => {
  const { helper } = setup(t);
  await assert.rejects(helper.initializeHomeConnect("saved"));
  const stale = created[0];

  // The retry runs and creates the next client.
  helper.initializeHomeConnect("saved").catch(() => {});
  assert.notEqual(helper.hc, stale);

  stale.finish();
  await settle();
  assert.equal(helper.sessionAuthenticated, false, "the stale client does not flip the session");
  assert.equal(stale.destroyed, true, "and does not keep timers or streams");
});

test("an init that fails in time is reported once, not again by the timeout", async (t) => {
  const { helper, statuses } = setup(t);
  helper.hcInitTimeoutMs = 1000;
  const attempt = helper.initializeHomeConnect("saved");
  created[0].fail(new Error("getaddrinfo ENOTFOUND api.home-connect.com"));
  await assert.rejects(attempt, /ENOTFOUND/);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(statuses.filter((entry) => entry.status === "hc_error").length, 1);
});

test("a 429 during init sets the rate-limit block and the retry waits it out", async (t) => {
  const { helper, statuses } = setup(t);
  const fs = require("node:fs");
  t.after(() => fs.rmSync(path.join(os.tmpdir(), "mmm-homeconnect2-init-timeout-rate-limit.json"), { force: true }));
  const delays = [];
  const schedule = helper.scheduleHomeConnectInitRetry;
  helper.scheduleHomeConnectInitRetry = function spy() {
    const delay = schedule.call(this);
    delays.push(delay);
    return delay;
  };
  helper.hcInitTimeoutMs = 1000;

  const attempt = helper.initializeHomeConnect("saved");
  created[0].fail(Object.assign(new Error("HTTP 429 Too Many Requests"), { statusCode: 429, retryAfterSeconds: 120 }));
  await assert.rejects(attempt, /429/);

  assert.ok(helper.isRateLimited(), "the block is recorded");
  assert.ok(delays[0] >= 120 * 1000, `the retry waits for the block, not ${delays[0]} ms`);
  assert.ok(
    statuses.some((entry) => entry.isRateLimit === true),
    "the displays are told about the rate limit",
  );
});
