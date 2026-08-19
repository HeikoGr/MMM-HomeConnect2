"use strict";

const assert = require("assert");
const deviceUtils = require("../lib/device-utils");
const shared = require("../lib/mmm-shared/mmm-shared");

const modulePath = require.resolve("../MMM-HomeConnect2.js");

function installFrontendGlobals() {
  const originals = {
    Log: globalThis.Log,
    Module: globalThis.Module,
    config: globalThis.config,
    window: globalThis.window,
    document: globalThis.document,
    navigator: Reflect.get(globalThis, "navigator")
  };

  globalThis.Log = {
    log() { },
    warn() { },
    error() { }
  };

  globalThis.config = { language: "en" };
  globalThis.window = {
    HomeConnectDeviceUtils: {
      parseRemainingSeconds: deviceUtils.parseRemainingSeconds,
      parseStartInRelativeSeconds: deviceUtils.parseStartInRelativeSeconds,
      parseFinishInRelativeSeconds: deviceUtils.parseFinishInRelativeSeconds,
      parseProgress: deviceUtils.parseProgress,
      parseEstimatedTotalSeconds: deviceUtils.parseEstimatedTotalSeconds,
      isEstimatedDuration: deviceUtils.isEstimatedDuration,
      getDeviceTypeMeta: deviceUtils.getDeviceTypeMeta,
      deviceAppearsActive: deviceUtils.deviceAppearsActive,
      isDeviceConnected: deviceUtils.isDeviceConnected,
      isDeviceExplicitlyDisconnected: deviceUtils.isDeviceExplicitlyDisconnected,
      shouldDisplayDevice: deviceUtils.shouldDisplayDevice,
      parseOperationState: deviceUtils.parseOperationState
    }
  };
  globalThis.document = {
    documentElement: { lang: "en" },
    createElement() {
      return { innerHTML: "" };
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      language: "en-US",
      languages: ["en-US", "en"]
    }
  });

  return () => {
    globalThis.Log = originals.Log;
    globalThis.Module = originals.Module;
    globalThis.config = originals.config;
    globalThis.window = originals.window;
    globalThis.document = originals.document;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: originals.navigator
    });
  };
}

function loadModuleDefinition() {
  let definition = null;

  global.Module = {
    register(_name, moduleDefinition) {
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
  const instance = {
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
    notifications: {
      EVENT: "MMM-HomeConnect2_EVENT"
    },
    translate(key) {
      return key;
    },
    updateDom() { },
    sendSocketNotification() { }
  };

  // The module renders through the shared lifecycle, which start() would set up.
  instance.lifecycle = shared.createLifecycle({ module: instance, updateInterval: 0 });
  return instance;
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
    assert.ok(runningDom.innerHTML.includes("ACTIVE_PROGRAM: Eco 40-60"));
    assert.ok(runningDom.innerHTML.includes("Silent • varioSpeed"));
    assert.ok(runningDom.innerHTML.includes("35%"));
    assert.ok(runningDom.innerHTML.includes("deviceProgressBar"));
    assert.ok(runningDom.innerHTML.includes("fa-play"));
    assert.ok(!runningDom.innerHTML.includes("AVAILABLE_PROGRAMS"));

    const runningDisplayState = runningInstance.buildDeviceDisplayState(
      runningInstance.devices[0],
      {},
      runningInstance.getDeviceUtils()
    );
    assert.ok(runningDisplayState.runtime);
    assert.ok(runningDisplayState.presentation);
    assert.strictEqual(runningDisplayState.runtime.percent, 35);
    assert.strictEqual(
      runningDisplayState.presentation.programMeta,
      "ACTIVE_PROGRAM: Eco 40-60"
    );

    const configuredLanguageInstance = createInstance({
      config: {
        apiLanguage: "da"
      }
    });
    assert.strictEqual(configuredLanguageInstance.getPreferredApiLanguage(), "da");

    const magicMirrorLanguageInstance = createInstance({
      config: {
        apiLanguage: ""
      }
    });
    globalThis.config.language = "de";
    assert.strictEqual(magicMirrorLanguageInstance.getPreferredApiLanguage(), "de");

    const browserLanguageInstance = createInstance({
      config: {
        apiLanguage: ""
      }
    });
    globalThis.config.language = "";
    const browserNavigator = Reflect.get(globalThis, "navigator");
    browserNavigator.languages = ["fr-FR", "fr"];
    browserNavigator.language = "fr-FR";
    assert.strictEqual(browserLanguageInstance.getPreferredApiLanguage(), "fr-FR");

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
    // No usable OperationState means we cannot know whether a program runs. The
    // remaining time still renders, but no play icon claims something we cannot prove.
    const fallbackRunningDom = fallbackRunningInstance.getDom();
    assert.ok(!fallbackRunningDom.innerHTML.includes("fa-play"));
    assert.ok(fallbackRunningDom.innerHTML.includes("fa-toggle-on"));
    assert.ok(fallbackRunningDom.innerHTML.includes("ACTIVE_PROGRAM: Cotton"));
    assert.ok(fallbackRunningDom.innerHTML.includes("DONE_IN"));

    // The play icon must follow the reported operation state, never a guess. An
    // idle washing machine is the case that used to show a phantom play icon,
    // because "Inactive" matched a substring test for "Active".
    const iconMatrix = [
      ["Inactive", "fa-toggle-on", "fa-play"],
      ["Ready", "fa-toggle-on", "fa-play"],
      ["Run", "fa-play", "fa-toggle-on"],
      ["Pause", "fa-pause", "fa-play"],
      ["DelayedStart", "fa-clock-o", "fa-play"],
      ["Finished", "fa-toggle-on", "fa-play"],
      ["ActionRequired", "fa-toggle-on", "fa-play"],
      ["Aborting", "fa-toggle-on", "fa-play"],
      ["SomeFutureState", "fa-toggle-on", "fa-play"]
    ];

    iconMatrix.forEach(([label, expectedIcon, forbiddenIcon]) => {
      const instance = createInstance({
        config: { showAlwaysAllDevices: true },
        devices: [
          {
            name: "Washer",
            type: "Washer",
            PowerState: "On",
            OperationState: `BSH.Common.EnumType.OperationState.${label}`,
            ActiveProgramName: "Eco 40-60",
            RemainingProgramTime: 1800,
            ProgramProgress: 35
          }
        ]
      });
      const html = instance.getDom().innerHTML;
      assert.ok(html.includes(expectedIcon), `${label} should render ${expectedIcon}`);
      assert.ok(!html.includes(forbiddenIcon), `${label} must not render ${forbiddenIcon}`);
    });

    // Powered off appliances never get a program icon, whatever the state says.
    const poweredOffInstance = createInstance({
      config: { showAlwaysAllDevices: true },
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "Off",
          OperationState: "BSH.Common.EnumType.OperationState.Run"
        }
      ]
    });
    const poweredOffHtml = poweredOffInstance.getDom().innerHTML;
    assert.ok(!poweredOffHtml.includes("fa-play"));
    assert.ok(poweredOffHtml.includes("fa-toggle-off"));

    // The selected-program line follows the same evidence rule as the play icon,
    // with delayed start as the one exception: that program is genuinely scheduled.
    const selectedProgramStates = [
      ["Inactive", false],
      ["Ready", false],
      ["Finished", false],
      ["Pause", false],
      ["Run", true],
      ["DelayedStart", true]
    ];

    selectedProgramStates.forEach(([label, shouldShow]) => {
      const instance = createInstance({
        config: { showAlwaysAllDevices: true },
        devices: [
          {
            name: "Dryer",
            type: "Dryer",
            PowerState: "On",
            OperationState: `BSH.Common.EnumType.OperationState.${label}`,
            ActiveProgramName: "Synthetics",
            ActiveProgramSource: "selected",
            ActiveProgramDetails: ["Low Heat"],
            StartInRelative: label === "DelayedStart" ? 3600 : undefined
          }
        ]
      });
      const html = instance.getDom().innerHTML;
      assert.strictEqual(
        html.includes("SELECTED_PROGRAM: Synthetics"),
        shouldShow,
        `${label}: selected program shown should be ${shouldShow}`
      );
      assert.strictEqual(
        html.includes("Low Heat"),
        shouldShow,
        `${label}: program details shown should be ${shouldShow}`
      );
      assert.ok(!html.includes(">Synthetics<"), `${label}: no bare program name leaks through`);
    });

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
    // A selected program is just the dial position - it says nothing about what the
    // appliance is doing, so it stays hidden until the program actually runs.
    const selectedDom = selectedProgramInstance.getDom();
    assert.ok(selectedDom.innerHTML.includes("Dryer"));
    assert.ok(!selectedDom.innerHTML.includes("SELECTED_PROGRAM"));
    assert.ok(!selectedDom.innerHTML.includes("Synthetics"));
    assert.ok(!selectedDom.innerHTML.includes("Cupboard Dry Plus"));

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
    assert.ok(runningSelectedDom.innerHTML.includes("Dryer"));
    assert.ok(runningSelectedDom.innerHTML.includes("SELECTED_PROGRAM: Synthetics"));
    assert.ok(runningSelectedDom.innerHTML.includes("fa-play"));
    assert.ok(runningSelectedDom.innerHTML.includes("15%"));

    const selectedDishwasherInstance = createInstance({
      config: {
        showDeviceIcon: false,
        showDeviceIfInfoIsAvailable: true,
        showDeviceIfDoorIsOpen: false,
        showDeviceIfFailure: false
      },
      devices: [
        {
          name: "Dishwasher",
          type: "Dishwasher",
          PowerState: "Off",
          ActiveProgramName: "Eco 50°",
          ActiveProgramSource: "selected",
          ActiveProgramDetails: ["varioSpeed Plus"]
        }
      ]
    });
    const selectedDishwasherDom = selectedDishwasherInstance.getDom();
    assert.ok(selectedDishwasherDom.innerHTML.includes("Dishwasher"));
    assert.ok(!selectedDishwasherDom.innerHTML.includes("SELECTED_PROGRAM"));
    assert.ok(!selectedDishwasherDom.innerHTML.includes("Eco 50°"));
    assert.ok(!selectedDishwasherDom.innerHTML.includes("varioSpeed Plus"));

    const secondCycleDryerInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          RemainingProgramTime: { value: "PT33M" },
          _initialRemaining: 1980,
          _remainingObservedAt: Date.now()
        }
      ]
    });
    const secondCycleDryerDom = secondCycleDryerInstance.getDom();
    assert.ok(secondCycleDryerDom.innerHTML.includes("fa-play"));
    assert.ok(secondCycleDryerDom.innerHTML.includes("deviceProgressBar"));
    assert.ok(!secondCycleDryerDom.innerHTML.includes("PROGRAM_FINISHED"));

    const recoveryNotifications = [];
    const recoveryInstance = createInstance();
    recoveryInstance.sendSocketNotification = (notification, payload) => {
      recoveryNotifications.push({ notification, payload });
    };

    recoveryInstance.socketNotificationReceived("MMM-HomeConnect2_EVENT", {
      identifier: "test-instance",
      instanceId: "test-instance",
      action: "DEVICES_UPDATE",
      data: [
        {
          haId: "dryer-1",
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          RemainingProgramTime: 1500
        }
      ]
    });

    assert.strictEqual(recoveryNotifications.length, 0);

    recoveryInstance.socketNotificationReceived("MMM-HomeConnect2_EVENT", {
      identifier: "test-instance",
      instanceId: "test-instance",
      action: "DEVICES_UPDATE",
      data: [
        {
          haId: "dryer-1",
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          RemainingProgramTime: 1400
        }
      ]
    });

    assert.strictEqual(
      recoveryNotifications.length,
      0,
      "Expected no frontend-induced recovery request during active program cycle"
    );

    recoveryInstance.socketNotificationReceived("MMM-HomeConnect2_EVENT", {
      identifier: "test-instance",
      instanceId: "test-instance",
      action: "DEVICES_UPDATE",
      data: [
        {
          haId: "dryer-1",
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Mixed Load",
          ActiveProgramSource: "selected",
          RemainingProgramTime: 1200
        }
      ]
    });

    assert.strictEqual(
      recoveryNotifications.length,
      0,
      "Expected no frontend-induced recovery request when the active program cycle changes"
    );

    const delayedStartNotifications = [];
    const delayedStartRecoveryInstance = createInstance();
    delayedStartRecoveryInstance.lastActiveProgramRequestTs = Date.now();
    delayedStartRecoveryInstance.sendSocketNotification = (notification, payload) => {
      delayedStartNotifications.push({ notification, payload });
    };

    delayedStartRecoveryInstance.socketNotificationReceived("MMM-HomeConnect2_EVENT", {
      identifier: "test-instance",
      instanceId: "test-instance",
      action: "DEVICES_UPDATE",
      data: [
        {
          haId: "dryer-2",
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.DelayedStart",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          "BSH.Common.Option.StartInRelative": { value: "PT30M" }
        }
      ]
    });

    assert.strictEqual(
      delayedStartNotifications.length,
      0,
      "Expected no recovery request for delayed start with selected program"
    );

    const selectedDoorOpenInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          DoorState: "Open",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "selected",
          EstimatedTotalProgramTime: 4560,
          RemainingProgramTime: 4560,
          RemainingProgramTimeIsEstimated: true
        }
      ]
    });
    const selectedDoorOpenDom = selectedDoorOpenInstance.getDom();
    assert.ok(selectedDoorOpenDom.innerHTML.includes("Dryer"));
    assert.ok(selectedDoorOpenDom.innerHTML.includes("fa-door-open"));
    assert.ok(!selectedDoorOpenDom.innerHTML.includes("SELECTED_PROGRAM"));
    assert.ok(!selectedDoorOpenDom.innerHTML.includes("1h 16m"));

    // The appliance resets progress to 0 when a cycle ends; a client that stayed
    // online through the whole program keeps that value in its device state. It
    // must render exactly like a freshly started client, which never saw it: the
    // open door and nothing else.
    const staleZeroProgressInstance = createInstance({
      devices: [
        {
          name: "Dishwasher",
          type: "Dishwasher",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Ready",
          DoorState: "Open",
          ProgramProgress: 0,
          RemainingProgramTime: 0
        }
      ]
    });
    const staleZeroProgressDom = staleZeroProgressInstance.getDom();
    assert.ok(staleZeroProgressDom.innerHTML.includes("fa-door-open"));
    assert.ok(!staleZeroProgressDom.innerHTML.includes("<progress"));
    assert.ok(!staleZeroProgressDom.innerHTML.includes("0%"));

    // The same appliance one step further: the cycle is over, the door is open and
    // all that survived is a remaining time stuck at 0 next to the planned
    // duration - reported through the raw API keys, which outlive the friendly
    // ones. (estimatedTotalSeconds - 0) / estimatedTotalSeconds is exactly 100 %,
    // so this used to paint a full bar under an idle appliance for the lifetime of
    // the process. Without a running program neither the bar nor the unattributed
    // duration may appear.
    const staleFullBarInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          connected: true,
          OperationState: "BSH.Common.EnumType.OperationState.Ready",
          DoorState: "Open",
          RemainingProgramTime: 0,
          "BSH.Common.Option.EstimatedTotalProgramTime": 8940,
          "BSH.Common.Option.RemainingProgramTimeIsEstimated": true
        }
      ]
    });
    const staleFullBarDom = staleFullBarInstance.getDom();
    assert.ok(staleFullBarDom.innerHTML.includes("fa-door-open"));
    assert.ok(!staleFullBarDom.innerHTML.includes("<progress"));
    assert.ok(!staleFullBarDom.innerHTML.includes("100%"));
    assert.ok(!staleFullBarDom.innerHTML.includes("2h 29m"));

    // The guard must not cost a running program its bar: with a remaining time
    // the planned duration stays a valid progress source.
    const runningEstimateInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          connected: true,
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Easy Care",
          ActiveProgramSource: "active",
          RemainingProgramTime: 894,
          EstimatedTotalProgramTime: 8940
        }
      ]
    });
    const runningEstimateHtml = runningEstimateInstance.getDom().innerHTML;
    assert.ok(runningEstimateHtml.includes("<progress value='90'"));
    assert.ok(runningEstimateHtml.includes("90%"));

    // A running program whose remaining time reached 0 is reported as finished -
    // the bar gives way to the finished notice rather than a stale 100 %.
    const runningAtEndInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          connected: true,
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Easy Care",
          ActiveProgramSource: "active",
          RemainingProgramTime: 0,
          EstimatedTotalProgramTime: 8940
        }
      ]
    });
    const runningAtEndHtml = runningAtEndInstance.getDom().innerHTML;
    assert.ok(runningAtEndHtml.includes("PROGRAM_FINISHED"));
    assert.ok(!runningAtEndHtml.includes("<progress"));

    // A planned duration stays visible as long as it can be attributed to the
    // program it belongs to.
    const plannedDurationInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          connected: true,
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Easy Care",
          ActiveProgramSource: "active",
          EstimatedTotalProgramTime: 8940
        }
      ]
    });
    const plannedDurationHtml = plannedDurationInstance.getDom().innerHTML;
    assert.ok(plannedDurationHtml.includes("ACTIVE_PROGRAM: Easy Care"));
    assert.ok(plannedDurationHtml.includes("2h 29m"));

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

    // The mirror image of the case above: an appliance back in Ready reports no
    // program at all, so a device object still carrying "active" from the run that
    // just ended must not keep announcing it. Unlike the finished appliance there
    // is nothing left to name here - only the open door.
    const staleActiveClaimInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          connected: true,
          OperationState: "BSH.Common.EnumType.OperationState.Ready",
          DoorState: "Open",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "active",
          ActiveProgramDetails: ["Drying target: Extra Dry", "Wrinkle Block: 120 min"],
          RemainingProgramTime: 0,
          FinishInRelative: 4560
        }
      ]
    });
    const staleActiveClaimHtml = staleActiveClaimInstance.getDom().innerHTML;
    assert.ok(staleActiveClaimHtml.includes("fa-door-open"));
    assert.ok(!staleActiveClaimHtml.includes("ACTIVE_PROGRAM"));
    assert.ok(!staleActiveClaimHtml.includes("Synthetics"));
    assert.ok(!staleActiveClaimHtml.includes("Extra Dry"));
    assert.ok(!staleActiveClaimHtml.includes("<progress"));

    // A running appliance keeps its active program - the guard only fires on the
    // states that mean "no program at all".
    const genuinelyActiveInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          connected: true,
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Run",
          ActiveProgramName: "Synthetics",
          ActiveProgramSource: "active",
          ActiveProgramDetails: ["Drying target: Extra Dry"],
          RemainingProgramTime: 1800
        }
      ]
    });
    const genuinelyActiveHtml = genuinelyActiveInstance.getDom().innerHTML;
    assert.ok(genuinelyActiveHtml.includes("ACTIVE_PROGRAM: Synthetics"));
    assert.ok(genuinelyActiveHtml.includes("Extra Dry"));

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
    assert.strictEqual(
      (wrinkleGuardDom.innerHTML.match(/WRINKLE_PROTECTION_ACTIVE/g) || []).length,
      1
    );

    const localizedWrinkleGuardInstance = createInstance({
      devices: [
        {
          name: "Dryer",
          type: "Dryer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.Finished",
          ActiveProgramName: "Pflegeleicht",
          ActiveProgramSource: "active",
          ActiveProgramDetails: ["Trockenziel: Schranktrocken Plus", "Knitterschutz: 120 min"]
        }
      ]
    });
    const localizedWrinkleGuardDom = localizedWrinkleGuardInstance.getDom();
    assert.ok(localizedWrinkleGuardDom.innerHTML.includes("WRINKLE_PROTECTION_ACTIVE"));
    assert.ok(!localizedWrinkleGuardDom.innerHTML.includes("PROGRAM_FINISHED"));
    assert.strictEqual(
      (localizedWrinkleGuardDom.innerHTML.match(/WRINKLE_PROTECTION_ACTIVE/g) || []).length,
      1
    );

    const delayedStartInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.DelayedStart",
          ActiveProgramName: "Easy Care",
          RemainingProgramTimeIsEstimated: true,
          "BSH.Common.Option.StartInRelative": { value: "PT2H29M" },
          "BSH.Common.Option.FinishInRelative": { value: "PT4H10M" }
        }
      ]
    });
    const originalDateNow = Date.now;
    Date.now = () => new Date("2026-04-04T10:00:00Z").getTime();
    const delayedStartDom = delayedStartInstance.getDom();
    Date.now = originalDateNow;
    assert.ok(delayedStartDom.innerHTML.includes("DELAYED_START"));
    assert.ok(delayedStartDom.innerHTML.includes("STARTS_IN"));
    assert.ok(delayedStartDom.innerHTML.includes("APPROX_PREFIX 2h 29m"));
    assert.ok(delayedStartDom.innerHTML.includes("ENDS_AT"));
    assert.ok(delayedStartDom.innerHTML.includes("APPROX_PREFIX"));
    assert.ok(delayedStartDom.innerHTML.includes("fa-clock-o"));
    assert.ok(!delayedStartDom.innerHTML.includes("fa-play"));

    const delayedStartFinishOnlyInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          OperationState: "BSH.Common.EnumType.OperationState.DelayedStart",
          ActiveProgramName: "Cottons",
          EstimatedTotalProgramTime: 11760,
          "BSH.Common.Option.FinishInRelative": { value: 39309 }
        }
      ]
    });
    Date.now = () => new Date("2026-04-04T10:00:00Z").getTime();
    const delayedStartFinishOnlyDom = delayedStartFinishOnlyInstance.getDom();
    Date.now = originalDateNow;
    assert.ok(delayedStartFinishOnlyDom.innerHTML.includes("STARTS_IN"));
    assert.ok(delayedStartFinishOnlyDom.innerHTML.includes("ENDS_AT"));

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

    const homeConnectErrorInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          ActiveProgramName: "Eco 40-60",
          ActiveProgramSource: "active"
        }
      ],
      lastInitStatus: {
        status: "device_error",
        message: "BSH.Common.Error.RemoteControlNotActive: Remote control is not enabled"
      }
    });
    const homeConnectErrorDom = homeConnectErrorInstance.getDom();
    assert.ok(homeConnectErrorDom.innerHTML.includes("Home Connect"));
    assert.ok(homeConnectErrorDom.innerHTML.includes("Remote control"));

    const rateLimitInstance = createInstance({
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          ActiveProgramName: "Eco 40-60",
          ActiveProgramSource: "active"
        }
      ],
      lastInitStatus: {
        status: "device_error",
        message: "Rate limit active - please wait 120s",
        statusCode: 429,
        isRateLimit: true,
        rateLimitSeconds: 120
      }
    });
    const rateLimitDom = rateLimitInstance.getDom();
    assert.ok(rateLimitDom.innerHTML.includes("HTTP 429"));
    assert.ok(rateLimitDom.innerHTML.includes("Rate limit active - please wait 120s"));

    const configMismatchInstance = createInstance({
      lastInitStatus: {
        status: "device_error",
        message: "Konfigurationskonflikt: Dieses Display nutzt eine andere Konfiguration.",
        isConfigMismatch: true
      }
    });
    const configMismatchDom = configMismatchInstance.getDom();
    assert.ok(configMismatchDom.innerHTML.includes("CONFIG_MISMATCH_TITLE"));
    assert.ok(
      configMismatchDom.innerHTML.includes(
        "Konfigurationskonflikt: Dieses Display nutzt eine andere Konfiguration."
      )
    );
    assert.ok(configMismatchDom.innerHTML.includes("LOADING_APPLIANCES"));

    // Without an explicit message the banner falls back to a translated text, and
    // credential conflicts get their own wording.
    const credentialMismatchInstance = createInstance({
      lastInitStatus: {
        status: "device_error",
        isConfigMismatch: true,
        mismatchKeys: ["clientId"]
      }
    });
    const credentialMismatchDom = credentialMismatchInstance.getDom();
    assert.ok(credentialMismatchDom.innerHTML.includes("CONFIG_MISMATCH_CREDENTIALS"));

    const debugSessionInstance = createInstance({
      config: {
        logLevel: "debug"
      },
      devices: [
        {
          name: "Washer",
          type: "Washer",
          PowerState: "On",
          ActiveProgramName: "Eco 40-60",
          ActiveProgramSource: "active"
        }
      ],
      debugStats: {
        lastApiCallTs: Date.now(),
        lastSseEventTs: null,
        lastSseTrafficTs: Date.now(),
        apiCounters: { homeappliances: 3 },
        session: {
          authenticated: true,
          authFlowInProgress: false,
          deviceRefreshInFlight: false,
          programFetchInFlight: true,
          rateLimitRemainingMs: 120000
        }
      }
    });
    const debugSessionDom = debugSessionInstance.getDom();
    assert.ok(debugSessionDom.innerHTML.includes("SSE traffic:"));
    assert.ok(debugSessionDom.innerHTML.includes("SSE event:"));
    assert.ok(debugSessionDom.innerHTML.includes("n/a"));
    assert.ok(debugSessionDom.innerHTML.includes("API:"));
    assert.ok(debugSessionDom.innerHTML.includes("session:"));
    assert.ok(debugSessionDom.innerHTML.includes("authenticated, program fetch"));
    assert.ok(debugSessionDom.innerHTML.includes("rate limit remaining:"));
    assert.ok(debugSessionDom.innerHTML.includes("API counts"));
    assert.ok(debugSessionDom.innerHTML.includes("homeappliances"));


    console.log("frontend-render.test.js OK");
  } finally {
    restoreGlobals();
  }
})();
