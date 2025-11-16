"use strict";

const assert = require("assert");
const AuthService = require("../lib/auth-service");

function createAuthService(overrides = {}) {
  const globalSession = {
    lastAuthAttempt: 0,
    MIN_AUTH_INTERVAL: 60000,
    isAuthenticating: false,
    refreshToken: null
  };
  const logs = [];
  const logger = (level, ...args) => {
    logs.push({ level, message: args.join(" ") });
  };
  const broadcasts = [];
  const service = new AuthService({
    logger,
    broadcastToAllClients: (n, p) => broadcasts.push({ n, p }),
    setModuleLogLevel: () => {},
    globalSession,
    maxInitAttempts: 1,
    ...overrides
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

  // checkRateLimit: first call ok, second within interval returns false
  {
    const { service, globalSession } = createAuthService();
    globalSession.lastAuthAttempt = Date.now() - 30000;
    const ok = service.checkRateLimit();
    assert.strictEqual(ok, false);
  }

  // initiateAuthFlow: sets lastAuthAttempt and broadcasts need_auth
  {
    const { service, globalSession, broadcasts } = createAuthService();
    service.initiateAuthFlow();
    assert.ok(globalSession.lastAuthAttempt > 0);
    assert.strictEqual(broadcasts[0].n, "INIT_STATUS");
    assert.strictEqual(broadcasts[0].p.status, "need_auth");
  }

  console.log("auth-service.test.js OK");
})();
