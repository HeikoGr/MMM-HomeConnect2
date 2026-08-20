"use strict";

// Retry pacing for the two loops that can spend Home Connect quota on their own:
// the token endpoint and the SSE channels. Both used to retry at a fixed
// interval, which turns a 429 into a self-sustaining penalty.

const assert = require("assert");
const modulePath = require.resolve("../lib/homeconnect-api");

function makeFakeEventSource() {
  return {
    listeners: [],
    closed: false,
    addEventListener(type, cb) {
      this.listeners.push([type, cb]);
    },
    removeEventListener() { },
    close() {
      this.closed = true;
    }
  };
}

(async () => {
  // --- token endpoint backoff -------------------------------------------
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        text: async () => "rate limited"
      });

    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    const rateLimitEvents = [];
    hc.on("rateLimit", (payload) => rateLimitEvents.push(payload));

    try {
      await hc.refreshTokens();

      const firstBackoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(
        firstBackoffMs >= 60 * 1000,
        `Expected the first retry to wait at least 60s, got ${firstBackoffMs}ms`
      );
      assert.strictEqual(rateLimitEvents.length, 1, "Expected a rateLimit report on 429");
      assert.strictEqual(rateLimitEvents[0].source, "token");

      // While the window is open other callers must not reach the endpoint.
      const failuresBefore = hc._tokenRefreshFailures;
      await hc.refreshTokens();
      assert.strictEqual(
        hc._tokenRefreshFailures,
        failuresBefore,
        "Expected a suppressed refresh not to hit the token endpoint"
      );

      // A retry firing after the window escalates instead of repeating 60s.
      hc._tokenRefreshBlockedUntil = 0;
      await hc.refreshTokens();
      const secondBackoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(
        secondBackoffMs > firstBackoffMs,
        `Expected escalating backoff, got ${firstBackoffMs}ms then ${secondBackoffMs}ms`
      );

      // ...but the escalation is capped rather than growing without bound.
      for (let i = 0; i < 12; i += 1) {
        hc._tokenRefreshBlockedUntil = 0;
        await hc.refreshTokens();
      }
      assert.ok(
        hc.tokenRefreshBackoffRemainingMs() <= 60 * 60 * 1000 * 1.2,
        `Expected the backoff to stay capped, got ${hc.tokenRefreshBackoffRemainingMs()}ms`
      );
    } finally {
      clearTimeout(hc.tokenRefreshTimeout);
      hc.tokenRefreshTimeout = null;
      globalThis.fetch = originalFetch;
      delete require.cache[modulePath];
    }
  }

  // --- a successful refresh clears the backoff --------------------------
  {
    const originalFetch = globalThis.fetch;
    let failNext = true;
    globalThis.fetch = () => {
      if (failNext) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: { get: () => "30" },
          text: async () => "rate limited"
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600
        }),
        text: async () => ""
      });
    };

    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    hc.recreateEventSources = () => { };

    try {
      await hc.refreshTokens();
      // Retry-After wins over the exponential schedule.
      const backoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(
        backoffMs > 25 * 1000 && backoffMs <= 30 * 1000,
        `Expected Retry-After=30s to drive the backoff, got ${backoffMs}ms`
      );

      failNext = false;
      hc._tokenRefreshBlockedUntil = 0;
      await hc.refreshTokens();

      assert.strictEqual(hc._tokenRefreshFailures, 0, "Expected success to reset the failure count");
      assert.strictEqual(
        hc.tokenRefreshBackoffRemainingMs(),
        0,
        "Expected success to clear the backoff window"
      );
    } finally {
      clearTimeout(hc.tokenRefreshTimeout);
      hc.tokenRefreshTimeout = null;
      globalThis.fetch = originalFetch;
      delete require.cache[modulePath];
    }
  }

  // --- SSE retry: per channel, exponential, reset on a successful open ---
  {
    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");

    const recreates = [];
    hc.scheduleEventSourceRecreate = (delayMs, label) => recreates.push({ delayMs, label });

    hc.eventSources = { "ha-1": makeFakeEventSource(), "ha-2": makeFakeEventSource() };
    hc._deviceEventMonitors = { "ha-1": { attached: false }, "ha-2": { attached: false } };

    const offlineError = { code: 409, message: "Home appliance is offline" };

    hc.handleEventSourceError("device:ha-1", offlineError);
    hc.handleEventSourceError("device:ha-1", offlineError);
    hc.handleEventSourceError("device:ha-1", offlineError);

    assert.deepStrictEqual(
      recreates.map((entry) => entry.delayMs),
      [5000, 10000, 20000],
      "Expected the per-channel delay to double on consecutive failures"
    );
    assert.ok(
      recreates.every((entry) => entry.label === "device:ha-1"),
      "Expected only the failing channel to be scheduled for a rebuild"
    );

    // A different channel starts from the base delay - one bad appliance must
    // not drag healthy channels into its backoff.
    hc.handleEventSourceError("device:ha-2", offlineError);
    assert.strictEqual(recreates.at(-1).delayMs, 5000);
    assert.strictEqual(recreates.at(-1).label, "device:ha-2");

    // A channel that reconnects successfully starts over, so routine stream
    // restarts never escalate.
    hc.resetEventSourceRetryState("device:ha-1");
    hc.handleEventSourceError("device:ha-1", offlineError);
    assert.strictEqual(recreates.at(-1).delayMs, 5000);

    // 429 starts higher and is reported upward for the REST side to honour.
    const rateLimitEvents = [];
    hc.on("rateLimit", (payload) => rateLimitEvents.push(payload));
    hc.resetEventSourceRetryState("device:ha-2");
    hc.handleEventSourceError("device:ha-2", { code: 429, message: "Too Many Requests" });
    assert.strictEqual(recreates.at(-1).delayMs, 30000);
    assert.strictEqual(rateLimitEvents.length, 1);
    assert.strictEqual(rateLimitEvents[0].source, "sse:device:ha-2");

    // The backoff is capped.
    hc.resetEventSourceRetryState("device:ha-1");
    for (let i = 0; i < 20; i += 1) {
      hc.handleEventSourceError("device:ha-1", offlineError);
    }
    assert.strictEqual(recreates.at(-1).delayMs, 10 * 60 * 1000);
  }

  // --- a channel rebuild touches only that channel ----------------------
  {
    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");

    const created = [];
    hc.createEventSource = (url) => {
      created.push(url);
      return makeFakeEventSource();
    };

    const survivor = makeFakeEventSource();
    hc.eventSources = { "ha-1": makeFakeEventSource(), "ha-2": survivor };
    hc.eventListeners = {
      "ha-1": new Map([["NOTIFY", () => { }], ["STATUS", () => { }]]),
      "ha-2": new Map([["NOTIFY", () => { }]])
    };
    hc._deviceEventMonitors = {
      "ha-1": { attached: true, openListener: null, errorListener: null },
      "ha-2": { attached: true, openListener: null, errorListener: null }
    };

    hc.closeEventSourceByLabel("device:ha-1");
    hc.recreateEventSourceByLabel("device:ha-1");

    assert.strictEqual(created.length, 1, "Expected exactly one new stream");
    assert.ok(created[0].includes("ha-1"), `Expected the ha-1 stream, got ${created[0]}`);
    assert.strictEqual(hc.eventSources["ha-2"], survivor, "Expected the healthy channel untouched");
    assert.strictEqual(survivor.closed, false);
    assert.strictEqual(
      hc.eventSources["ha-1"].listeners.filter(([type]) => type === "NOTIFY").length,
      1,
      "Expected the rebuilt channel to carry its listeners again"
    );
  }

  console.log("retry-backoff.test.js OK");
})();
