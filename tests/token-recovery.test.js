"use strict";

/*
 * What happens when the token endpoint misbehaves after a successful start:
 * a rejected refresh token leads to a new login instead of endless retries,
 * a broken token answer cannot cause a refresh loop, concurrent refreshes share
 * one request, and the login resumes after it gave up.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { applyEventToDevice } = require("../lib/device-events");

// The helper deletes the token file on invalid_grant - never the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-homeconnect2-token-recovery-"));
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));
const tokenPath = path.join(tmpDir, "refresh_token.json");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node_helper") {
    return { create: (definition) => definition };
  }
  if (request.endsWith("module-paths")) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      refreshTokenPath: tokenPath,
      rateLimitPath: path.join(tmpDir, "rate_limit.json"),
      runStatePath: path.join(tmpDir, "run_state.json"),
      programStatsPath: path.join(tmpDir, "program_stats.json"),
      legacyStateFiles: [],
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const silent = { debug() {}, info() {}, warn() {}, error() {}, log() {} };
require("../lib/logger").setLogSink(silent);

const modulePath = require.resolve("../lib/homeconnect-api");

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    text: async () => text,
    json: async () => body,
  };
}

// A fresh client module with fetch answered by `respond`; returns the calls made.
function loadClient(respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return respond(calls.length, String(url));
  };
  delete require.cache[modulePath];
  const HomeConnect = require(modulePath);
  const hc = new HomeConnect("client", "", "refresh-1", { logger: silent });
  return { HomeConnect, hc, calls };
}

// The delay of the token refresh timer the client planned, in seconds.
function plannedDelaySeconds(hc) {
  return hc.tokenRefreshTimeout ? hc.tokenRefreshTimeout._idleTimeout / 1000 : null;
}

// MagicMirror's hideConfigSecrets placeholder, as the browser sends it.
const SECRET_PLACEHOLDER = ["$", "{SECRET_HC}"].join("");
const VALID = { access_token: "access-1", refresh_token: "refresh-2", expires_in: 86400 };
const originalFetch = globalThis.fetch;

(async () => {
  // --- the token answer is validated --------------------------------------
  for (const [label, body, expected] of [
    ["no expires_in", { access_token: "a", refresh_token: "r" }, { refresh: "r", minDelay: 60 }],
    ["expires_in 0", { access_token: "a", refresh_token: "r", expires_in: 0 }, { refresh: "r", minDelay: 60 }],
    [
      "expires_in as text",
      { access_token: "a", refresh_token: "r", expires_in: "soon" },
      { refresh: "r", minDelay: 60 },
    ],
    ["no refresh_token", { access_token: "a", expires_in: 3600 }, { refresh: "refresh-1", minDelay: 60 }],
    ["very short lifetime", { access_token: "a", refresh_token: "r", expires_in: 5 }, { refresh: "r", minDelay: 60 }],
  ]) {
    const { hc } = loadClient(() => jsonResponse(200, body));
    const saved = [];
    hc.on("newRefreshToken", (token) => saved.push(token));
    await hc.init();
    const delay = plannedDelaySeconds(hc);
    assert.ok(delay >= expected.minDelay, `${label}: refresh planned after ${delay}s`);
    assert.ok(delay <= 24 * 60 * 60, `${label}: refresh planned after ${delay}s`);
    assert.deepStrictEqual(saved, [expected.refresh], `${label}: saved refresh token`);
    assert.ok(Number.isFinite(hc.tokens.expires_in) && hc.tokens.expires_in > 0, label);
    hc.destroy();
  }

  // An answer without access_token is an error: nothing is saved, a retry is planned.
  {
    let call = 0;
    const { hc } = loadClient(() => {
      call += 1;
      return jsonResponse(200, call === 1 ? VALID : { refresh_token: "r", expires_in: 3600 });
    });
    const saved = [];
    await hc.init();
    hc.on("newRefreshToken", (token) => saved.push(token));
    assert.strictEqual(await hc.refreshTokens(), false);
    assert.deepStrictEqual(saved, []);
    assert.strictEqual(hc.tokens.access_token, "access-1");
    assert.ok(plannedDelaySeconds(hc) >= 60);
    hc.destroy();
  }

  // --- invalid_grant while running ----------------------------------------
  {
    const { hc, calls } = loadClient((n) =>
      n === 1
        ? jsonResponse(200, VALID)
        : jsonResponse(400, { error: "invalid_grant", error_description: "refresh token expired" }),
    );
    const authInvalid = [];
    hc.on("authInvalid", (err) => authInvalid.push(err));
    await hc.init();
    assert.strictEqual(await hc.refreshTokens(), false);
    assert.strictEqual(authInvalid.length, 1);
    assert.strictEqual(authInvalid[0].oauthError, "invalid_grant");
    assert.strictEqual(authInvalid[0].statusCode, 400);
    assert.strictEqual(hc.tokenRefreshTimeout, null, "no retry with a rejected token");
    assert.strictEqual(calls.length, 2);
  }

  // A 5xx or a network error only backs off.
  for (const failure of [
    () => jsonResponse(503, { error: "unavailable" }),
    () => Promise.reject(new Error("ECONNRESET")),
  ]) {
    const { hc } = loadClient((n) => (n === 1 ? jsonResponse(200, VALID) : failure()));
    const authInvalid = [];
    hc.on("authInvalid", (err) => authInvalid.push(err));
    await hc.init();
    assert.strictEqual(await hc.refreshTokens(), false);
    assert.deepStrictEqual(authInvalid, []);
    assert.ok(plannedDelaySeconds(hc) >= 60, "a retry is planned");
    hc.destroy();
  }

  // Concurrent refreshes share one request.
  {
    const { hc, calls } = loadClient(() => jsonResponse(200, VALID));
    await hc.init();
    const results = await Promise.all([hc.refreshTokens(), hc.refreshTokens(), hc.refreshTokens()]);
    assert.deepStrictEqual(results, [true, true, true]);
    assert.strictEqual(calls.length, 2, "init plus one shared refresh");
    hc.destroy();
  }

  // A status code is taken from the error, never from the message ("...:443" is no status).
  {
    const { hc } = loadClient(() => jsonResponse(200, VALID));
    assert.strictEqual(hc.extractStatusCode(new Error("connect ECONNREFUSED 1.2.3.4:443")), null);
    assert.strictEqual(hc.extractStatusCode({ statusCode: 429 }), 429);
  }

  // --- API values in paths and as keys ------------------------------------
  {
    const { hc, calls } = loadClient(() => jsonResponse(200, { ...VALID, data: {} }));
    await hc.init();
    await hc.getStatus("SIEMENS/../x?y=1#z");
    const url = calls.at(-1).url;
    assert.ok(url.endsWith("api/homeappliances/SIEMENS%2F..%2Fx%3Fy%3D1%23z/status"), url);

    const device = { name: "Washer" };
    for (const key of ["__proto__", "constructor", "prototype"]) {
      applyEventToDevice(device, { key, value: { polluted: true } });
    }
    assert.strictEqual(Object.getPrototypeOf(device), Object.prototype);
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.hasOwn(device, "constructor"), false);
    assert.strictEqual(device.connected, undefined, "an ignored event does not mark the device as seen");
    hc.destroy();
  }

  // --- the helper starts a new login --------------------------------------
  const helper = require("../node_helper");
  Module._load = originalLoad;

  function prepareHelper() {
    const events = [];
    helper.emitInitStatus = (status) => events.push(`init:${status}`);
    helper.emitAuthStatus = (status) => events.push(`auth:${status}`);
    helper.setRateLimitUntil = () => 0;
    helper.globalSession = helper.globalSession || {};
    helper.initializationAttempts = 0;
    helper.authFlowInProgress = false;
    helper.authGaveUp = false;
    helper.lastAuthFailure = null;
    helper.sessionAuthenticated = true;
    const headlessStarts = [];
    helper.initWithHeadlessAuth = async () => {
      headlessStarts.push(Date.now());
    };
    return { events, headlessStarts };
  }

  // invalid_grant reported by the running client: old client gone, token deleted, one new login.
  {
    const { events, headlessStarts } = prepareHelper();
    fs.writeFileSync(tokenPath, "refresh-old");
    const { hc } = loadClient((n) =>
      n === 1 ? jsonResponse(200, VALID) : jsonResponse(400, { error: "invalid_grant" }),
    );
    await hc.init();
    let destroyed = 0;
    const originalDestroy = hc.destroy.bind(hc);
    hc.destroy = () => {
      destroyed += 1;
      originalDestroy();
    };
    const shutdowns = [];
    helper.deviceService = { shutdown: () => shutdowns.push("shutdown"), attachClient: (c) => shutdowns.push(c) };
    helper.programService = { attachClient: () => {} };
    helper.hc = hc;
    helper.setupHomeConnectRefreshToken();

    await hc.refreshTokens();
    assert.strictEqual(helper.hc, null);
    assert.strictEqual(helper.sessionAuthenticated, false);
    assert.strictEqual(destroyed, 1);
    assert.deepStrictEqual(shutdowns, ["shutdown", null]);
    assert.strictEqual(hc.tokenRefreshTimeout, null);
    assert.strictEqual(fs.existsSync(tokenPath), false);
    assert.deepStrictEqual(events, ["init:reauth_required", "auth:token_invalid"]);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.strictEqual(headlessStarts.length, 1, "exactly one new login");
  }

  // At init the same path runs, decided on the error field.
  {
    const { events } = prepareHelper();
    helper.restartAuthentication = function spy() {
      events.push("restart");
    };
    helper.handleHomeConnectInitError(Object.assign(new Error("HTTP 400"), { oauthError: "invalid_grant" }));
    // Only the text, no field: an ordinary failure with retry.
    helper.scheduleHomeConnectInitRetry = () => null;
    helper.isRateLimited = () => false;
    helper.handleHomeConnectInitError(new Error("something mentioning invalid_grant"));
    assert.deepStrictEqual(events, ["restart", "init:hc_error"]);
    delete helper.restartAuthentication;
    delete helper.scheduleHomeConnectInitRetry;
    delete helper.isRateLimited;
  }

  // --- the login resumes after it gave up ---------------------------------
  {
    const { events, headlessStarts } = prepareHelper();
    helper.hc = null;
    helper.sessionAuthenticated = false;
    helper.maxInitAttempts = 3;
    helper.initializationAttempts = 3;
    helper.globalSession.lastAuthAttempt = 0;
    helper.globalSession.MIN_AUTH_INTERVAL = 1000;
    helper.handleHeadlessAuthError(new Error("expired_token"));
    assert.strictEqual(helper.authGaveUp, true);
    assert.deepStrictEqual(events, ["auth:error", "init:auth_failed"]);

    helper.handleConfigNotificationSubsequent("module_1_MMM-HomeConnect2");
    assert.strictEqual(headlessStarts.length, 1, "a display that connects starts a new login");
    assert.strictEqual(helper.initializationAttempts, 0);
    assert.strictEqual(helper.authGaveUp, false);

    // An error without a message does not crash the handler.
    helper.initializationAttempts = 0;
    helper.headlessAuthRetryTimer = null;
    helper.handleHeadlessAuthError({});
    clearTimeout(helper.headlessAuthRetryTimer);
    assert.strictEqual(helper.lastAuthFailure.messageKey, undefined, "no reason, no key: English text stays");

    // A known reason carries a translation key for the display, next to the English message.
    helper.headlessAuthRetryTimer = null;
    const expired = new Error("❌ Device code expired - please restart");
    expired.authReason = "expired_token";
    helper.handleHeadlessAuthError(expired);
    clearTimeout(helper.headlessAuthRetryTimer);
    assert.strictEqual(helper.lastAuthFailure.messageKey, "AUTH_CODE_EXPIRED");
    assert.match(helper.lastAuthFailure.message, /^Authentication failed: /);
    assert.strictEqual(helper.lastAuthFailure.reason, undefined, "retried or resumed on reload: no restart hint");

    // Polling too quickly: no retry follows, so the display must say that a restart is needed.
    helper.headlessAuthRetryTimer = null;
    helper.handleHeadlessAuthError(new Error("polling too quickly"));
    assert.strictEqual(helper.headlessAuthRetryTimer, null, "no automatic retry");
    assert.strictEqual(helper.lastAuthFailure.reason, "rate_limited");
  }

  // --- the server config wins over the browser ----------------------------
  {
    prepareHelper();
    helper.name = "MMM-HomeConnect2";
    helper.sessionOwnerConfig = null;
    helper.sessionAuthenticated = false;
    helper.hc = null;
    helper.globalSession.clientInstances = new Set();
    helper.handleConfigNotificationFirstTime = () => {};
    const authConfigs = [];
    helper.authService = { setConfig: (config) => authConfigs.push(config) };
    globalThis.config = {
      language: "en",
      modules: [{ module: "MMM-HomeConnect2", config: { clientId: "id", clientSecret: "server-secret" } }],
    };
    globalThis.configRedacted = {
      language: "en",
      modules: [{ module: "MMM-HomeConnect2", config: { clientId: "id", clientSecret: SECRET_PLACEHOLDER } }],
    };
    helper.handleConfigNotification({
      identifier: "module_0_MMM-HomeConnect2",
      clientId: "id",
      clientSecret: SECRET_PLACEHOLDER,
      language: "en",
    });
    assert.strictEqual(helper.config.clientSecret, "server-secret", "the API client uses the server value");
    assert.strictEqual(authConfigs[0].clientSecret, "server-secret");
    delete globalThis.config;
    delete globalThis.configRedacted;
  }

  globalThis.fetch = originalFetch;
  console.log("token-recovery tests passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
