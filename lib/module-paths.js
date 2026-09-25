"use strict";

const path = require("node:path");

const moduleRoot = path.resolve(__dirname, "..");
const refreshTokenPath = path.join(moduleRoot, "refresh_token.json");
const rateLimitPath = path.join(moduleRoot, "rate_limit.json");

module.exports = {
  moduleRoot,
  rateLimitPath,
  refreshTokenPath,
};
