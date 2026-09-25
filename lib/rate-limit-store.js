"use strict";

/*
 * rate_limit.json: the end of the current API block (429 / Retry-After). Home
 * Connect counts a daily quota per client; without this file a restart during a
 * block would start the session with a token refresh, a full snapshot and the SSE
 * channels - all of them answered with another 429.
 */
const fs = require("node:fs");
const { rateLimitPath } = require("./module-paths");
const { log } = require("./logger");

// A block that already ended reads as 0, so a stale file is harmless.
function readRateLimitUntil(now = Date.now()) {
  try {
    const until = Number(JSON.parse(fs.readFileSync(rateLimitPath, "utf8"))?.until);
    return Number.isFinite(until) && until > now ? until : 0;
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn("Failed to read the saved rate limit:", err.message);
    }
    return 0;
  }
}

// Guarded like token-store.js: this runs inside event handlers, a throw here
// would take down the whole MagicMirror process.
function persistRateLimitUntil(until, now = Date.now()) {
  try {
    if (until > now) {
      fs.writeFileSync(rateLimitPath, JSON.stringify({ until, untilIso: new Date(until).toISOString() }));
    } else {
      fs.rmSync(rateLimitPath, { force: true });
    }
  } catch (err) {
    log.warn("Failed to save the rate limit:", err.message);
  }
}

module.exports = { persistRateLimitUntil, readRateLimitUntil };
