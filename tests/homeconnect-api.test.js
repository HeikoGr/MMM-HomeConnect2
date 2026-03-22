"use strict";

const assert = require("assert");
const modulePath = require.resolve("../lib/homeconnect-api");
const HomeConnect = require(modulePath);

function getGlobalBuiltin(name) {
  return Reflect.get(globalThis, name);
}

function setGlobalBuiltin(name, value) {
  Reflect.set(globalThis, name, value);
}

(() => {
  const hc = new HomeConnect("client", "secret", "refresh");
  const device = {};

  hc.applyEventToDevice(device, {
    key: "BSH.Common.Status.RemainingProgramTime",
    value: { value: "PT1H15M" }
  });

  assert.strictEqual(device.RemainingProgramTime.value, "PT1H15M");
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
  assert.strictEqual(device._initialRemaining, undefined);
  assert.strictEqual(device._remainingObservedAt, undefined);
  assert.strictEqual(device.RemainingProgramTimeIsEstimated, undefined);

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
