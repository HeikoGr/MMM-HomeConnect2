"use strict";

const path = require("node:path");

const moduleRoot = path.resolve(__dirname, "..");
const refreshTokenPath = path.join(moduleRoot, "refresh_token.json");

module.exports = {
  moduleRoot,
  refreshTokenPath,
};
