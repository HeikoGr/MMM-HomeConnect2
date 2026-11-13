"use strict";

// Retry pacing for the two loops that can spend Home Connect quota on their own:
// the token endpoint and the SSE channels. Both back off exponentially; a fixed
// interval would turn a 429 into a self-sustaining penalty.

const assert = require("node:assert");
const modulePath = require.resolve("../lib/homeconnect-api");

function makeFakeEventSource() {
  return {
    listeners: [],
    closed: false,
    addEventListener(type, cb) {
      this.listeners.push([type, cb]);
    },
    removeEventListener() {},
    close() {
      this.closed = true;
    },
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
        text: async () => "rate limited",
      });

    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    const rateLimitEvents = [];
    hc.on("rateLimit", (payload) => rateLimitEvents.push(payload));

    try {
      await hc.refreshTokens();

      // Remaining time, read a moment after the block was set: allow a little clock drift, the
      // point is "about a minute" rather than a fixed retry of a few seconds.
      const firstBackoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(firstBackoffMs >= 59 * 1000, `Expected the first retry to wait about 60s, got ${firstBackoffMs}ms`);
      assert.strictEqual(rateLimitEvents.length, 1, "Expected a rateLimit report on 429");
      assert.strictEqual(rateLimitEvents[0].source, "token");

      // While the window is open other callers must not reach the endpoint.
      const failuresBefore = hc._tokenRefreshFailures;
      await hc.refreshTokens();
      assert.strictEqual(
        hc._tokenRefreshFailures,
        failuresBefore,
        "Expected a suppressed refresh not to hit the token endpoint",
      );

      // A retry firing after the window escalates instead of repeating 60s.
      hc._tokenRefreshBlockedUntil = 0;
      await hc.refreshTokens();
      const secondBackoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(
        secondBackoffMs > firstBackoffMs,
        `Expected escalating backoff, got ${firstBackoffMs}ms then ${secondBackoffMs}ms`,
      );

      // ...but the escalation is capped rather than growing without bound.
      for (let i = 0; i < 12; i += 1) {
        hc._tokenRefreshBlockedUntil = 0;
        await hc.refreshTokens();
      }
      assert.ok(
        hc.tokenRefreshBackoffRemainingMs() <= 60 * 60 * 1000 * 1.2,
        `Expected the backoff to stay capped, got ${hc.tokenRefreshBackoffRemainingMs()}ms`,
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
          text: async () => "rate limited",
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        text: async () => "",
      });
    };

    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");

    try {
      await hc.refreshTokens();
      // Retry-After wins over the exponential schedule.
      const backoffMs = hc.tokenRefreshBackoffRemainingMs();
      assert.ok(
        backoffMs > 25 * 1000 && backoffMs <= 30 * 1000,
        `Expected Retry-After=30s to drive the backoff, got ${backoffMs}ms`,
      );

      failNext = false;
      hc._tokenRefreshBlockedUntil = 0;
      // Open streams survive a token refresh: they read the new token on their
      // next connect, reopening them would cost a request each and lose events.
      let closedStreams = 0;
      const openStream = {
        close() {
          closedStreams += 1;
        },
      };
      hc.eventSources = { "ha-1": openStream };
      await hc.refreshTokens();
      assert.strictEqual(closedStreams, 0, "Expected the token refresh to leave open SSE streams alone");
      assert.strictEqual(hc.eventSources["ha-1"], openStream);
      hc.eventSources = {};

      assert.strictEqual(hc._tokenRefreshFailures, 0, "Expected success to reset the failure count");
      assert.strictEqual(hc.tokenRefreshBackoffRemainingMs(), 0, "Expected success to clear the backoff window");
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
      "Expected the per-channel delay to double on consecutive failures",
    );
    assert.ok(
      recreates.every((entry) => entry.label === "device:ha-1"),
      "Expected only the failing channel to be scheduled for a rebuild",
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

    // A bare 429 starts higher but stays with its channel: without a stated
    // block it says nothing about the quota.
    const rateLimitEvents = [];
    hc.on("rateLimit", (payload) => rateLimitEvents.push(payload));
    hc.resetEventSourceRetryState("device:ha-2");
    hc.handleEventSourceError("device:ha-2", { code: 429, message: "Too Many Requests" });
    assert.strictEqual(recreates.at(-1).delayMs, 30000);
    assert.strictEqual(rateLimitEvents.length, 0, "Expected a bare channel 429 not to block the whole module");

    // ...and it keeps backing off past the 10-minute cap of ordinary errors.
    for (let i = 0; i < 20; i += 1) {
      hc.handleEventSourceError("device:ha-2", { code: 429, message: "Too Many Requests" });
    }
    assert.strictEqual(recreates.at(-1).delayMs, 60 * 60 * 1000);
    assert.strictEqual(rateLimitEvents.length, 0);

    // A block the server states (read from the 429 response) is honoured in full,
    // beyond every cap, and reported upward for the REST side.
    hc.resetEventSourceRetryState("device:ha-2");
    hc._eventSourceRateLimitInfo.set("device:ha-2", { retryAfterSeconds: 7200, description: "1000 calls in 1 day" });
    hc.handleEventSourceError("device:ha-2", { code: 429, message: "Too Many Requests" });
    assert.strictEqual(recreates.at(-1).delayMs, 7200 * 1000);
    assert.strictEqual(rateLimitEvents.length, 1);
    assert.strictEqual(rateLimitEvents[0].source, "sse:device:ha-2");
    assert.strictEqual(rateLimitEvents[0].retryAfterSeconds, 7200);
    assert.strictEqual(hc._eventSourceRateLimitInfo.has("device:ha-2"), false, "Expected the info to be used once");

    // A stale entry does not turn a later non-429 error into a long wait.
    hc.resetEventSourceRetryState("device:ha-2");
    hc._eventSourceRateLimitInfo.set("device:ha-2", { retryAfterSeconds: 7200, description: null });
    hc.handleEventSourceError("device:ha-2", offlineError);
    assert.strictEqual(recreates.at(-1).delayMs, 5000);
    assert.strictEqual(rateLimitEvents.length, 1);

    // The backoff is capped.
    hc.resetEventSourceRetryState("device:ha-1");
    for (let i = 0; i < 20; i += 1) {
      hc.handleEventSourceError("device:ha-1", offlineError);
    }
    assert.strictEqual(recreates.at(-1).delayMs, 10 * 60 * 1000);
  }

  // --- the monitoring channel limit stays with the channel ---------------
  {
    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    const messages = [];
    hc.log = {
      debug() {},
      info() {},
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
    };

    const recreates = [];
    hc.scheduleEventSourceRecreate = (delayMs, label) => recreates.push({ delayMs, label });
    hc.eventSources = { "ha-1": makeFakeEventSource() };
    hc._deviceEventMonitors = { "ha-1": { attached: false } };
    const rateLimitEvents = [];
    hc.on("rateLimit", (payload) => rateLimitEvents.push(payload));

    const refuse = (info) => {
      hc._eventSourceRateLimitInfo.set("device:ha-1", info);
      hc.handleEventSourceError("device:ha-1", { code: 429, message: "Non-200 status code (429)" });
      return recreates.at(-1).delayMs;
    };
    const channelLimit = {
      retryAfterSeconds: 600,
      description: "Too many parallel monitoring connections. Maximum is 10",
      errorKey: "429",
      limitType: "event",
    };

    // The constant Retry-After is the floor; the backoff grows past it up to the cap.
    const delays = [];
    for (let i = 0; i < 10; i += 1) {
      delays.push(refuse(channelLimit) / 1000);
    }
    assert.deepStrictEqual(delays, [600, 600, 600, 600, 600, 960, 1920, 3600, 3600, 3600]);
    assert.strictEqual(rateLimitEvents.length, 0, "Expected the channel limit not to block the module");
    assert.ok(messages.some((message) => message.includes("retry-after=600s; type=event; key=429")));
    assert.ok(messages.some((message) => message.includes("monitoring channel limit reached")));
    assert.strictEqual(hc.getEventSourceRetryState("device:ha-1").channelLimit, true);

    // A successful open starts over.
    hc.resetEventSourceRetryState("device:ha-1");
    assert.strictEqual(hc.getEventSourceRetryState("device:ha-1").channelLimit, false);
    assert.strictEqual(refuse(channelLimit), 600 * 1000);

    // A longer stated wait is honoured beyond the cap.
    assert.strictEqual(refuse({ ...channelLimit, retryAfterSeconds: 7200 }), 7200 * 1000);

    // The text alone is enough, in case the header goes away.
    assert.strictEqual(refuse({ ...channelLimit, limitType: null }), 600 * 1000);
    assert.strictEqual(rateLimitEvents.length, 0);

    // Any other stated block still holds for every request.
    hc.resetEventSourceRetryState("device:ha-1");
    refuse({ retryAfterSeconds: 52, description: "5 start program calls in 1 minute", limitType: "time" });
    assert.strictEqual(rateLimitEvents.length, 1);
    assert.strictEqual(rateLimitEvents[0].retryAfterSeconds, 52);

    // A stream the server ended reports an event without a message.
    messages.length = 0;
    hc.handleEventSourceError("device:ha-1", new Event("error"));
    assert.ok(messages.some((message) => message.includes("stream ended by the server")));
    assert.ok(!messages.some((message) => message.includes("[object")));
  }

  // --- a pending retry must not leave a second stream open ----------------
  {
    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    const created = [];
    hc.createEventSource = () => {
      const source = makeFakeEventSource();
      created.push(source);
      return source;
    };
    const listener = () => {};

    hc.subscribeDevice("ha-1", "NOTIFY", listener);
    hc.handleEventSourceError("device:ha-1", { code: 503, message: "Non-200 status code (503)" });
    assert.ok(hc.getEventSourceRetryState("device:ha-1").timer, "Expected a retry to be pending");

    // The watchdog rebuild closes the channels and opens them again...
    hc.closeEventSources();
    assert.strictEqual(hc.getEventSourceRetryState("device:ha-1").timer, null, "Expected the retry to be dropped");
    assert.strictEqual(hc.getEventSourceRetryState("device:ha-1").retryAt, null);

    hc.subscribeDevice("ha-1", "NOTIFY", listener);
    const live = created.at(-1);
    hc.recreateEventSourceByLabel("device:ha-1");
    assert.strictEqual(live.closed, true, "Expected a replaced stream to be closed");
    assert.notStrictEqual(hc.eventSources["ha-1"], live);

    // Open streams are counted per stream, also those nothing references any more.
    const streams = [{ readyState: 1 }, { readyState: 0 }, { readyState: 2 }];
    hc._eventSourceStreams = new Set(streams);
    assert.strictEqual(hc.countOpenEventSources(), 1);
    assert.strictEqual(hc._eventSourceStreams.size, 2, "Expected closed streams to be forgotten");

    hc.closeEventSources();
    hc.resetEventSourceRetryState("device:ha-1");
    hc.eventSources = { "ha-1": { readyState: 1 }, "ha-2": { readyState: 2 } };
    const retrying = hc.getEventSourceRetryState("device:ha-2");
    retrying.attempts = 3;
    retrying.retryAt = 12345;
    retrying.channelLimit = true;
    assert.deepStrictEqual(hc.getEventSourceStates(), [
      { label: "device:ha-1", open: true, attempts: 0, retryAt: null, channelLimit: false },
      { label: "device:ha-2", open: false, attempts: 3, retryAt: 12345, channelLimit: true },
    ]);
    hc.destroy();
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
      "ha-1": new Map([
        ["NOTIFY", () => {}],
        ["STATUS", () => {}],
      ]),
      "ha-2": new Map([["NOTIFY", () => {}]]),
    };
    hc._deviceEventMonitors = {
      "ha-1": { attached: true, openListener: null, errorListener: null },
      "ha-2": { attached: true, openListener: null, errorListener: null },
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
      "Expected the rebuilt channel to carry its listeners again",
    );
  }

  // --- a 429 on opening a stream is read before the EventSource sees it ---
  {
    const originalFetch = globalThis.fetch;
    const answers = [
      new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }),
      new Response(
        JSON.stringify({
          error: {
            key: "429",
            description:
              'The rate limit "10 successive error calls in 10 minutes" was reached. Requests are blocked during the remaining period of 557 seconds.',
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
      new Response("", { status: 429 }),
      new Response(
        JSON.stringify({
          error: { key: "429", description: "Too many parallel monitoring connections. Maximum is 10" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "600", "rate-limit-type": "event" },
        },
      ),
    ];
    globalThis.fetch = async () => answers.shift();

    delete require.cache[modulePath];
    const HomeConnect = require(modulePath);
    const hc = new HomeConnect("client", "secret", "refresh");
    hc.tokens = { access_token: "at" };

    const openAndFail = (label) =>
      new Promise((resolve) => {
        const source = hc.createEventSource("https://example.invalid/events", label);
        source.addEventListener("error", (err) => {
          source.close();
          resolve(err);
        });
      });

    try {
      const err = await openAndFail("device:ha-1");
      assert.strictEqual(err.code, 429);
      assert.strictEqual(hc._eventSourceRateLimitInfo.get("device:ha-1").retryAfterSeconds, 120);

      await openAndFail("device:ha-2");
      const fromBody = hc._eventSourceRateLimitInfo.get("device:ha-2");
      assert.strictEqual(fromBody.retryAfterSeconds, 557, "Expected the remaining period from the body");
      assert.match(fromBody.description, /10 successive error calls/);

      await openAndFail("device:ha-3");
      assert.strictEqual(hc._eventSourceRateLimitInfo.get("device:ha-3").retryAfterSeconds, null);

      await openAndFail("device:ha-4");
      const channelLimit = hc._eventSourceRateLimitInfo.get("device:ha-4");
      assert.strictEqual(channelLimit.retryAfterSeconds, 600);
      assert.strictEqual(channelLimit.limitType, "event");
      assert.strictEqual(channelLimit.errorKey, "429");
    } finally {
      globalThis.fetch = originalFetch;
      delete require.cache[modulePath];
    }
  }

  console.log("retry-backoff.test.js OK");
})();
