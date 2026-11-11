"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setLogSink } = require("../lib/logger");
const modulePaths = require("../lib/module-paths");
const { migrateLegacyStateFiles, writeFileAtomic } = require("../lib/state-files");

setLogSink({ info() {}, warn() {}, error() {}, debug() {}, log() {} });

const mode = (file) => fs.statSync(file).mode & 0o777;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-homeconnect2-state-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// Every state file lives in a dot folder, which MagicMirror's express.static does not serve.
{
  const files = [
    modulePaths.refreshTokenPath,
    modulePaths.rateLimitPath,
    modulePaths.runStatePath,
    modulePaths.programStatsPath,
  ];
  for (const file of files) {
    const relative = path.relative(modulePaths.moduleRoot, file);
    assert.ok(relative.startsWith(".state/"), `${relative} must be inside .state/`);
  }
  assert.deepStrictEqual(
    modulePaths.legacyStateFiles.map(({ from }) => path.relative(modulePaths.moduleRoot, from)),
    ["refresh_token.json", "rate_limit.json", "run_state.json", "program_stats.json"],
  );
}

// writeFileAtomic creates the folder (0700) and the file (0600) and leaves no temp file.
{
  const dir = path.join(tmpRoot, "atomic", ".state");
  const file = path.join(dir, "refresh_token.json");
  writeFileAtomic(file, "token-1");
  assert.strictEqual(fs.readFileSync(file, "utf8"), "token-1");
  assert.strictEqual(mode(dir), 0o700);
  assert.strictEqual(mode(file), 0o600);
  writeFileAtomic(file, "token-2");
  assert.strictEqual(fs.readFileSync(file, "utf8"), "token-2");
  assert.deepStrictEqual(fs.readdirSync(dir), ["refresh_token.json"]);
}

// A failed write leaves the previous content untouched and no temp file behind.
{
  const dir = path.join(tmpRoot, "failing", ".state");
  const file = path.join(dir, "program_stats.json");
  writeFileAtomic(file, '{"ok":true}');
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  try {
    assert.throws(() => writeFileAtomic(file, '{"ok":fal'), /disk full/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.strictEqual(fs.readFileSync(file, "utf8"), '{"ok":true}');
  assert.deepStrictEqual(fs.readdirSync(dir), ["program_stats.json"]);
}

// Migration: an old file in the module folder moves into the state folder.
{
  const root = path.join(tmpRoot, "migrate");
  fs.mkdirSync(root);
  const from = path.join(root, "refresh_token.json");
  const to = path.join(root, ".state", "refresh_token.json");
  fs.writeFileSync(from, "old-token", { mode: 0o644 });

  assert.strictEqual(migrateLegacyStateFiles([{ from, to }]), 1);
  assert.strictEqual(fs.existsSync(from), false);
  assert.strictEqual(fs.readFileSync(to, "utf8"), "old-token");
  assert.strictEqual(mode(to), 0o600);
  assert.strictEqual(mode(path.dirname(to)), 0o700);

  // Running it again finds nothing to do.
  assert.strictEqual(migrateLegacyStateFiles([{ from, to }]), 0);
  assert.strictEqual(fs.readFileSync(to, "utf8"), "old-token");
}

// Migration: a file already in the state folder is newer; the old copy is only removed.
{
  const root = path.join(tmpRoot, "both");
  fs.mkdirSync(path.join(root, ".state"), { recursive: true });
  const from = path.join(root, "rate_limit.json");
  const to = path.join(root, ".state", "rate_limit.json");
  fs.writeFileSync(from, "stale");
  fs.writeFileSync(to, "current");

  assert.strictEqual(migrateLegacyStateFiles([{ from, to }]), 0);
  assert.strictEqual(fs.existsSync(from), false);
  assert.strictEqual(fs.readFileSync(to, "utf8"), "current");
}

// Migration never throws, even when the target folder cannot be created.
{
  const root = path.join(tmpRoot, "blocked");
  fs.mkdirSync(root);
  const from = path.join(root, "run_state.json");
  fs.writeFileSync(from, "{}");
  fs.writeFileSync(path.join(root, ".state"), "a file where the folder should be");
  const to = path.join(root, ".state", "run_state.json");

  assert.strictEqual(migrateLegacyStateFiles([{ from, to }]), 0);
  assert.strictEqual(fs.readFileSync(from, "utf8"), "{}");
}

// The token store writes through the atomic helper into the state folder.
{
  const root = path.join(tmpRoot, "token-store");
  const tokenPath = path.join(root, ".state", "refresh_token.json");
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("module-paths")) {
      return { ...modulePaths, refreshTokenPath: tokenPath };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../lib/token-store")];
  let tokenStore;
  try {
    tokenStore = require("../lib/token-store");
  } finally {
    Module._load = originalLoad;
  }

  assert.strictEqual(tokenStore.persistRefreshToken("refresh-abc"), true);
  assert.strictEqual(fs.readFileSync(tokenPath, "utf8"), "refresh-abc");
  assert.strictEqual(mode(tokenPath), 0o600);
  assert.strictEqual(tokenStore.deleteRefreshTokenFile(), true);
  assert.strictEqual(fs.existsSync(tokenPath), false);
  assert.strictEqual(tokenStore.deleteRefreshTokenFile(), false);
}

console.log("state-files tests passed");
