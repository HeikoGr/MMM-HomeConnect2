"use strict";

const path = require("node:path");

const moduleRoot = path.resolve(__dirname, "..");

// MagicMirror serves the whole modules/ folder over HTTP (express.static). A
// file next to the module, like the refresh token, could be fetched by any
// client the ipWhitelist lets in. express.static skips paths that start with a
// dot (404), so everything the module keeps between runs lives in .state/.
const stateDir = path.join(moduleRoot, ".state");
const refreshTokenPath = path.join(stateDir, "refresh_token.json");
const rateLimitPath = path.join(stateDir, "rate_limit.json");
const runStatePath = path.join(stateDir, "run_state.json");
const programStatsPath = path.join(stateDir, "program_stats.json");

// Versions up to 1.7.8 kept these files in the module folder itself;
// lib/state-files.js moves them on start.
const legacyStateFiles = [refreshTokenPath, rateLimitPath, runStatePath, programStatsPath].map((to) => ({
  from: path.join(moduleRoot, path.basename(to)),
  to,
}));

module.exports = {
  legacyStateFiles,
  moduleRoot,
  programStatsPath,
  rateLimitPath,
  refreshTokenPath,
  runStatePath,
  stateDir,
};
