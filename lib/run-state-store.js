"use strict";

/*
 * run_state.json: when each appliance's current program was first seen running.
 * Home Connect reports no start time, and some appliances (dryers) no total
 * duration and a ProgramProgress stuck at 0 either. Their progress bar is
 * elapsed / (elapsed + remaining), with "elapsed" counted from that first
 * sighting (_remainingObservedAt). The sighting only lives in memory, so without
 * this file a restart would take the first answer after the restart as the start
 * and a program already half through would start again at 0 %.
 *
 * The records also carry what lib/program-stats.js keeps about a finished run
 * (options, forecasts, phase changes), since they are the one place that sees a
 * run from start to end across restarts.
 */
const fs = require("node:fs");
const { runStatePath } = require("./module-paths");
const { log } = require("./logger");
const { parseOperationState, parseRemainingSeconds } = require("./device-utils");

// No appliance program runs this long; an older record belongs to a run whose end
// was never observed.
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;

// Estimated remaining times drift: a dryer's grew by 2.5 min within 7 min of
// drying. A restored start must still roughly agree with the current remaining
// time - a new run of the same program, started while the mirror was down,
// reports close to its full duration instead and is recorded afresh.
const REMAINING_TOLERANCE_S = 30 * 60;

const MAX_PHASES = 20;

// Raw keys (applyEventToDevice keeps unknown keys under their API name) worth
// keeping with a run. The start counter is not in the public API docs; the
// dishwasher sends it as a STATUS event when a program starts.
const RUN_EXTRA_KEYS = Object.freeze({
  energyForecast: "BSH.Common.Option.EnergyForecast",
  waterForecast: "BSH.Common.Option.WaterForecast",
  deviceStartCount: "BSH.Common.Status.Program.All.Count.Started",
});

function isRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.programKey === "string" &&
    Number.isFinite(value.observedAt) &&
    Number.isFinite(value.initialRemaining)
  );
}

function readRunStates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    const records = {};
    for (const [haId, record] of Object.entries(parsed || {})) {
      if (isRecord(record)) {
        records[haId] = record;
      }
    }
    return records;
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn("Failed to read the saved program start times:", err.message);
    }
    return {};
  }
}

// Guarded like rate-limit-store.js: this runs on every broadcast, a throw here
// would take down the whole MagicMirror process.
function persistRunStates(records) {
  try {
    if (Object.keys(records).length > 0) {
      fs.writeFileSync(runStatePath, JSON.stringify(records, null, 2));
    } else {
      fs.rmSync(runStatePath, { force: true });
    }
  } catch (err) {
    log.warn("Failed to save the program start times:", err.message);
  }
}

function isSameRun(record, device, remainingSeconds, now) {
  if (record.programKey !== device.ActiveProgramKey) {
    return false;
  }
  const ageMs = now - record.observedAt;
  if (ageMs < 0 || ageMs > MAX_RUN_AGE_MS) {
    return false;
  }
  return remainingSeconds <= record.initialRemaining - ageMs / 1000 + REMAINING_TOLERANCE_S;
}

function recordFromDevice(device, startObserved) {
  const observedAt = Number(device._remainingObservedAt);
  const record = {
    programKey: device.ActiveProgramKey,
    programName: typeof device.ActiveProgramName === "string" ? device.ActiveProgramName : device.ActiveProgramKey,
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    initialRemaining: Number(device._initialRemaining),
    // Only then is observedAt the real start (to the minute) and not merely the
    // first answer after a restart - and only then is a duration worth keeping.
    startObserved,
  };
  if (Array.isArray(device.ActiveProgramDetails) && device.ActiveProgramDetails.length > 0) {
    record.details = [...device.ActiveProgramDetails];
  }
  for (const [field, key] of Object.entries(RUN_EXTRA_KEYS)) {
    const value = Number(device[key]);
    if (device[key] !== undefined && device[key] !== null && Number.isFinite(value)) {
      record[field] = value;
    }
  }
  return record;
}

// Extras such as the forecasts may arrive a moment after the run was recorded.
function fillMissingExtras(record, device) {
  let changed = false;
  for (const [field, key] of Object.entries(RUN_EXTRA_KEYS)) {
    const value = Number(device[key]);
    if (record[field] === undefined && device[key] !== undefined && device[key] !== null && Number.isFinite(value)) {
      record[field] = value;
      changed = true;
    }
  }
  if (!record.details && Array.isArray(device.ActiveProgramDetails) && device.ActiveProgramDetails.length > 0) {
    record.details = [...device.ActiveProgramDetails];
    changed = true;
  }
  return changed;
}

function notePhase(record, device, now) {
  const phase = typeof device.ActiveProgramPhase === "string" ? device.ActiveProgramPhase : "";
  if (!phase) {
    return false;
  }
  const phases = Array.isArray(record.phases) ? record.phases : [];
  if (phases.length > 0 && phases[phases.length - 1].phase === phase) {
    return false;
  }
  if (phases.length >= MAX_PHASES) {
    return false;
  }
  phases.push({ phase, at: new Date(now).toISOString() });
  record.phases = phases;
  return true;
}

function endOutcome(state) {
  if (state.isFinished) {
    return "finished";
  }
  return state.label === "Error" ? "error" : "aborted";
}

/**
 * Brings the saved records and the live devices in line (mutates both).
 * A device whose run is older than its in-memory sighting gets the saved start
 * back; a running device without a record gets one; a device that is known to
 * run nothing loses its record, which is then reported as an ended run.
 *
 * @param {object[]} devices - Live device objects
 * @param {object} records - haId -> run record (see recordFromDevice)
 * @param {number} now - Current time in ms
 * @param {object} [session] - In-memory sightings of this process:
 *   { seenIdle: Set, seenRunning: Set }. A start counts as observed when the
 *   appliance was seen idle before, an end when it was seen running before.
 * @returns {{ changed: boolean, restored: object[], ended: object[] }} whether
 *   records changed, the devices whose start was restored, and the runs that
 *   ended: { haId, device, record, outcome, endedAt|null }
 */
function reconcileRunStates(devices, records, now = Date.now(), session = {}) {
  const seenIdle = session.seenIdle || new Set();
  const seenRunning = session.seenRunning || new Set();
  let changed = false;
  const restored = [];
  const ended = [];

  const endRun = (haId, device, record, outcome, endObserved) => {
    ended.push({ haId, device, record, outcome, endedAt: endObserved ? now : null });
    delete records[haId];
    changed = true;
  };

  for (const device of devices) {
    const haId = device?.haId;
    if (!haId) {
      continue;
    }
    const record = records[haId];
    const state = parseOperationState(device);
    state.label = typeof device.OperationState === "string" ? device.OperationState.split(".").pop() : "";

    if (state.known && !state.isRun && !state.isPaused) {
      seenIdle.add(haId);
    }

    // Only a state that says so ends a run. Right after a restart the state is
    // not known yet, and the record must survive until it is.
    if (state.known && !state.hasProgramInProgress) {
      if (record) {
        endRun(haId, device, record, endOutcome(state), seenRunning.has(haId));
      }
      seenRunning.delete(haId);
      continue;
    }

    const remainingSeconds = parseRemainingSeconds(device);
    const running =
      (state.isRun || state.isPaused) &&
      device.ActiveProgramSource === "active" &&
      typeof device.ActiveProgramKey === "string" &&
      Number.isFinite(Number(device._remainingObservedAt)) &&
      Number(device._initialRemaining) > 0 &&
      remainingSeconds > 0;
    if (!running) {
      continue;
    }

    const observedAt = Number(device._remainingObservedAt);
    if (record && record.observedAt === observedAt && record.programKey === device.ActiveProgramKey) {
      seenRunning.add(haId);
      changed = fillMissingExtras(record, device) || changed;
      changed = notePhase(record, device, now) || changed;
      continue;
    }
    if (record && record.observedAt < observedAt && isSameRun(record, device, remainingSeconds, now)) {
      device._remainingObservedAt = record.observedAt;
      device._initialRemaining = record.initialRemaining;
      restored.push(device);
      seenRunning.add(haId);
      changed = fillMissingExtras(record, device) || changed;
      changed = notePhase(record, device, now) || changed;
      continue;
    }

    if (record) {
      // Another program, or a new run of the same one: the old run ended unseen.
      endRun(haId, device, record, "unobserved", false);
    }
    const next = recordFromDevice(device, seenIdle.has(haId));
    notePhase(next, device, now);
    records[haId] = next;
    seenRunning.add(haId);
    changed = true;
  }

  for (const [haId, record] of Object.entries(records)) {
    if (now - record.observedAt > MAX_RUN_AGE_MS) {
      endRun(haId, null, record, "unobserved", false);
    }
  }

  return { changed, restored, ended };
}

module.exports = { persistRunStates, readRunStates, reconcileRunStates };
