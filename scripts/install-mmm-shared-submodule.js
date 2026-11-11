const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const submodulePath = "lib/mmm-shared";
const entryFile = path.join(repoRoot, submodulePath, "mmm-shared.js");

function runGit(args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

// A git checkout fetches the submodule here; anything else (a ZIP download, a
// failed git call) is only checked below.
if (fs.existsSync(path.join(repoRoot, ".git")) && fs.existsSync(path.join(repoRoot, ".gitmodules"))) {
  const syncResult = runGit(["submodule", "sync", "--", submodulePath]);
  if (syncResult.error || syncResult.status !== 0) {
    console.warn("Skipping mmm-shared submodule sync.");
  } else {
    const updateResult = runGit(["submodule", "update", "--init", "--recursive", "--checkout", submodulePath]);
    if (updateResult.error || updateResult.status !== 0) {
      console.warn("Skipping mmm-shared submodule update.");
    }
  }
}

// Without the submodule the module cannot start ("Cannot find module
// './lib/mmm-shared/mmm-shared'"). Say so now instead of at MagicMirror's start.
if (!fs.existsSync(entryFile)) {
  console.error(
    [
      "",
      "MMM-HomeConnect2: the lib/mmm-shared submodule is missing.",
      "Install the module with git instead of a ZIP download:",
      "  git clone --recurse-submodules https://github.com/HeikoGr/MMM-HomeConnect2",
      "or, in an existing git checkout:",
      "  git submodule update --init --recursive",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
