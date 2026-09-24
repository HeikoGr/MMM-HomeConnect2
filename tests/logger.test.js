"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { log, setModuleLogLevel } = require("../lib/logger");

function capture(fn) {
  const calls = [];
  const originals = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  for (const method of Object.keys(originals)) {
    console[method] = (entry) => calls.push({ method, entry });
  }
  try {
    fn();
  } finally {
    Object.assign(console, originals);
  }
  return calls;
}

test("log goes through the shared logger and follows the session level", () => {
  setModuleLogLevel("warn");
  const calls = capture(() => {
    log.info("hidden");
    log.warn("shown", { haId: "ha-1" });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "warn");
  assert.equal(calls[0].entry.module, "MMM-HomeConnect2");
  assert.equal(calls[0].entry.message, "shown");
  assert.deepEqual(calls[0].entry.context, { haId: "ha-1" });
});

test("secrets in logged objects are redacted", () => {
  setModuleLogLevel("debug");
  const [call] = capture(() =>
    log.debug("token response", {
      access_token: "a",
      refresh_token: "r",
      clientSecret: "s",
      device_code: "d",
      expires_in: 60,
    }),
  );
  assert.deepEqual(call.entry.context, {
    access_token: "***redacted***",
    refresh_token: "***redacted***",
    clientSecret: "***redacted***",
    device_code: "***redacted***",
    expires_in: 60,
  });
});

test("errors and plain values are logged as text; mixed arguments stay structured", () => {
  setModuleLogLevel("debug");
  const error = Object.assign(new Error("boom"), { statusCode: 429 });
  const [first, second, third, fourth] = capture(() => {
    log.error("Failed to get devices:", error);
    log.info("Existing refresh token found - length:", 42);
    log.error("Parse failed:", new TypeError("bad input"));
    log.warn("Mixed:", "text", { haId: "ha-1" });
  });
  assert.equal(first.entry.context, "boom (429)");
  assert.equal(second.entry.context, "42");
  assert.equal(third.entry.context, "TypeError: bad input");
  assert.deepEqual(fourth.entry.context, { details: ["text", { haId: "ha-1" }] });
});

test("level none silences everything", () => {
  setModuleLogLevel("none");
  assert.deepEqual(
    capture(() => log.error("not shown")),
    [],
  );
});

test("without a session level only the global level applies (debug passes through)", () => {
  setModuleLogLevel(undefined);
  const calls = capture(() => log.debug("shown"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "debug");
});
