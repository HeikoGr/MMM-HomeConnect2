"use strict";

const assert = require("node:assert");
const { reconcileRunStates } = require("../lib/run-state-store");
const { addEndedRun, mergeProgramCatalog, summarize } = require("../lib/program-stats");
const DeviceService = require("../lib/device-service");

const STATE = (label) => `BSH.Common.EnumType.OperationState.${label}`;
const PROGRAM = "LaundryCare.Dryer.Program.Synthetic";
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 26, 16, 0, 0);

function runningDryer(overrides = {}) {
  return {
    haId: "dryer",
    name: "Trockner",
    type: "Dryer",
    OperationState: STATE("Run"),
    ActiveProgramKey: PROGRAM,
    ActiveProgramName: "Pflegeleicht",
    ActiveProgramSource: "active",
    ActiveProgramPhase: "Prozessphase: Trocknen",
    ActiveProgramDetails: ["Trockenziel: Schranktrocken Plus"],
    RemainingProgramTime: 3000,
    _initialRemaining: 3000,
    _remainingObservedAt: T0,
    ...overrides,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // A run watched from idle to finished yields a timed run with phases and extras.
  {
    const records = {};
    const session = { seenIdle: new Set(), seenRunning: new Set() };
    reconcileRunStates([{ haId: "dryer", OperationState: STATE("Ready") }], records, T0 - MIN, session);
    reconcileRunStates([runningDryer({ "BSH.Common.Status.Program.All.Count.Started": 59 })], records, T0, session);
    assert.strictEqual(records.dryer.startObserved, true);
    assert.strictEqual(records.dryer.deviceStartCount, 59);

    const phaseChange = reconcileRunStates(
      [runningDryer({ ActiveProgramPhase: "Prozessphase: Bügeltrocken" })],
      records,
      T0 + 50 * MIN,
      session,
    );
    assert.strictEqual(phaseChange.changed, true);
    assert.deepStrictEqual(
      records.dryer.phases.map((p) => p.phase),
      ["Prozessphase: Trocknen", "Prozessphase: Bügeltrocken"],
    );

    const { ended } = reconcileRunStates(
      [{ haId: "dryer", name: "Trockner", OperationState: STATE("Finished") }],
      records,
      T0 + 62 * MIN,
      session,
    );
    assert.strictEqual(ended.length, 1);
    assert.strictEqual(ended[0].outcome, "finished");
    assert.strictEqual(ended[0].endedAt, T0 + 62 * MIN);
    assert.deepStrictEqual(records, {});

    const stats = {};
    const run = addEndedRun(stats, ended[0]);
    assert.strictEqual(run.durationS, 62 * 60);
    assert.strictEqual(run.initialRemainingS, 3000);
    assert.deepStrictEqual(run.details, ["Trockenziel: Schranktrocken Plus"]);
    assert.strictEqual(run.phases.length, 2);
    const program = stats.dryer.programs[PROGRAM];
    assert.strictEqual(program.name, "Pflegeleicht");
    assert.strictEqual(program.starts, 1);
    assert.strictEqual(program.finished, 1);
    assert.strictEqual(program.summary.medianDurationS, 62 * 60);
    assert.strictEqual(program.summary.medianDeviationFromAnnouncedS, 62 * 60 - 3000);
  }

  // A run first seen mid-way (after a restart) is counted, but not timed.
  {
    const records = {};
    const session = { seenIdle: new Set(), seenRunning: new Set() };
    reconcileRunStates([runningDryer()], records, T0, session);
    assert.strictEqual(records.dryer.startObserved, false);
    const { ended } = reconcileRunStates(
      [{ haId: "dryer", OperationState: STATE("Finished") }],
      records,
      T0 + 30 * MIN,
      session,
    );
    const stats = {};
    const run = addEndedRun(stats, ended[0]);
    assert.strictEqual(run.durationS, null);
    assert.strictEqual(stats.dryer.programs[PROGRAM].summary.timedRuns, 0);
  }

  // A run that ended while the mirror was down: the end time is unknown.
  {
    const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000, startObserved: true } };
    const session = { seenIdle: new Set(), seenRunning: new Set() };
    const { ended } = reconcileRunStates(
      [{ haId: "dryer", OperationState: STATE("Ready") }],
      records,
      T0 + 5 * 60 * MIN,
      session,
    );
    assert.strictEqual(ended[0].outcome, "aborted");
    assert.strictEqual(ended[0].endedAt, null);
    assert.strictEqual(addEndedRun({}, ended[0]).durationS, null);
  }

  // Outcomes: an error ends as "error", a run replaced by another program as "unobserved".
  {
    const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
    const { ended } = reconcileRunStates([{ haId: "dryer", OperationState: STATE("Error") }], records, T0 + MIN);
    assert.strictEqual(ended[0].outcome, "error");

    const replaced = {
      dryer: { programKey: "LaundryCare.Dryer.Program.Cotton", observedAt: T0, initialRemaining: 3000 },
    };
    const result = reconcileRunStates([runningDryer({ _remainingObservedAt: T0 + MIN })], replaced, T0 + MIN);
    assert.strictEqual(result.ended[0].outcome, "unobserved");
    assert.strictEqual(replaced.dryer.programKey, PROGRAM);
  }

  // Counters and the recent-runs window.
  {
    const stats = {};
    for (let i = 0; i < 25; i += 1) {
      addEndedRun(stats, {
        haId: "dryer",
        device: { name: "Trockner" },
        record: {
          programKey: PROGRAM,
          programName: "Pflegeleicht",
          observedAt: T0 + i * 1000,
          initialRemaining: 3000,
          startObserved: true,
        },
        outcome: i % 5 === 0 ? "aborted" : "finished",
        endedAt: T0 + i * 1000 + 3600 * 1000,
      });
    }
    const program = stats.dryer.programs[PROGRAM];
    assert.strictEqual(program.starts, 25);
    assert.strictEqual(program.aborted, 5);
    assert.strictEqual(program.finished, 20);
    assert.strictEqual(program.runs.length, 20);
    assert.strictEqual(program.summary.medianDurationS, 3600);
    assert.deepStrictEqual(summarize([]), { timedRuns: 0 });
  }

  // The catalog is a union: listed programs stay, new ones are reported once.
  {
    const stats = {};
    const device = { haId: "dryer", name: "Trockner", type: "Dryer" };
    const first = mergeProgramCatalog(
      stats,
      device,
      [
        { key: "A", name: "Baumwolle" },
        { key: "B", name: "Mix" },
      ],
      T0,
    );
    assert.deepStrictEqual(first, ["A", "B"]);
    const second = mergeProgramCatalog(
      stats,
      device,
      [
        { key: "A", name: "Baumwolle" },
        { key: "C", name: "Outdoor" },
      ],
      T0 + MIN,
    );
    assert.deepStrictEqual(second, ["C"]);
    assert.deepStrictEqual(Object.keys(stats.dryer.catalog).sort(), ["A", "B", "C"]);
    assert.strictEqual(stats.dryer.catalog.B.lastListedAt, new Date(T0).toISOString());
  }

  // DeviceService: asks only idle appliances in a known state, fetches a missing
  // catalog, refetches a stale one after an unknown program ran, asks once per
  // unknown selected program, never while rate limited.
  {
    const calls = [];
    let rateLimited = false;
    let answer = [{ key: PROGRAM, name: "Pflegeleicht" }];
    const persisted = [];
    const service = new DeviceService({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      broadcastToAllClients() {},
      globalSession: { clientInstances: new Set() },
      programStatsStore: { read: () => ({}), persist: (s) => persisted.push(JSON.parse(JSON.stringify(s))) },
      isRateLimited: () => rateLimited,
    });
    service.hc = {
      getAvailablePrograms: async (haId) => {
        calls.push(haId);
        return { success: true, data: { programs: answer } };
      },
    };
    const device = { haId: "dryer", name: "Trockner", connected: true, ActiveProgramKey: PROGRAM };
    service.devices.set("dryer", device);
    const broadcast = async () => {
      service.broadcastDevices(() => {});
      await wait(20);
    };

    await broadcast();
    assert.deepStrictEqual(calls, [], "no fetch while the state is unknown");
    device.OperationState = STATE("Run");
    await broadcast();
    assert.deepStrictEqual(calls, [], "no fetch while a program runs");

    device.OperationState = STATE("Ready");
    await broadcast();
    assert.deepStrictEqual(calls, ["dryer"]);
    assert.ok(persisted.at(-1).dryer.catalog[PROGRAM]);
    assert.strictEqual(persisted.at(-1).dryer.catalogComplete, true);

    await broadcast();
    assert.strictEqual(calls.length, 1, "a known program triggers no fetch");

    // A downloaded program runs: the catalog goes stale and is fetched afterwards.
    device.OperationState = STATE("Run");
    device.ActiveProgramKey = "LaundryCare.Dryer.Program.Downloaded";
    await broadcast();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(persisted.at(-1).dryer.catalogStale, true);
    answer = [
      { key: PROGRAM, name: "Pflegeleicht" },
      { key: "LaundryCare.Dryer.Program.Downloaded", name: "Neu" },
    ];
    device.OperationState = STATE("Finished");
    await broadcast();
    assert.strictEqual(calls.length, 2, "a stale catalog is fetched once the appliance is idle");
    assert.ok(persisted.at(-1).dryer.catalog["LaundryCare.Dryer.Program.Downloaded"]);
    assert.strictEqual(persisted.at(-1).dryer.catalogStale, undefined);

    // An unknown selected program the API does not list is asked for only once.
    device.ActiveProgramKey = "LaundryCare.Dryer.Program.Unlisted";
    await broadcast();
    await broadcast();
    assert.strictEqual(calls.length, 3);

    rateLimited = true;
    device.ActiveProgramKey = "LaundryCare.Dryer.Program.Other";
    await broadcast();
    assert.strictEqual(calls.length, 3, "no fetch while rate limited");
  }

  // A failed or empty answer waits before the appliance is asked again.
  {
    const calls = [];
    const service = new DeviceService({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      broadcastToAllClients() {},
      globalSession: { clientInstances: new Set() },
      programStatsStore: { read: () => ({}), persist() {} },
    });
    service.hc = {
      getAvailablePrograms: async (haId) => {
        calls.push(haId);
        return { success: false, statusCode: 409, error: "busy" };
      },
    };
    service.devices.set("dryer", { haId: "dryer", name: "Trockner", connected: true, OperationState: STATE("Ready") });
    service.broadcastDevices(() => {});
    await wait(20);
    service.broadcastDevices(() => {});
    await wait(20);
    assert.deepStrictEqual(calls, ["dryer"]);
  }

  console.log("program-stats tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
