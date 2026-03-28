"use strict";

const assert = require("assert");
const deviceUtils = require("../lib/device-utils");

const modulePath = require.resolve("../MMM-HomeConnect2.js");

function installFrontendGlobals() {
  const originals = {
    Log: globalThis.Log,
    Module: globalThis.Module,
    config: globalThis.config,
    window: globalThis.window,
    document: globalThis.document
  };

  globalThis.Log = {
    log() {},
    warn() {},
    error() {}
  };

  globalThis.config = { language: "en" };
  globalThis.window = {
    HomeConnectDeviceUtils: {
      parseRemainingSeconds: deviceUtils.parseRemainingSeconds,
      parseStartInRelativeSeconds: deviceUtils.parseStartInRelativeSeconds,
      parseProgress: deviceUtils.parseProgress,
      parseEstimatedTotalSeconds: deviceUtils.parseEstimatedTotalSeconds,
      isEstimatedDuration: deviceUtils.isEstimatedDuration,
      getDeviceTypeMeta: deviceUtils.getDeviceTypeMeta,
      deviceAppearsActive: deviceUtils.deviceAppearsActive,
      isDeviceConnected: deviceUtils.isDeviceConnected,
      isDeviceExplicitlyDisconnected: deviceUtils.isDeviceExplicitlyDisconnected,
      shouldDisplayDevice: deviceUtils.shouldDisplayDevice
    }
  };
  globalThis.document = {
    documentElement: { lang: "en" },
    createElement() {
      return { innerHTML: "" };
    }
  };

  return () => {
    globalThis.Log = originals.Log;
    globalThis.Module = originals.Module;
    globalThis.config = originals.config;
    globalThis.window = originals.window;
    globalThis.document = originals.document;
  };
}

function loadModuleDefinition() {
  let definition = null;

  global.Module = {
    register(name, moduleDefinition) {
      definition = moduleDefinition;
      return moduleDefinition;
    }
  };

  delete require.cache[modulePath];
  require(modulePath);
  delete require.cache[modulePath];

  if (!definition) {
    throw new Error("Failed to load MMM-HomeConnect2 module definition");
  }

  return definition;
}

function createInstance(overrides = {}) {
  const definition = loadModuleDefinition();
  return {
    ...definition,
    name: "MMM-HomeConnect2",
    defaults: { ...definition.defaults },
    config: { ...definition.defaults, ...(overrides.config || {}) },
    devices: overrides.devices || [],
    authInfo: overrides.authInfo || null,
    authStatus: overrides.authStatus || null,
    debugStats: overrides.debugStats || null,
    lastInitStatus: overrides.lastInitStatus || null,
    deviceRuntimeHints: overrides.deviceRuntimeHints || {},
    instanceId: "test-instance",
    translate(key) {
      return key;
    },
    updateDom() {},
    sendSocketNotification() {}
  };
}

(() => {
  const restoreGlobals = installFrontendGlobals();

  try {
    const runningInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Eco 40-60",
          ActiveProgramDetails: ["Silent", "varioSpeed"],
          ProgramProgress: 35,
          RemainingProgramTime: 1800
        }
      ]
    });
    const runningDom = runningInstance.getDom();
    assert.ok(runningDom.innerHTML.includes("Eco 40-60"));
    assert.ok(runningDom.innerHTML.includes("Silent • varioSpeed"));
    assert.ok(runningDom.innerHTML.includes("35%"));
    assert.ok(runningDom.innerHTML.includes("deviceProgressBar"));
    assert.ok(runningDom.innerHTML.includes("fa-play"));
    assert.ok(!runningDom.innerHTML.includes("AVAILABLE_PROGRAMS"));

    const fallbackRunningInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          ActiveProgramName: "Cotton",
          ActiveProgramDetails: ["Temperatur: 40 °C"],
          RemainingProgramTime: { value: "PT20M" }
        }
      ]
    });
    const fallbackRunningDom = fallbackRunningInstance.getDom();
    assert.ok(fallbackRunningDom.innerHTML.includes("fa-play"));

    const selectedProgramInstance = createInstance({
      config: {
        showDeviceIcon: false,
        showDeviceIfInfoIsAvailable: true,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "Off",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          ActiveProgramDetails: ["Cupboard Dry Plus", "Low Heat"]
        }
      ]
    });
    const selectedDom = selectedProgramInstance.getDom();
    assert.ok(selectedDom.innerHTML.includes("NO_ACTIVE_APPLIANCES"));
    assert.ok(!selectedDom.innerHTML.includes("Synthetics"));
    assert.ok(!selectedDom.innerHTML.includes("SELECTED_PROGRAM"));
    assert.ok(!selectedDom.innerHTML.includes("Cupboard Dry Plus • Low Heat"));

    const runningSelectedProgramInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          ActiveProgramDetails: ["Cupboard Dry Plus", "Low Heat"],
          ProgramProgress: 15,
          RemainingProgramTime: 1500
        }
      ]
    });
    const runningSelectedDom = runningSelectedProgramInstance.getDom();
    assert.ok(runningSelectedDom.innerHTML.includes("Synthetics"));
    assert.ok(runningSelectedDom.innerHTML.includes("Cupboard Dry Plus • Low Heat"));

    const finishedProgramInstance = createInstance({
      config: {
        showDeviceIcon: false,
        showDeviceIfInfoIsAvailable: true,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Finished",
          ActiveProgramName: "Cotton",
          ActiveProgramSource: "active",
          ActiveProgramDetails: ["Silent Wash", "varioSpeed"]
        }
      ]
    });
    const finishedProgramDom = finishedProgramInstance.getDom();
    assert.ok(finishedProgramDom.innerHTML.includes("Cotton"));
    assert.ok(finishedProgramDom.innerHTML.includes("Silent Wash • varioSpeed"));

    const wrinkleGuardInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Synthetics",
          ProgramProgress: 100,
          RemainingProgramTime: 0,
          ActiveProgramDetails: ["Wrinkle Block: 120 min"]
        }
      ]
    });
    const wrinkleGuardDom = wrinkleGuardInstance.getDom();
    assert.ok(wrinkleGuardDom.innerHTML.includes("WRINKLE_PROTECTION_ACTIVE"));
    assert.ok(!wrinkleGuardDom.innerHTML.includes("fa-play"));

    const delayedStartInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.DelayedStart",
          ActiveProgramName: "Easy Care",
          RemainingProgramTimeIsEstimated: true,
          "BSH.Common.Option.StartInRelative": { value: "PT2H29M" }
        }
      ]
    });
    const delayedStartDom = delayedStartInstance.getDom();
    assert.ok(delayedStartDom.innerHTML.includes("DELAYED_START"));
    assert.ok(delayedStartDom.innerHTML.includes("STARTS_IN"));
    assert.ok(delayedStartDom.innerHTML.includes("APPROX_PREFIX 2h 29m"));
    assert.ok(delayedStartDom.innerHTML.includes("fa-clock-o"));
    assert.ok(!delayedStartDom.innerHTML.includes("fa-play"));

    const offlineDeviceInstance = createInstance({
      config: {
        showDeviceIcon: false,
        showDeviceIfInfoIsAvailable: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "Off",
          connected: false
        }
      ]
    });
    const offlineDom = offlineDeviceInstance.getDom();
    assert.ok(offlineDom.innerHTML.includes("Washer"));
    assert.ok(offlineDom.innerHTML.includes("DEVICE_NOT_CONNECTED"));
    assert.ok(offlineDom.innerHTML.includes("deviceOffline"));
    assert.ok(offlineDom.innerHTML.includes("fa-chain-broken"));

    const capabilityInstance = createInstance({
      config: {
        showDeviceIcon: true,
        showDeviceIfInfoIsAvailable: true,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Coffee machine",
          type: "Microwave",
          PowerState: "Off",
          AvailablePrograms: ["Coffee", "Espresso"],
          AvailableOptionDetails: ["Bean Amount", "Fill Quantity: 60-260 ml"],
          DeviceAlertsByKey: {
            tank: "Water tank empty"
          }
        }
      ]
    });
    const capabilityDom = capabilityInstance.getDom();
    assert.ok(capabilityDom.innerHTML.includes("deviceIconFallback"));
    assert.ok(capabilityDom.innerHTML.includes("ACTIVE_ALERTS"));

    const washerAvailableProgramsInstance = createInstance({
      config: {
        showDeviceIcon: true,
        showDeviceIfInfoIsAvailable: true,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "Off",
          AvailablePrograms: ["Cotton", "Easy Care"],
          AvailableOptionDetails: ["Temperature", "Spin Speed"]
        }
      ]
    });
    const washerAvailableProgramsDom = washerAvailableProgramsInstance.getDom();
    assert.ok(!washerAvailableProgramsDom.innerHTML.includes("AVAILABLE_PROGRAMS"));
    assert.ok(!washerAvailableProgramsDom.innerHTML.includes("AVAILABLE_OPTIONS"));
    assert.ok(!washerAvailableProgramsDom.innerHTML.includes("Temperature"));

    const emptyInstance = createInstance({
      config: {
        showAlwaysAllDevices: false,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false,
        showDeviceIfInfoIsAvailable: false
      },
      devices: [
        {
          name: "Idle fridge",
          type: "FridgeFreezer",
          PowerState: "Off"
        }
      ]
    });
    const emptyDom = emptyInstance.getDom();
    assert.ok(emptyDom.innerHTML.includes("NO_ACTIVE_APPLIANCES"));

    const authInstance = createInstance({
      authInfo: {
        status: "waiting",
        verification_uri: "https://example.invalid/device",
        user_code: "ABCD-EFGH",
        expires_in_minutes: 10
      }
    });
    const authDom = authInstance.getDom();
    assert.ok(authDom.innerHTML.includes("AUTH_TITLE"));
    assert.ok(authDom.innerHTML.includes("ABCD-EFGH"));
    assert.ok(authDom.innerHTML.includes("auth-container"));

    console.log("frontend-render.test.js OK");
  } finally {
    restoreGlobals();
  }
})();
