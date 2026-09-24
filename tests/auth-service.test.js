"use strict";

const assert = require("node:assert");
const path = require("node:path");
const AuthService = require("../lib/auth-service");

function createAuthService(overrides = {}) {
  const globalSession = {
    lastAuthAttempt: 0,
    MIN_AUTH_INTERVAL: 60000,
    refreshToken: null,
  };
  const logs = [];
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args) => logs.push({ level, message: args.join(" ") }),
    ]),
  );
  const broadcasts = [];
  const service = new AuthService({
    logger,
    broadcastToAllClients: (n, p) => broadcasts.push({ n, p }),
    setModuleLogLevel: () => {},
    globalSession,
    refreshTokenPath: path.join(__dirname, "fixtures", "missing-refresh-token.json"),
    maxInitAttempts: 1,
    ...overrides,
  });
  return { service, globalSession, logs, broadcasts };
}

(async () => {
  // readRefreshTokenFromFile: returns null when file missing
  {
    const { service } = createAuthService();
    const token = service.readRefreshTokenFromFile();
    assert.strictEqual(token, null);
  }

  // initiateAuthFlow: sets lastAuthAttempt and broadcasts need_auth
  {
    const { service, globalSession, broadcasts } = createAuthService();
    service.initiateAuthFlow();
    assert.ok(globalSession.lastAuthAttempt > 0);
    assert.strictEqual(broadcasts[0].n, "INIT_STATUS");
    assert.strictEqual(broadcasts[0].p.status, "need_auth");
  }

  // initiateDeviceFlow: the OAuth error body becomes one readable line, the code
  // is kept for the caller, and nothing is logged here (the caller logs once)
  {
    const { service, logs } = createAuthService();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized_client", error_description: "Invalid client id" }, null, 2), {
        status: 400,
      });
    try {
      await assert.rejects(service.initiateDeviceFlow("bogus"), (error) => {
        assert.strictEqual(
          error.message,
          "Device authorization failed (HTTP 400): unauthorized_client - Invalid client id",
        );
        assert.strictEqual(error.oauthError, "unauthorized_client");
        return true;
      });

      globalThis.fetch = async () => new Response("Bad Gateway", { status: 502 });
      await assert.rejects(service.initiateDeviceFlow("id"), (error) => {
        assert.strictEqual(error.message, "Device authorization failed (HTTP 502): Bad Gateway");
        assert.strictEqual(error.oauthError, null);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepStrictEqual(
      logs.filter((entry) => entry.level === "error"),
      [],
    );
  }

  console.log("auth-service.test.js OK");
})();
