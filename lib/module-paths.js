"use strict";

const path = require("node:path");

const moduleRoot = path.resolve(__dirname, "..");
const refreshTokenPath = path.join(moduleRoot, "refresh_token.json");
const rateLimitPath = path.join(moduleRoot, "rate_limit.json");
const runStatePath = path.join(moduleRoot, "run_state.json");
const programStatsPath = path.join(moduleRoot, "program_stats.json");

module.exports = {
  moduleRoot,
  programStatsPath,
  rateLimitPath,
  refreshTokenPath,
  runStatePath,
};
