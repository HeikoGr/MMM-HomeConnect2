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

  // handleTokenError: authorization_pending is a normal polling state, not a warning
  {
    const { service, logs } = createAuthService();
    assert.deepStrictEqual(service.handleTokenError({ error: "authorization_pending" }), { action: "retry" });
    assert.deepStrictEqual(
      logs.filter((entry) => entry.level === "warn" || entry.level === "error"),
      [],
    );
  }

  // pollForToken: an outage of the token endpoint (503, plain text, network) keeps
  // the device code alive - polling goes on and warns once, not per attempt
  {
    const { service, logs } = createAuthService();
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const answers = [
      () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      () =>
        new Response(JSON.stringify({ error_description: "Home Connect subsystem not available" }), { status: 503 }),
      () => new Response("The request timed out", { status: 200 }),
      () => {
        throw new Error("getaddrinfo EAI_AGAIN api.home-connect.com");
      },
      () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 }),
    ];
    globalThis.fetch = async () => answers.shift()();
    globalThis.setTimeout = (fn) => setImmediate(fn);
    try {
      const tokens = await service.pollForToken("id", "", "device-code", 5, 20);
      assert.strictEqual(tokens.refresh_token, "r");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
    const warnings = logs.filter((entry) => entry.level === "warn" || entry.level === "error");
    assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0].message.includes("HTTP 503: Home Connect subsystem not available"));
    assert.ok(logs.some((entry) => entry.message === "Token endpoint reachable again"));
  }

  // Runs fn with fetch answering from `answers` and every timer firing at once; returns the
  // requested delays and the request bodies.
  async function withFakeNetwork(answers, fn) {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const delays = [];
    const bodies = [];
    globalThis.fetch = async (_url, options = {}) => {
      bodies.push(options.body);
      return answers.shift()(options);
    };
    globalThis.setTimeout = (callback, ms) => {
      delays.push(ms);
      setImmediate(callback);
      return 0;
    };
    try {
      return { result: await fn(), delays, bodies };
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
  }
  const json = (body, status) => () => new Response(JSON.stringify(body), { status });

  // pollForToken: slow_down raises the interval to at least 10 s and keeps it for later polls
  {
    const { service } = createAuthService();
    const { result, delays } = await withFakeNetwork(
      [
        json({ error: "slow_down" }, 400),
        json({ error: "authorization_pending" }, 400),
        json({ access_token: "a", refresh_token: "r", expires_in: 60 }, 200),
      ],
      () => service.pollForToken("id", "", "code", 5, 10),
    );
    assert.strictEqual(result.refresh_token, "r");
    // First poll after 5 s, then 10 s (slow_down), and 10 s stays. 15 s are the request timeouts.
    assert.deepStrictEqual(
      delays.filter((ms) => ms !== 15000),
      [5000, 10000, 10000],
    );
  }

  // pollForToken: an expired code and a denied login end the flow and tell the display
  for (const [error, expected] of [
    ["expired_token", "Device code expired - please restart"],
    ["access_denied", "User denied authorization"],
  ]) {
    const { service } = createAuthService();
    const notifications = [];
    await assert.rejects(
      withFakeNetwork([json({ error }, 400)], () =>
        service.pollForToken("id", "", "code", 5, 10, (name, payload) => notifications.push({ name, payload })),
      ),
      (err) => err.message.includes(expected) && err.authReason === error,
    );
    const last = notifications.at(-1);
    assert.strictEqual(last.name, "AUTH_STATUS");
    assert.strictEqual(last.payload.status, "error");
    assert.strictEqual(last.payload.messageKey, error === "expired_token" ? "AUTH_CODE_EXPIRED" : "AUTH_DENIED");
    assert.strictEqual(last.payload.message, expected);
  }

  // pollForToken: an unknown OAuth error ends the flow with its description
  {
    const { service } = createAuthService();
    await assert.rejects(
      withFakeNetwork([json({ error: "invalid_client", error_description: "Unknown client" }, 400)], () =>
        service.pollForToken("id", "", "code", 5, 10),
      ),
      /Token request failed: Unknown client/,
    );
  }

  // pollForToken: gives up after maxAttempts while the user never confirms
  {
    const { service } = createAuthService();
    const pending = Array.from({ length: 3 }, () => json({ error: "authorization_pending" }, 400));
    await assert.rejects(
      withFakeNetwork(pending, () => service.pollForToken("id", "", "code", 5, 3)),
      (err) => /Token polling timeout after 3 attempts/.test(err.message) && err.authReason === "polling_timeout",
    );
  }

  // requestToken: the client secret is sent only when one is configured
  {
    const { service } = createAuthService();
    const ok = () => new Response("{}", { status: 200 });
    const { bodies } = await withFakeNetwork([ok, ok], async () => {
      await service.requestToken("my id", "", "dev code");
      await service.requestToken("my id", "s3cret", "dev code");
    });
    assert.strictEqual(bodies[0], "grant_type=device_code&device_code=dev%20code&client_id=my%20id");
    assert.strictEqual(bodies[1], `${bodies[0]}&client_secret=s3cret`);
  }

  // initiateDeviceFlow: a hanging endpoint ends with ETIMEDOUT instead of blocking the login
  {
    const { service } = createAuthService();
    const hanging = (options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          reject(abort);
        });
      });
    await assert.rejects(
      withFakeNetwork([hanging], () => service.initiateDeviceFlow("id")),
      (err) => err.code === "ETIMEDOUT" && /Request timeout after 15000ms/.test(err.message),
    );
  }

  // headlessAuth: needs a config; shows the QR code and the code to type in, then polls
  {
    const { service } = createAuthService();
    await assert.rejects(service.headlessAuth(), /config not set/);

    service.setConfig({ clientId: "id", clientSecret: "" });
    const notifications = [];
    const { result } = await withFakeNetwork(
      [
        json(
          {
            device_code: "dc",
            user_code: "ABCD-EFGH",
            verification_uri: "https://example.invalid/verify",
            expires_in: 600,
            interval: 5,
          },
          200,
        ),
        json({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 200),
      ],
      () => service.headlessAuth((name, payload) => notifications.push({ name, payload })),
    );
    assert.strictEqual(result.refresh_token, "r");
    const info = notifications.find((entry) => entry.name === "AUTH_INFO").payload;
    assert.strictEqual(info.user_code, "ABCD-EFGH");
    assert.strictEqual(info.verification_uri_complete, "https://example.invalid/verify?user_code=ABCD-EFGH");
    assert.strictEqual(info.expires_in_minutes, 10);
    assert.match(info.verification_qr_svg, /^<svg/);
    assert.strictEqual(notifications.at(-1).payload.status, "success");
  }

  // readRefreshTokenFromFile: trims the stored token, treats an empty or unreadable file as none
  {
    const fs = require("node:fs");
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-auth-"));
    try {
      const file = path.join(dir, "refresh_token.json");
      fs.writeFileSync(file, "  token-value \n");
      assert.strictEqual(
        createAuthService({ refreshTokenPath: file }).service.readRefreshTokenFromFile(),
        "token-value",
      );

      fs.writeFileSync(file, "   ");
      const empty = createAuthService({ refreshTokenPath: file });
      assert.strictEqual(empty.service.readRefreshTokenFromFile(), null);
      assert.ok(empty.logs.some((entry) => entry.level === "warn"));

      // A directory in place of the file cannot be read.
      const unreadable = createAuthService({ refreshTokenPath: dir });
      assert.strictEqual(unreadable.service.readRefreshTokenFromFile(), null);
      assert.ok(unreadable.logs.some((entry) => entry.level === "error"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("auth-service.test.js OK");
})();
