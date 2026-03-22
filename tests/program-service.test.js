"use strict";

const assert = require("assert");
const ProgramService = require("../lib/program-service");

function createProgramService(overrides = {}) {
  const globalSession = { rateLimitUntil: 0 };
  const logs = [];
  const logger = (level, ...args) => logs.push({ level, message: args.join(" ") });
  const devices = new Map([
    [
      "ha-1",
      {
        haId: "ha-1",
        name: "Washer",
        type: "Washer",
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
      source: "active",
      data: {
        key: "LaundryCare.Washer.Program.EasyCare",
        name: "Easy Care",
        options: [
          { key: "op1" },
          { key: "BSH.Common.Option.EstimatedTotalProgramTime", value: 4200 }
        ]
      }
    };
    const payload = service.applyProgramResult(result);
    assert.ok(payload);
    assert.strictEqual(payload.name, "Washer");
    const device = devices.get("ha-1");
    assert.strictEqual(device.optionsApplied.length, 2);
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
            displayvalue: "Cupboard Dry Plus"
          },
          {
            key: "LaundryCare.Dryer.Option.WrinkleGuard",
            value: "LaundryCare.Dryer.EnumType.WrinkleGuard.Min60",
            name: "Less Ironing",
            displayvalue: "60 min"
          },
          {
            key: "LaundryCare.Dryer.Option.Gentle",
            value: true,
            name: "Gentle Dry"
          },
          {
            key: "LaundryCare.Dryer.Option.ProcessPhase",
            value: "LaundryCare.Dryer.EnumType.ProcessPhase.CupboardDryReached",
            displayvalue: "Cupboard-dry reached"
          }
        ]
      },
      availableProgram: {
        key: "LaundryCare.Dryer.Program.Synthetic",
        options: [
          {
            key: "LaundryCare.Dryer.Option.DryingTarget",
            constraints: {
              allowedvalues: ["LaundryCare.Dryer.EnumType.DryingTarget.CupboardDryPlus"]
            }
          }
        ]
      }
    };
    service.applyProgramResult(result);
    const device = devices.get("ha-1");
    assert.strictEqual(device.ActiveProgramSource, "selected");
    assert.strictEqual(device.ActiveProgramPhase, "Cupboard-dry reached");
    assert.deepStrictEqual(device.ActiveProgramDetails, [
      "Drying Target: Cupboard Dry Plus",
      "Less Ironing: 60 min",
      "Gentle Dry"
    ]);
    assert.deepStrictEqual(device.AvailableOptionDetails, ["Drying Target"]);
  }

  // applyProgramResult: stores available programs and constraints when no active program exists
  {
    const { service, devices } = createProgramService();
    const result = {
      haId: "ha-1",
      source: "available",
      data: {
        programs: [
          { key: "ConsumerProducts.CoffeeMaker.Program.Beverage.Coffee", name: "Coffee" },
          { key: "ConsumerProducts.CoffeeMaker.Program.Beverage.Espresso", name: "Espresso" }
        ],
        programDefinition: {
          key: "ConsumerProducts.CoffeeMaker.Program.Beverage.Coffee",
          options: [
            {
              key: "ConsumerProducts.CoffeeMaker.Option.FillQuantity",
              unit: "ml",
              constraints: { min: 60, max: 260 }
            }
          ]
        }
      }
    };

    service.applyProgramResult(result);
    const device = devices.get("ha-1");
    assert.deepStrictEqual(device.AvailablePrograms, ["Coffee", "Espresso"]);
    assert.deepStrictEqual(device.AvailableOptionDetails, ["Fill Quantity: 60-260 ml"]);
    assert.strictEqual(device.ActiveProgramName, undefined);
  }

  // fetchActiveProgramForDevice: falls back to selected program on 404 active program
  {
    const { service } = createProgramService();
    service.attachClient({
      getActiveProgram: async () => ({
        success: false,
        statusCode: 404,
        error: "No active program"
      }),
      getSelectedProgram: async () => ({
        success: true,
        data: { key: "LaundryCare.Dryer.Program.Synthetic", name: "Synthetics", options: [] }
      }),
      applyEventToDevice() {}
    });

    const result = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.source, "selected");
    assert.strictEqual(result.data.name, "Synthetics");
  }

  // fetchActiveProgramForDevice: does not fall back to available programs for washers
  {
    const { service } = createProgramService();
    service.attachClient({
      getActiveProgram: async () => ({ success: false, statusCode: 404, error: "Not found" }),
      getSelectedProgram: async () => ({ success: false, statusCode: 404, error: "Not found" }),
      getAvailablePrograms: async () => ({
        success: true,
        data: {
          programs: [
            { key: "Cooking.Common.Program.Hood.Venting", name: "Fan setting" },
            { key: "Cooking.Common.Program.Hood.Automatic", name: "Automatic" }
          ]
        }
      }),
      getAvailableProgram: async () => ({
        success: true,
        data: {
          key: "Cooking.Common.Program.Hood.Venting",
          options: [
            {
              key: "Cooking.Common.Option.Hood.VentingLevel",
              constraints: {
                allowedvalues: ["Cooking.Hood.EnumType.Stage.FanStage01"]
              }
            }
          ]
        }
      }),
      applyEventToDevice() {}
    });

    const result = await service.fetchActiveProgramForDevice("ha-1", "Washer");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "No active program");
  }

  // fetchActiveProgramForDevice: still falls back to available programs for non-blocked types
  {
    const devices = new Map([
      [
        "ha-hood",
        {
          haId: "ha-hood",
          name: "Hood",
          type: "Cooktop",
          optionsApplied: []
        }
      ]
    ]);
    const { service } = createProgramService({ devices });
    service.attachClient({
      getActiveProgram: async () => ({ success: false, statusCode: 404, error: "Not found" }),
      getSelectedProgram: async () => ({ success: false, statusCode: 404, error: "Not found" }),
      getAvailablePrograms: async () => ({
        success: true,
        data: {
          programs: [
            { key: "Cooking.Common.Program.Hood.Venting", name: "Fan setting" },
            { key: "Cooking.Common.Program.Hood.Automatic", name: "Automatic" }
          ]
        }
      }),
      getAvailableProgram: async () => ({
        success: true,
        data: {
          key: "Cooking.Common.Program.Hood.Venting",
          options: [
            {
              key: "Cooking.Common.Option.Hood.VentingLevel",
              constraints: {
                allowedvalues: ["Cooking.Hood.EnumType.Stage.FanStage01"]
              }
            }
          ]
        }
      }),
      applyEventToDevice() {}
    });

    const result = await service.fetchActiveProgramForDevice("ha-hood", "Hood");
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.source, "available");
    assert.strictEqual(result.data.programs.length, 2);
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
