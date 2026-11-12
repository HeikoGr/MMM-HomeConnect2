"use strict";

// Preloaded by `node --run test` (--import): the code under test logs through a console
// fallback outside MagicMirror, which buried the test results in hundreds of lines. Failures
// still show - node --test reports them from the test results, not from the console.
// TEST_VERBOSE=1 keeps the output.
if (!process.env.TEST_VERBOSE) {
  for (const method of ["debug", "info", "log", "warn", "error"]) {
    console[method] = () => {};
  }
}
