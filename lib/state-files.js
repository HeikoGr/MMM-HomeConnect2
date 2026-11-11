"use strict";

/*
 * Shared file handling for the state the module keeps between runs (see
 * lib/module-paths.js for where it lives and why).
 */
const fs = require("node:fs");
const path = require("node:path");
const { legacyStateFiles } = require("./module-paths");
const { log } = require("./logger");

// Owner-only: the folder holds the refresh token, a credential.
function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The mode option only applies when the folder is newly created.
  fs.chmodSync(dir, 0o700);
}

/*
 * Write to <file>.tmp and rename it over the target. A mirror loses power while
 * running more often than a server does; a plain writeFileSync interrupted
 * half-way leaves an empty or cut-off file (a lost token means a new login).
 * rename() replaces the target in one step, so the old content survives any
 * failure before it. Throws like writeFileSync; the callers guard it.
 */
function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  ensureStateDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode only applies to a new file, and a crash may have left one.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/*
 * Move state files an older version left in the module folder (where they were
 * served over HTTP) into the state folder. A file already in the state folder
 * is newer and wins; the old copy is removed either way. Never throws: a
 * failure here must not stop the module, it only logs.
 */
function migrateLegacyStateFiles(entries = legacyStateFiles) {
  let moved = 0;
  for (const { from, to } of entries) {
    try {
      if (!fs.existsSync(from)) {
        continue;
      }
      if (fs.existsSync(to)) {
        fs.rmSync(from, { force: true });
        log.info(`Removed outdated ${path.basename(from)} from the module folder`);
        continue;
      }
      ensureStateDir(path.dirname(to));
      fs.renameSync(from, to);
      fs.chmodSync(to, 0o600);
      moved += 1;
      log.info(`Moved ${path.basename(from)} into ${path.relative(path.dirname(from), to)}`);
    } catch (err) {
      log.warn(`Failed to move ${path.basename(from)} out of the module folder:`, err.message);
    }
  }
  return moved;
}

module.exports = { ensureStateDir, migrateLegacyStateFiles, writeFileAtomic };
