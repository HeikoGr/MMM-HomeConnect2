"use strict";

/*
 * program_stats.json: per appliance, every program seen running, with counters
 * and the most recent runs. Filled from the runs lib/run-state-store.js reports
 * as ended, so it costs no API call. Home Connect keeps no such history that the
 * API would hand out, and a run's real length is only known from watching it:
 * a duration is kept only when both its start and its end were observed.
 */
const fs = require("node:fs");
const { programStatsPath } = require("./module-paths");
const { log } = require("./logger");

const MAX_RECENT_RUNS = 20;

function readProgramStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(programStatsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn("Failed to read the program statistics:", err.message);
    }
    return {};
  }
}

// Guarded like rate-limit-store.js: this runs inside event handlers.
function persistProgramStats(stats) {
  try {
    fs.writeFileSync(programStatsPath, JSON.stringify(stats, null, 2));
  } catch (err) {
    log.warn("Failed to save the program statistics:", err.message);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Over the recent runs only - long enough to be meaningful, short enough to
// follow a changed habit (other options, a new load size).
function summarize(runs) {
  const timed = runs.filter((run) => Number.isFinite(run.durationS));
  if (timed.length === 0) {
    return { timedRuns: 0 };
  }
  const durations = timed.map((run) => run.durationS);
  // Positive: the program took longer than it announced at its start.
  const deviations = timed
    .filter((run) => Number.isFinite(run.initialRemainingS))
    .map((run) => run.durationS - run.initialRemainingS);
  const summary = {
    timedRuns: timed.length,
    medianDurationS: median(durations),
    minDurationS: Math.min(...durations),
    maxDurationS: Math.max(...durations),
  };
  if (deviations.length > 0) {
    summary.medianDeviationFromAnnouncedS = median(deviations);
  }
  return summary;
}

/**
 * Adds one ended run (as reported by reconcileRunStates) to the statistics.
 *
 * @param {object} stats - Mutated in place
 * @param {object} ended - { haId, device, record, outcome, endedAt|null }
 * @returns {object} the stored run
 */
function addEndedRun(stats, { haId, device, record, outcome, endedAt }) {
  const appliance = stats[haId] || { programs: {} };
  if (device?.name) {
    appliance.name = device.name;
  }
  if (device?.type) {
    appliance.type = device.type;
  }
  stats[haId] = appliance;

  const program = appliance.programs[record.programKey] || {
    starts: 0,
    finished: 0,
    aborted: 0,
    errors: 0,
    unobserved: 0,
    runs: [],
  };
  appliance.programs[record.programKey] = program;
  program.name = record.programName || program.name || record.programKey;
  program.starts += 1;
  const counter = { finished: "finished", aborted: "aborted", error: "errors" }[outcome] || "unobserved";
  program[counter] += 1;

  const timed = record.startObserved === true && Number.isFinite(endedAt);
  const run = {
    startedAt: record.observedAtIso || new Date(record.observedAt).toISOString(),
    startObserved: record.startObserved === true,
    endedAt: Number.isFinite(endedAt) ? new Date(endedAt).toISOString() : null,
    outcome,
    durationS: timed ? Math.round((endedAt - record.observedAt) / 1000) : null,
    initialRemainingS: record.initialRemaining,
  };
  for (const field of ["details", "phases", "energyForecast", "waterForecast", "deviceStartCount"]) {
    if (record[field] !== undefined) {
      run[field] = record[field];
    }
  }
  program.lastStartedAt = run.startedAt;
  program.runs = [...program.runs, run].slice(-MAX_RECENT_RUNS);
  program.summary = summarize(program.runs);
  return run;
}

/**
 * Merges a /programs/available answer of an idle appliance into its program catalog.
 * The list is a union over time: what an appliance calls "available" depends on
 * its state, and a program bought or downloaded later simply joins it.
 *
 * @param {object} stats - Mutated in place
 * @param {object} device - { haId, name, type }
 * @param {object[]} programs - [{ key, name? }]
 * @param {number} now - Current time in ms
 * @returns {string[]} keys that were not in the catalog before
 */
function mergeProgramCatalog(stats, device, programs, now = Date.now()) {
  const appliance = stats[device.haId] || { programs: {} };
  stats[device.haId] = appliance;
  if (device.name) {
    appliance.name = device.name;
  }
  if (device.type) {
    appliance.type = device.type;
  }
  const catalog = appliance.catalog || {};
  appliance.catalog = catalog;
  const nowIso = new Date(now).toISOString();
  const added = [];
  for (const program of programs) {
    if (!program || typeof program.key !== "string" || !program.key) {
      continue;
    }
    const entry = catalog[program.key];
    if (entry) {
      entry.lastListedAt = nowIso;
      if (typeof program.name === "string" && program.name) {
        entry.name = program.name;
      }
      continue;
    }
    catalog[program.key] = {
      name: typeof program.name === "string" && program.name ? program.name : program.key,
      firstListedAt: nowIso,
      lastListedAt: nowIso,
    };
    added.push(program.key);
  }
  appliance.catalogFetchedAt = nowIso;
  appliance.catalogComplete = true;
  delete appliance.catalogStale;
  return added;
}

// A catalog is complete once it came from an idle appliance: while a program
// runs, /programs/available lists only that one program. It goes stale when an
// appliance runs a program it does not list - bought or downloaded since.
function needsCatalog(stats, haId) {
  const appliance = stats[haId];
  return !appliance?.catalogComplete || appliance.catalogStale === true;
}

function catalogHasProgram(stats, haId, programKey) {
  return Boolean(stats[haId]?.catalog?.[programKey]);
}

// Returns true if the flag was not set before.
function markCatalogStale(stats, haId) {
  const appliance = stats[haId];
  if (!appliance || appliance.catalogStale === true) {
    return false;
  }
  appliance.catalogStale = true;
  return true;
}

module.exports = {
  addEndedRun,
  catalogHasProgram,
  markCatalogStale,
  mergeProgramCatalog,
  needsCatalog,
  persistProgramStats,
  readProgramStats,
  summarize,
};
