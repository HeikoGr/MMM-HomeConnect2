"use strict";

const assert = require("node:assert");
const ProgramService = require("../lib/program-service");

function createProgramService(overrides = {}) {
  const globalSession = { rateLimitUntil: 0 };
  const logs = [];
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args) => logs.push({ level, message: args.join(" ") }),
    ]),
  );
  const devices = new Map([
    [
      "ha-1",
      {
        haId: "ha-1",
        name: "Washer",
        type: "Washer",
        connected: false,
      },
    ],
  ]);
  const service = new ProgramService({
    logger,
    globalSession,
    activeProgramManager: null,
    devices,
    setRateLimitUntil: (untilTs) => {
      globalSession.rateLimitUntil = Math.max(0, Number(untilTs || 0));
    },
    ...overrides,
  });
  service.attachClient({});
  return { service, globalSession, logs, devices };
}

(async () => {
  // applyProgramResult: applies options and returns payload
  {
    const { service, devices } = createProgramService();
    const result = {
      haId: "ha-1",
      source: "active",
      data: {
        key: "LaundryCare.Washer.Program.EasyCare",
        name: "Easy Care",
        options: [{ key: "op1" }, { key: "BSH.Common.Option.EstimatedTotalProgramTime", value: 4200 }],
      },
    };
    const payload = service.applyProgramResult(result);
    assert.ok(payload);
    assert.strictEqual(payload.name, "Washer");
    const device = devices.get("ha-1");
    assert.strictEqual(device.connected, true);
    assert.ok(Object.hasOwn(device, "op1"), "every option is applied to the device");
    assert.strictEqual(device.EstimatedTotalProgramTime, 4200);
    assert.strictEqual(device.ActiveProgramKey, "LaundryCare.Washer.Program.EasyCare");
    assert.strictEqual(device.ActiveProgramName, "Easy Care");
    assert.strictEqual(device.ActiveProgramSource, "active");
    assert.strictEqual(device.EstimatedTotalProgramTime, 4200);
  }

  // applyProgramResult: stores dryer phase/details for UI rendering
  {
    const { service, devices } = createProgramService();
    const result = {
      haId: "ha-1",
      source: "selected",
      data: {
        key: "LaundryCare.Dryer.Program.Synthetic",
        name: "Synthetics",
        options: [
          {
            key: "LaundryCare.Dryer.Option.DryingTarget",
            value: "LaundryCare.Dryer.EnumType.DryingTarget.CupboardDryPlus",
            displayvalue: "Cupboard Dry Plus",
          },
          {
            key: "LaundryCare.Dryer.Option.WrinkleGuard",
            value: "LaundryCare.Dryer.EnumType.WrinkleGuard.Min60",
            name: "Less Ironing",
            displayvalue: "60 min",
          },
          {
            key: "LaundryCare.Dryer.Option.Gentle",
            value: true,
            name: "Gentle Dry",
          },
          {
            key: "LaundryCare.Dryer.Option.ProcessPhase",
            value: "LaundryCare.Dryer.EnumType.ProcessPhase.CupboardDryReached",
            displayvalue: "Cupboard-dry reached",
          },
        ],
      },
    };
    service.applyProgramResult(result);
    const device = devices.get("ha-1");
    assert.strictEqual(device.ActiveProgramSource, "selected");
    assert.strictEqual(device.ActiveProgramPhase, "Cupboard-dry reached");
    assert.deepStrictEqual(device.ActiveProgramDetails, [
      "Drying Target: Cupboard Dry Plus",
      "Less Ironing: 60 min",
      "Gentle Dry",
    ]);
  }

  // fetchActiveProgramForDevice: falls back to selected program on 404 active program,
  // without fetching the program definition (its constraints were never displayed)
  {
    const { service } = createProgramService();
    service.attachClient({
      getActiveProgram: async () => ({
        success: false,
        statusCode: 404,
        error: "No active program",
      }),
      getSelectedProgram: async () => ({
        success: true,
        data: { key: "LaundryCare.Dryer.Program.Synthetic", name: "Synthetics", options: [] },
      }),
    });

    const result = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.source, "selected");
    assert.strictEqual(result.data.name, "Synthetics");
  }

  // fetchActiveProgramForDevice: neither an active nor a selected program is "No active program",
  // and costs exactly those two calls (the program catalogue is not fetched for it)
  {
    const { service } = createProgramService();
    const calls = [];
    const answer = (name, result) => async () => {
      calls.push(name);
      return result;
    };
    const notFound = { success: false, statusCode: 404, error: "Not found" };
    service.attachClient({
      getActiveProgram: answer("active", notFound),
      getSelectedProgram: answer("selected", notFound),
      getAvailablePrograms: answer("available", { success: true, data: { programs: [] } }),
    });

    const result = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "No active program");
    assert.deepStrictEqual(calls, ["active", "selected"]);
  }

  // handleActiveProgramFetchError: rate limit sets rateLimitUntil
  {
    const { service, globalSession } = createProgramService();
    const events = [];
    service.handleActiveProgramFetchError(
      Object.assign(new Error("429 too many requests"), { statusCode: 429 }),
      (n, p) => events.push({ n, p }),
    );
    assert.ok(globalSession.rateLimitUntil > Date.now());
    const evt = events.find((e) => e.n === "INIT_STATUS");
    assert.ok(evt);
    assert.strictEqual(evt.p.status, "device_error");
    assert.strictEqual(evt.p.statusCode, 429);
    assert.strictEqual(evt.p.isRateLimit, true);
  }

  // fetchActiveProgramForDevice: a thrown 404 means "no active program", but a "404" that only
  // appears in an error text (an id, a port) is a real error and must not be swallowed
  {
    const { service, logs } = createProgramService();
    service.attachClient({
      getActiveProgram: async () => {
        const err = new Error("Not found");
        err.statusCode = 404;
        throw err;
      },
    });
    const notFound = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.deepStrictEqual(notFound, { haId: "ha-1", success: false, statusCode: 404, error: "No active program" });

    service.attachClient({
      getActiveProgram: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:4040");
      },
    });
    const failed = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(failed.success, false);
    assert.strictEqual(failed.statusCode, null);
    assert.strictEqual(failed.error, "connect ECONNREFUSED 10.0.0.1:4040");
    assert.ok(logs.some((entry) => entry.level === "error" && entry.message.includes("ECONNREFUSED")));
  }

  // fetchActiveProgramForDevice: a 429 answer is raised with its Retry-After, so the caller
  // can block further requests; other failures come back as a result
  {
    const { service } = createProgramService();
    service.attachClient({
      getActiveProgram: async () => ({ success: false, statusCode: 429, retryAfterSeconds: 120, error: "Too Many" }),
    });
    await assert.rejects(service.fetchActiveProgramForDevice("ha-1", "Washer"), (error) => {
      assert.strictEqual(error.statusCode, 429);
      assert.strictEqual(error.retryAfterSeconds, 120);
      return true;
    });

    service.attachClient({
      getActiveProgram: async () => ({ success: false, statusCode: 500, error: "Internal" }),
    });
    assert.deepStrictEqual(await service.fetchActiveProgramForDevice("ha-1", "Washer"), {
      haId: "ha-1",
      success: false,
      statusCode: 500,
      error: "Internal",
    });

    service.attachClient(null);
    const noClient = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(noClient.success, false);
    assert.match(noClient.error, /not attached/);
  }

  console.log("program-service.test.js OK");
})();
