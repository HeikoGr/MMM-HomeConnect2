"use strict";

const assert = require("assert");
const modulePath = require.resolve("../lib/homeconnect-api");
const HomeConnect = require(modulePath);
const deviceUtils = require("../lib/device-utils");

function getGlobalBuiltin(name) {
  return Reflect.get(globalThis, name);
}

function setGlobalBuiltin(name, value) {
  Reflect.set(globalThis, name, value);
}

(() => {
  const hc = new HomeConnect("client", "secret", "refresh");
  const device = { connected: false };

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.RemainingProgramTime",
    value: { value: "PT1H15M" }
  });

  assert.strictEqual(device.connected, true);
  assert.strictEqual(device.RemainingProgramTime.value, "PT1H15M");
  // A normalized observable is stored once, under its friendly name only. Keeping
  // the raw key as a second copy is what let cleared values resurface.
  assert.strictEqual(device["BSH.Common.Status.RemainingProgramTime"], undefined);

  // A key with no friendly field keeps its raw spelling - that is its only storage.
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Option.StartInRelative",
    value: { value: "PT2H" }
  });
  assert.strictEqual(deviceUtils.parseStartInRelativeSeconds(device), 7200);

  // PowerState arrives as a bare enum over SSE and object-wrapped from /settings.
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Setting.PowerState",
    value: "BSH.Common.EnumType.PowerState.On"
  });
  assert.strictEqual(device.PowerState, "On");

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Setting.PowerState",
    value: { value: "BSH.Common.EnumType.PowerState.Standby" }
  });
  assert.strictEqual(device.PowerState, "Standby");

  // An enum value outside the three known ones must not erase the power state.
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Setting.PowerState",
    value: "BSH.Common.EnumType.PowerState.MainsOff"
  });
  assert.strictEqual(device.PowerState, "MainsOff");

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Setting.PowerState",
    value: null
  });
  assert.strictEqual(device.PowerState, "MainsOff");

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Setting.PowerState",
    value: "BSH.Common.EnumType.PowerState.Off"
  });
  assert.strictEqual(device.PowerState, "Off");
  assert.strictEqual(device._initialRemaining, 4500);
  assert.ok(Number.isFinite(device._remainingObservedAt));

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.ProgramProgress",
    value: { value: "37" }
  });

  assert.strictEqual(device.ProgramProgress, 37);

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Option.RemainingProgramTimeIsEstimated",
    value: true
  });

  assert.strictEqual(device.RemainingProgramTimeIsEstimated, true);

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Finished"
  });

  assert.strictEqual(device.RemainingProgramTime, 0);
  assert.strictEqual(device.ProgramProgress, 37);
  assert.strictEqual(device._initialRemaining, undefined);
  assert.strictEqual(device._remainingObservedAt, undefined);
  assert.strictEqual(device.RemainingProgramTimeIsEstimated, undefined);

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.ProgramProgress",
    value: { value: "100" }
  });

  assert.strictEqual(device.ProgramProgress, 100);

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.RemainingProgramTime",
    value: { value: "PT33M" }
  });

  assert.strictEqual(device.RemainingProgramTime.value, "PT33M");
  assert.strictEqual(device.ProgramProgress, undefined);
  assert.strictEqual(device.OperationState, undefined);
  assert.strictEqual(device._initialRemaining, 1980);
  assert.ok(Number.isFinite(device._remainingObservedAt));

  // Opening the door after a cycle moves the appliance to Ready/Inactive and it
  // stops sending progress. A leftover value must not survive that transition,
  // otherwise a long-running instance keeps painting a bar the appliance no
  // longer reports while a freshly started one shows nothing.
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Option.ProgramProgress",
    value: { value: "0" }
  });
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Ready"
  });

  // Asserted through the parser rather than field by field: what matters is that
  // the value no longer yields a number.
  assert.ok(!Number.isFinite(deviceUtils.parseProgress(device)));
  assert.strictEqual(device.ProgramProgress, undefined);

  // The remaining time is the more damaging leftover: an appliance that ends a
  // cycle leaves it at 0, and 0 combined with the planned duration computes to a
  // permanent 100 %.
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Option.RemainingProgramTime",
    value: 0
  });
  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Ready"
  });

  assert.strictEqual(deviceUtils.parseRemainingSeconds(device), null);
  assert.strictEqual(device.RemainingProgramTime, undefined);
  assert.strictEqual(device._initialRemaining, undefined);
  assert.strictEqual(device._remainingObservedAt, undefined);

  // A finished cycle clears the planned duration, so parseEstimatedTotalSeconds()
  // cannot resurrect it.
  const finishedDevice = {
    EstimatedTotalProgramTime: 8940,
    RemainingProgramTimeIsEstimated: true,
    ActiveProgramName: "Easy Care"
  };
  hc.applyEventToDevice(finishedDevice, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Finished"
  });

  assert.strictEqual(deviceUtils.parseEstimatedTotalSeconds(finishedDevice), null);
  assert.strictEqual(deviceUtils.isEstimatedDuration(finishedDevice), false);
  assert.strictEqual(finishedDevice.ActiveProgramName, undefined);
  assert.strictEqual(finishedDevice.RemainingProgramTime, 0);

  // Home Connect nulls BSH.Common.Root.ActiveProgram when a program ends. The
  // appliance is stating outright that nothing runs, so the leftover "active"
  // claim is demoted to what it really is - the program sitting on the dial.
  // Name and options survive, the run-specific phase does not.
  const endedDevice = {
    ActiveProgramKey: "LaundryCare.Dryer.Program.Synthetic",
    ActiveProgramName: "Synthetics",
    ActiveProgramSource: "active",
    ActiveProgramPhase: "Drying",
    ActiveProgramDetails: ["Drying target: Extra Dry"]
  };
  hc.applyEventToDevice(endedDevice, {
    key: "BSH.Common.Root.ActiveProgram",
    value: null
  });

  assert.strictEqual(endedDevice.ActiveProgramSource, "selected");
  assert.strictEqual(endedDevice.ActiveProgramName, "Synthetics");
  assert.strictEqual(endedDevice.ActiveProgramPhase, undefined);
  assert.deepStrictEqual(endedDevice.ActiveProgramDetails, ["Drying target: Extra Dry"]);

  // Reaching Ready demotes the same way - a status refresh always reports the
  // operation state, while Root.ActiveProgram only arrives as an event.
  const idleDevice = { ActiveProgramName: "Eco", ActiveProgramSource: "active" };
  hc.applyEventToDevice(idleDevice, {
    key: "BSH.Common.Status.OperationState",
    value: "BSH.Common.EnumType.OperationState.Ready"
  });

  assert.strictEqual(idleDevice.ActiveProgramSource, "selected");

  // A program that is genuinely running keeps its claim.
  const runningDevice = { ActiveProgramName: "Eco", ActiveProgramSource: "active" };
  hc.applyEventToDevice(runningDevice, {
    key: "BSH.Common.Root.ActiveProgram",
    value: "Dishcare.Dishwasher.Program.Eco50"
  });

  assert.strictEqual(runningDevice.ActiveProgramSource, "active");

  hc.applyEventToDevice(device, {
    key: "Refrigeration.Common.Status.Door.Freezer",
    value: "BSH.Common.EnumType.DoorState.Open"
  });
  assert.strictEqual(device.DoorState, "Open");
  assert.strictEqual(device.RefrigerationDoorStates.Freezer, "Freezer: Open");

  hc.applyEventToDevice(device, {
    key: "ConsumerProducts.CoffeeMaker.Option.BeanAmount",
    value: "ConsumerProducts.CoffeeMaker.EnumType.BeanAmount.Strong"
  });
  assert.strictEqual(
    device.DeviceStatusByKey["ConsumerProducts.CoffeeMaker.Option.BeanAmount"],
    "Bean Amount: Strong"
  );

  hc.applyEventToDevice(device, {
    key: "ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty",
    value: true
  });
  assert.strictEqual(
    device.DeviceAlertsByKey["ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty"],
    "Water Tank Empty"
  );

  hc.applyEventToDevice(device, {
    key: "Cooking.Common.Option.Hood.VentingLevel",
    value: "Cooking.Hood.EnumType.Stage.FanStage02"
  });
  assert.strictEqual(
    device.DeviceStatusByKey["Cooking.Common.Option.Hood.VentingLevel"],
    "Venting Level: Fan Stage 02"
  );

  hc.applyEventToDevice(device, {
    key: "Cooking.Oven.Event.PreheatFinished",
    value: true
  });
  assert.strictEqual(
    device.DeviceAlertsByKey["Cooking.Oven.Event.PreheatFinished"],
    "Preheat Finished"
  );

  hc.applyEventToDevice(device, {
    key: "ConsumerProducts.CleaningRobot.Event.RobotIsStuck",
    value: true
  });
  assert.strictEqual(
    device.DeviceAlertsByKey["ConsumerProducts.CleaningRobot.Event.RobotIsStuck"],
    "Robot Is Stuck"
  );

  console.log("homeconnect-api.test.js OK");
})();

(async () => {
  const originalFetch = getGlobalBuiltin("fetch");
  const originalHeaders = getGlobalBuiltin("Headers");
  const requests = [];

  class TestHeaders {
    constructor(init) {
      this.map = new Map();
      if (init instanceof TestHeaders) {
        for (const [key, value] of init.entries()) {
          this.set(key, value);
        }
      } else if (init && typeof init === "object") {
        for (const [key, value] of Object.entries(init)) {
          this.set(key, value);
        }
      }
    }

    set(key, value) {
      this.map.set(String(key).toLowerCase(), String(value));
    }

    has(key) {
      return this.map.has(String(key).toLowerCase());
    }

    get(key) {
      return this.map.get(String(key).toLowerCase()) || null;
    }

    entries() {
      return this.map.entries();
    }
  }

  setGlobalBuiltin("Headers", TestHeaders);
  setGlobalBuiltin("fetch", async (url, options = {}) => {
    const headerBag = new TestHeaders(options.headers);
    requests.push({ url, method: options.method || "GET", headers: headerBag });

    if (String(url).includes("security/oauth/token")) {
      return {
        ok: true,
        json: async () => ({
          access_token: "token-1",
          refresh_token: "refresh-2",
          expires_in: 3600
        }),
        text: async () => ""
      };
    }

    return {
      ok: true,
      json: async () => ({
        data: { key: "LaundryCare.Dryer.Program.Synthetic", name: "Pflegeleicht", options: [] }
      }),
      text: async () => ""
    };
  });

  delete require.cache[modulePath];
  const HomeConnectWithFetchStub = require(modulePath);
  let hc = null;

  try {
    hc = new HomeConnectWithFetchStub("client", "secret", "refresh", {
      acceptLanguage: "de"
    });
    await hc.init({ isSimulated: false });
    await hc.getSelectedProgram("ha-1");

    const firstGet = requests.find(
      (request) => request.method === "GET" && request.url.includes("/programs/selected")
    );
    assert.ok(firstGet);
    assert.strictEqual(firstGet.headers.get("accept-language"), "de-DE");

    hc.setAcceptLanguage("da");
    await hc.getActiveProgram("ha-1");

    const secondGet = requests.find(
      (request) => request.method === "GET" && request.url.includes("/programs/active")
    );
    assert.ok(secondGet);
    assert.strictEqual(secondGet.headers.get("accept-language"), "da-DK");

    hc.setAcceptLanguage("en_gb");
    await hc.getStatus("ha-1");

    const thirdGet = requests.find(
      (request) => request.method === "GET" && request.url.includes("/status")
    );
    assert.ok(thirdGet);
    assert.strictEqual(thirdGet.headers.get("accept-language"), "en-GB");

    await hc.getAvailablePrograms("ha-1");
    const fourthGet = requests.find(
      (request) => request.method === "GET" && request.url.includes("/programs/available")
    );
    assert.ok(fourthGet);
    assert.strictEqual(fourthGet.headers.get("accept-language"), "en-GB");
  } finally {
    if (hc) {
      if (hc.tokenRefreshTimeout) {
        clearTimeout(hc.tokenRefreshTimeout);
        hc.tokenRefreshTimeout = null;
      }
      if (typeof hc.closeEventSources === "function") {
        hc.closeEventSources({ devices: true, global: true });
      }
    }
    setGlobalBuiltin("fetch", originalFetch);
    setGlobalBuiltin("Headers", originalHeaders);
    delete require.cache[modulePath];
  }
})();

(async () => {
  const originalFetch = getGlobalBuiltin("fetch");
  const originalHeaders = getGlobalBuiltin("Headers");

  class TestHeaders {
    constructor(init) {
      this.map = new Map();
      if (init instanceof TestHeaders) {
        for (const [key, value] of init.entries()) {
          this.set(key, value);
        }
      } else if (init && typeof init === "object") {
        for (const [key, value] of Object.entries(init)) {
          this.set(key, value);
        }
      }
    }

    set(key, value) {
      this.map.set(String(key).toLowerCase(), String(value));
    }

    has(key) {
      return this.map.has(String(key).toLowerCase());
    }

    get(key) {
      return this.map.get(String(key).toLowerCase()) || null;
    }

    entries() {
      return this.map.entries();
    }
  }

  setGlobalBuiltin("Headers", TestHeaders);
  setGlobalBuiltin("fetch", async (url) => {
    if (String(url).includes("security/oauth/token")) {
      return {
        ok: true,
        json: async () => ({
          access_token: "token-429",
          refresh_token: "refresh-429",
          expires_in: 3600
        }),
        text: async () => ""
      };
    }

    return {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new TestHeaders({ "retry-after": "52" }),
      text: async () => JSON.stringify({ error: { key: "429", description: "rate limited" } })
    };
  });

  delete require.cache[modulePath];
  const HomeConnectWithRateLimitStub = require(modulePath);
  let hc = null;

  try {
    hc = new HomeConnectWithRateLimitStub("client", "secret", "refresh", {
      acceptLanguage: "en",
      requestTimeoutMs: 100
    });
    await hc.init({ isSimulated: false });

    const result = await hc.getStatus("ha-rate-limit");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 429);
    assert.strictEqual(result.retryAfterSeconds, 52);
  } finally {
    if (hc) {
      if (hc.tokenRefreshTimeout) {
        clearTimeout(hc.tokenRefreshTimeout);
        hc.tokenRefreshTimeout = null;
      }
      if (typeof hc.closeEventSources === "function") {
        hc.closeEventSources({ devices: true, global: true });
      }
    }
    setGlobalBuiltin("fetch", originalFetch);
    setGlobalBuiltin("Headers", originalHeaders);
    delete require.cache[modulePath];
  }
})();

(async () => {
  const originalFetch = getGlobalBuiltin("fetch");
  const originalHeaders = getGlobalBuiltin("Headers");

  class TestHeaders {
    constructor(init) {
      this.map = new Map();
      if (init instanceof TestHeaders) {
        for (const [key, value] of init.entries()) {
          this.set(key, value);
        }
      } else if (init && typeof init === "object") {
        for (const [key, value] of Object.entries(init)) {
          this.set(key, value);
        }
      }
    }

    set(key, value) {
      this.map.set(String(key).toLowerCase(), String(value));
    }

    has(key) {
      return this.map.has(String(key).toLowerCase());
    }

    get(key) {
      return this.map.get(String(key).toLowerCase()) || null;
    }

    entries() {
      return this.map.entries();
    }
  }

  setGlobalBuiltin("Headers", TestHeaders);
  setGlobalBuiltin("fetch", (url, options = {}) => {
    if (String(url).includes("security/oauth/token")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "token-timeout",
          refresh_token: "refresh-timeout",
          expires_in: 3600
        }),
        text: async () => ""
      });
    }

    return new Promise((_, reject) => {
      if (options.signal && typeof options.signal.addEventListener === "function") {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
  });

  delete require.cache[modulePath];
  const HomeConnectWithTimeoutStub = require(modulePath);
  let hc = null;

  try {
    hc = new HomeConnectWithTimeoutStub("client", "secret", "refresh", {
      acceptLanguage: "de",
      requestTimeoutMs: 20
    });
    await hc.init({ isSimulated: false });

    const result = await hc.getStatus("ha-timeout");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 408);
    assert.ok(/Request timeout after 20ms/.test(result.error));
  } finally {
    if (hc) {
      if (hc.tokenRefreshTimeout) {
        clearTimeout(hc.tokenRefreshTimeout);
        hc.tokenRefreshTimeout = null;
      }
      if (typeof hc.closeEventSources === "function") {
        hc.closeEventSources({ devices: true, global: true });
      }
    }
    setGlobalBuiltin("fetch", originalFetch);
    setGlobalBuiltin("Headers", originalHeaders);
    delete require.cache[modulePath];
  }
})();
