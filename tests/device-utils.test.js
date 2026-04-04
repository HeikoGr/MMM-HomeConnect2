"use strict";

const assert = require("assert");
const {
  collectProgramOptionLabels,
  getNumericValue,
  getDeviceTypeMeta,
  parseDurationSeconds,
  parseRemainingSeconds,
  parseEstimatedTotalSeconds,
  isEstimatedDuration,
  isDoorOpen,
  hasInformativeState,
  shouldDisplayDevice,
  summarizeAvailablePrograms,
  summarizeProgramConstraints,
  deviceAppearsActive
} = require("../lib/device-utils");

(() => {
  assert.strictEqual(getNumericValue({ value: "42" }), 42);
  assert.strictEqual(getNumericValue({ displayValue: "17.5" }), 17.5);

  assert.strictEqual(parseDurationSeconds(95), 95);
  assert.strictEqual(parseDurationSeconds("120"), 120);
  assert.strictEqual(parseDurationSeconds("PT1H2M3S"), 3723);
  assert.strictEqual(parseDurationSeconds({ value: "PT45M" }), 2700);
  assert.strictEqual(parseDurationSeconds({ displayValue: "PT30S" }), 30);
  assert.strictEqual(parseRemainingSeconds({ RemainingProgramTime: { value: "PT20M" } }), 1200);
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
    false,
    "Power-on devices with only a selected program should stay hidden"
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
