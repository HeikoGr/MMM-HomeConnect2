"use strict";

const assert = require("node:assert");
const { reconcileRunStates } = require("../lib/run-state-store");
const DeviceService = require("../lib/device-service");

const RUN = "BSH.Common.EnumType.OperationState.Run";
const PROGRAM = "LaundryCare.Dryer.Program.Synthetic";
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 26, 16, 0, 0);

function runningDryer(overrides = {}) {
  return {
    haId: "dryer",
    name: "Trockner",
    OperationState: RUN,
    ActiveProgramKey: PROGRAM,
    ActiveProgramSource: "active",
    RemainingProgramTime: 3000,
    _initialRemaining: 3000,
    _remainingObservedAt: T0,
    _lastRemainingSeenAt: T0,
    ...overrides,
  };
}

// A running program without a record gets one.
{
  const records = {};
  const { changed, restored } = reconcileRunStates([runningDryer()], records, T0);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(restored, []);
  assert.strictEqual(records.dryer.programKey, PROGRAM);
  assert.strictEqual(records.dryer.observedAt, T0);
  assert.strictEqual(records.dryer.initialRemaining, 3000);
}

// An unchanged run does not rewrite the file.
{
  const records = {};
  reconcileRunStates([runningDryer()], records, T0);
  const { changed } = reconcileRunStates([runningDryer()], records, T0 + MIN);
  assert.strictEqual(changed, false);
}

// After a restart the saved, earlier start wins over the first sighting since.
{
  const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const now = T0 + 40 * MIN;
  const device = runningDryer({
    RemainingProgramTime: 600,
    _initialRemaining: 600,
    _remainingObservedAt: now,
    _lastRemainingSeenAt: now,
  });
  const { changed, restored } = reconcileRunStates([device], records, now);
  assert.strictEqual(changed, false);
  assert.deepStrictEqual(restored, [device]);
  assert.strictEqual(device._remainingObservedAt, T0);
  assert.strictEqual(device._initialRemaining, 3000);
  assert.strictEqual(device._lastRemainingSeenAt, now, "the last sighting stays the live one");
}

// A drifting estimate (dryer remaining time grows) still counts as the same run.
{
  const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const now = T0 + 30 * MIN;
  const device = runningDryer({ RemainingProgramTime: 2400, _initialRemaining: 2400, _remainingObservedAt: now });
  const { restored } = reconcileRunStates([device], records, now);
  assert.strictEqual(restored.length, 1);
}

// A new run of the same program, started while the mirror was down, is not merged
// with the old record: its remaining time is close to the full duration.
{
  const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const now = T0 + 3 * 60 * MIN;
  const device = runningDryer({ RemainingProgramTime: 2900, _initialRemaining: 2900, _remainingObservedAt: now });
  const { changed, restored } = reconcileRunStates([device], records, now);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(restored, []);
  assert.strictEqual(device._remainingObservedAt, now);
  assert.strictEqual(records.dryer.observedAt, now);
}

// A different program replaces the record.
{
  const records = { dryer: { programKey: "LaundryCare.Dryer.Program.Cotton", observedAt: T0, initialRemaining: 3000 } };
  const now = T0 + 10 * MIN;
  const device = runningDryer({ _remainingObservedAt: now, RemainingProgramTime: 2500, _initialRemaining: 2500 });
  const { restored } = reconcileRunStates([device], records, now);
  assert.deepStrictEqual(restored, []);
  assert.strictEqual(records.dryer.programKey, PROGRAM);
}

// A state that says nothing runs ends the record; an unknown state keeps it.
{
  const records = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const unknown = { haId: "dryer", name: "Trockner" };
  assert.strictEqual(reconcileRunStates([unknown], records, T0 + MIN).changed, false);
  assert.ok(records.dryer, "a record must survive until the state is known");

  for (const state of ["Finished", "Inactive", "Ready"]) {
    const recs = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
    const device = { haId: "dryer", OperationState: `BSH.Common.EnumType.OperationState.${state}` };
    assert.strictEqual(reconcileRunStates([device], recs, T0 + MIN).changed, true, state);
    assert.deepStrictEqual(recs, {}, state);
  }
}

// A merely selected program is never recorded.
{
  const records = {};
  reconcileRunStates([runningDryer({ ActiveProgramSource: "selected" })], records, T0);
  assert.deepStrictEqual(records, {});
}

// Records older than a day are dropped, even for appliances no longer listed.
{
  const records = { gone: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const { changed } = reconcileRunStates([], records, T0 + 25 * 60 * MIN);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(records, {});
}

// DeviceService: broadcasting restores the start and persists changes through the store.
{
  const persisted = [];
  const logs = [];
  const logger = { debug() {}, info: (m) => logs.push(m), warn() {}, error() {} };
  const saved = { dryer: { programKey: PROGRAM, observedAt: T0, initialRemaining: 3000 } };
  const service = new DeviceService({
    logger,
    broadcastToAllClients() {},
    globalSession: { clientInstances: new Set() },
    runStateStore: { read: () => ({ ...saved }), persist: (r) => persisted.push(JSON.parse(JSON.stringify(r))) },
  });
  const now = Date.now();
  const device = runningDryer({
    RemainingProgramTime: 600,
    _initialRemaining: 600,
    _remainingObservedAt: now,
    _lastRemainingSeenAt: now,
  });
  // Keep the saved start within the same-run window relative to the real clock.
  service.runStates.dryer.observedAt = now - 40 * MIN;
  service.devices.set("dryer", device);

  const sent = [];
  service.broadcastDevices((n, payload) => sent.push({ n, payload }));
  assert.strictEqual(sent[0].payload[0]._remainingObservedAt, now - 40 * MIN);
  assert.ok(logs.some((m) => m.includes("restored")));
  assert.deepStrictEqual(persisted, [], "a restore alone changes no record");

  device.OperationState = "BSH.Common.EnumType.OperationState.Finished";
  service.broadcastDevices(() => {});
  assert.deepStrictEqual(persisted, [{}]);
}

console.log("run-state-store tests passed");
