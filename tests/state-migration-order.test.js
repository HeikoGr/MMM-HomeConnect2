"use strict";

/*
 * MagicMirror calls the helper's init() before start(), and init() already
 * reads the saved rate limit and builds the DeviceService, which reads the run
 * states and program statistics. The migration out of the module folder must
 * come before all of that: otherwise the services start empty and write their
 * empty state over the moved files.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-homeconnect2-migration-order-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const stateDir = path.join(root, ".state");
const paths = {
  refreshTokenPath: path.join(stateDir, "refresh_token.json"),
  rateLimitPath: path.join(stateDir, "rate_limit.json"),
  runStatePath: path.join(stateDir, "run_state.json"),
  programStatsPath: path.join(stateDir, "program_stats.json"),
};
const legacyStateFiles = Object.values(paths).map((to) => ({ from: path.join(root, path.basename(to)), to }));

const stats = { "ha-1": { name: "Washer", programs: { "Program.Cotton": { count: 7 } } } };
const until = Date.now() + 60 * 60 * 1000;
fs.writeFileSync(path.join(root, "program_stats.json"), JSON.stringify(stats));
fs.writeFileSync(path.join(root, "rate_limit.json"), JSON.stringify({ until }));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node_helper") {
    return { create: (definition) => definition };
  }
  if (request.endsWith("module-paths")) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, ...paths, stateDir, legacyStateFiles };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let helper;
try {
  helper = require("../node_helper");
} finally {
  Module._load = originalLoad;
}
require("../lib/logger").setLogSink({ info() {}, warn() {}, error() {}, debug() {}, log() {} });

helper.init();

assert.deepStrictEqual(helper.deviceService.programStats, stats);
assert.strictEqual(helper.getRateLimitUntil(), until);
assert.strictEqual(fs.existsSync(path.join(root, "program_stats.json")), false);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(paths.programStatsPath, "utf8")), stats);

console.log("state-migration-order tests passed");
process.exit(0);
