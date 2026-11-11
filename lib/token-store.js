"use strict";

/*
 * .state/refresh_token.json: a long-lived OAuth refresh token, equivalent to a
 * credential for the user's Home Connect account. Reading lives in
 * AuthService.readRefreshTokenFromFile().
 */
const fs = require("node:fs");
const { refreshTokenPath } = require("./module-paths");
const { log } = require("./logger");
const { writeFileAtomic } = require("./state-files");

// Writing/deleting happens both inside event-emitter callbacks and
// socket-notification handlers with no enclosing try/catch of their own - an
// unguarded EACCES/ENOSPC/EROFS here would throw synchronously and crash the
// whole Node process hosting every MagicMirror module, not just this one.
function persistRefreshToken(token) {
  try {
    // Owner-only permissions, written atomically (lib/state-files.js).
    writeFileAtomic(refreshTokenPath, token, { mode: 0o600 });
    log.info("Refresh token saved successfully");
    return true;
  } catch (err) {
    log.error("Failed to persist refresh token to disk:", err);
    return false;
  }
}

function deleteRefreshTokenFile() {
  try {
    if (fs.existsSync(refreshTokenPath)) {
      fs.unlinkSync(refreshTokenPath);
      log.info("Cached refresh token file deleted");
      return true;
    }
  } catch (err) {
    log.warn("Failed to delete cached refresh token file:", err);
  }
  return false;
}

module.exports = { deleteRefreshTokenFile, persistRefreshToken };
