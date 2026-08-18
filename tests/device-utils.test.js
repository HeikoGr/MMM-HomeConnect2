"use strict";

const assert = require("assert");
const {
  collectProgramOptionLabels,
  extractValueByType,
  getDeviceTypeMeta,
  parseDurationSeconds,
  parseFinishInRelativeSeconds,
  parseRemainingSeconds,
  parseEstimatedTotalSeconds,
  isEstimatedDuration,
  isDoorOpen,
  hasInformativeState,
  shouldDisplayDevice,
  summarizeAvailablePrograms,
  summarizeProgramConstraints,
  deviceAppearsActive,
  parseOperationState
} = require("../lib/device-utils");

(() => {
  assert.strictEqual(
    extractValueByType({ value: "42" }, "number", (val) => {
      const parsed = Number(val);
      return Number.isFinite(parsed) ? parsed : null;
    }),
    42
  );
  assert.strictEqual(
    extractValueByType({ displayValue: "17.5" }, "number", (val) => {
      const parsed = Number(val);
      return Number.isFinite(parsed) ? parsed : null;
    }),
    17.5
  );

  assert.strictEqual(parseDurationSeconds(95), 95);
  assert.strictEqual(parseDurationSeconds("120"), 120);
  assert.strictEqual(parseDurationSeconds("PT1H2M3S"), 3723);
  assert.strictEqual(parseDurationSeconds({ value: "PT45M" }), 2700);
  assert.strictEqual(parseDurationSeconds({ displayValue: "PT30S" }), 30);
  assert.strictEqual(parseRemainingSeconds({ RemainingProgramTime: { value: "PT20M" } }), 1200);
  assert.strictEqual(
    parseFinishInRelativeSeconds({ "BSH.Common.Option.FinishInRelative": { value: "PT2H10M" } }),
    7800
  );
  assert.strictEqual(
    parseEstimatedTotalSeconds({
      "BSH.Common.Option.EstimatedTotalProgramTime": { value: "PT1H" }
    }),
    3600
  );
  assert.strictEqual(
    isEstimatedDuration({ RemainingProgramTimeIsEstimated: { value: true } }),
    true
  );
  assert.strictEqual(isDoorOpen({ DoorState: "Open" }), true);
  assert.strictEqual(
    hasInformativeState({
      ActiveProgramName: "Eco 40-60"
    }),
    true
  );
  assert.strictEqual(
    shouldDisplayDevice(
      {
        ActiveProgramName: "Eco 40-60"
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: true
      }
    ),
    true
  );
  assert.strictEqual(
    shouldDisplayDevice(
      {
        PowerState: "Off"
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: false
      }
    ),
    false
  );

  assert.strictEqual(
    shouldDisplayDevice(
      {
        PowerState: "Off",
        connected: false
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: false
      }
    ),
    true,
    "Explicitly disconnected devices should stay visible"
  );

  assert.strictEqual(
    deviceAppearsActive({ RemainingProgramTime: { value: "PT20M" } }),
    true,
    "Duration objects should mark device as active"
  );

  // Operation states are matched exactly - "Inactive" contains "Active", so any
  // substring test would report every idle appliance as running.
  const stateMatrix = [
    ["Inactive", { known: true, isRun: false, hasProgramInProgress: false }, false],
    ["Ready", { known: true, isRun: false, hasProgramInProgress: false }, false],
    ["DelayedStart", { known: true, isRun: false, isDelayedStart: true }, true],
    ["Run", { known: true, isRun: true }, true],
    ["Pause", { known: true, isRun: false, isPaused: true }, true],
    ["ActionRequired", { known: true, isRun: false, hasProgramInProgress: true }, true],
    ["Aborting", { known: true, isRun: false, hasProgramInProgress: true }, true],
    ["Finished", { known: true, isRun: false, isFinished: true }, false],
    ["Error", { known: true, isRun: false, hasProgramInProgress: false }, false],
    ["SomeFutureState", { known: false, isRun: false }, false]
  ];

  stateMatrix.forEach(([label, expected, expectedActive]) => {
    const device = {
      PowerState: "On",
      OperationState: `BSH.Common.EnumType.OperationState.${label}`
    };
    const parsed = parseOperationState(device);

    Object.entries(expected).forEach(([key, value]) => {
      assert.strictEqual(parsed[key], value, `${label}: ${key} should be ${value}`);
    });
    assert.strictEqual(
      deviceAppearsActive(device),
      expectedActive,
      `${label}: deviceAppearsActive should be ${expectedActive}`
    );
  });

  assert.strictEqual(
    parseOperationState({}).known,
    false,
    "A missing operation state must stay unknown instead of defaulting to a value"
  );

  assert.strictEqual(
    parseOperationState({
      OperationState: { value: "BSH.Common.EnumType.OperationState.Run" }
    }).isRun,
    true,
    "Wrapped operation state objects must be unwrapped"
  );

  assert.strictEqual(
    deviceAppearsActive({
      PowerState: "On",
      OperationState: "BSH.Common.EnumType.OperationState.Inactive",
      RemainingProgramTime: { value: "PT20M" },
      ProgramProgress: 40
    }),
    false,
    "A known idle state must win over stale remaining time and progress values"
  );

  assert.strictEqual(
    deviceAppearsActive({
      PowerState: "On",
      ActiveProgramSource: "selected",
      RemainingProgramTime: { value: "PT20M" },
      ProgramProgress: 5
    }),
    false,
    "Selected programs must not be treated as running based on estimate data alone"
  );

  assert.strictEqual(
    shouldDisplayDevice(
      {
        PowerState: "On",
        ActiveProgramSource: "selected",
        ActiveProgramName: "Synthetics",
        RemainingProgramTime: { value: "PT1H15M" },
        ProgramProgress: 3
      },
      {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: true
      }
    ),
    true,
    "Power-on devices with selected program metadata should stay visible"
  );

  assert.deepStrictEqual(
    collectProgramOptionLabels({
      options: [
        {
          key: "ConsumerProducts.CoffeeMaker.Option.BeanAmount",
          value: "ConsumerProducts.CoffeeMaker.EnumType.BeanAmount.Strong"
        },
        {
          key: "ConsumerProducts.CoffeeMaker.Option.FillQuantity",
          value: 240,
          unit: "ml"
        }
      ]
    }),
    ["Bean Amount: Strong", "Fill Quantity: 240 ml"]
  );

  assert.deepStrictEqual(
    collectProgramOptionLabels({
      options: [
        {
          key: "LaundryCare.Washer.Option.SpeedPerfect",
          name: "varioSpeed",
          value: "LaundryCare.Washer.EnumType.SpeedPerfect.On"
        },
        {
          key: "LaundryCare.Washer.Option.SilentWash",
          name: "Leiser waschen",
          value: "LaundryCare.Washer.EnumType.SilentWash.Off"
        },
        {
          key: "LaundryCare.Washer.Option.SteamAssist",
          name: "Bedampfen",
          value: true
        },
        {
          key: "LaundryCare.Washer.Option.IntensivePlus",
          name: "Intensiv Plus",
          value: false
        },
        {
          key: "LaundryCare.Washer.Option.Temperature",
          name: "Temperatur",
          value: "LaundryCare.Washer.EnumType.Temperature.GC40"
        },
        {
          key: "LaundryCare.Washer.Option.SpinSpeed",
          name: "Schleudern",
          value: "LaundryCare.Washer.EnumType.SpinSpeed.RPM1400"
        }
      ]
    }),
    ["Temperatur: 40 °C", "Schleudern: 1400 rpm", "varioSpeed", "Bedampfen"]
  );

  assert.deepStrictEqual(
    summarizeAvailablePrograms([
      { key: "ConsumerProducts.CoffeeMaker.Program.Beverage.Coffee", name: "Coffee" },
      { key: "ConsumerProducts.CoffeeMaker.Program.Beverage.Espresso", name: "Espresso" }
    ]),
    ["Coffee", "Espresso"]
  );

  assert.deepStrictEqual(
    summarizeProgramConstraints({
      options: [
        {
          key: "ConsumerProducts.CoffeeMaker.Option.FillQuantity",
          unit: "ml",
          constraints: { min: 60, max: 260 }
        },
        {
          key: "ConsumerProducts.CoffeeMaker.Option.BeanAmount",
          constraints: {
            allowedvalues: ["ConsumerProducts.CoffeeMaker.EnumType.BeanAmount.Mild"]
          }
        }
      ]
    }),
    ["Fill Quantity: 60-260 ml", "Bean Amount"]
  );

  assert.strictEqual(getDeviceTypeMeta("CoffeeMachine").iconName, "CoffeeMaker.png");
  assert.strictEqual(getDeviceTypeMeta("Microwave").iconName, null);

  assert.strictEqual(
    isDoorOpen({
      RefrigerationDoorStates: {
        freezer: "Freezer: Open"
      }
    }),
    true,
    "Refrigeration compartment door states should count as open doors"
  );

  assert.strictEqual(
    hasInformativeState({
      DeviceAlertsByKey: {
        alarm: "Water tank empty"
      }
    }),
    true,
    "Device alerts should make a device informative"
  );

  console.log("device-utils.test.js OK");
})();
