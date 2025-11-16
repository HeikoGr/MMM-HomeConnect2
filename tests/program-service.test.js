"use strict";

const assert = require("assert");
const ProgramService = require("../lib/program-service");

function createProgramService(overrides = {}) {
  const globalSession = { rateLimitUntil: 0 };
  const logs = [];
  const logger = (level, ...args) =>
    logs.push({ level, message: args.join(" ") });
  const devices = new Map([
    [
      "ha-1",
      {
        haId: "ha-1",
        name: "Washer",
        optionsApplied: []
      }
    ]
  ]);
  const service = new ProgramService({
    logger,
    globalSession,
    activeProgramManager: null,
    devices,
    ...overrides
  });
  service.attachClient({
    applyEventToDevice(device, option) {
      device.optionsApplied.push(option);
    }
  });
  return { service, globalSession, logs, devices };
}

(async () => {
  // applyProgramResult: applies options and returns payload
  {
    const { service, devices } = createProgramService();
    const result = {
      haId: "ha-1",
      data: {
        options: [{ key: "op1" }]
      }
    };
    const payload = service.applyProgramResult(result);
    assert.ok(payload);
    assert.strictEqual(payload.name, "Washer");
    const device = devices.get("ha-1");
    assert.strictEqual(device.optionsApplied.length, 1);
  }

  // handleActiveProgramFetchError: rate limit sets rateLimitUntil
  {
    const { service, globalSession } = createProgramService();
    const events = [];
    service.handleActiveProgramFetchError(
      Object.assign(new Error("429 too many requests"), { statusCode: 429 }),
      (n, p) => events.push({ n, p })
    );
    assert.ok(globalSession.rateLimitUntil > Date.now());
    const evt = events.find((e) => e.n === "INIT_STATUS");
    assert.ok(evt);
    assert.strictEqual(evt.p.status, "device_error");
  }

  console.log("program-service.test.js OK");
})();
