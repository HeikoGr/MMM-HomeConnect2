"use strict";

/*
 * Which displays the shared session keeps addressing (MODULE-PLAN B2): a display
 * stays registered while its browser socket is connected - regardless of how
 * long ago it sent CONFIGURE - and is released once its socket is gone.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const REQUEST = "MMM-HomeConnect2_REQUEST";
const EVENT = "MMM-HomeConnect2_EVENT";

function loadHelper() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node_helper") {
      return { create: (definition) => definition };
    }
    if (request.endsWith("module-paths")) {
      const actual = originalLoad.call(this, request, parent, isMain);
      return {
        ...actual,
        refreshTokenPath: path.join(os.tmpdir(), "mmm-homeconnect2-liveness-token.json"),
        rateLimitPath: path.join(os.tmpdir(), "mmm-homeconnect2-liveness-rate-limit.json"),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const helperPath = require.resolve("../node_helper");
  delete require.cache[helperPath];
  try {
    return require(helperPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createClock() {
  let now = 0;
  const pending = new Set();
  return {
    timers: {
      setTimeout(fn, ms) {
        const entry = { fn, at: now + ms };
        pending.add(entry);
        return entry;
      },
      clearTimeout(entry) {
        pending.delete(entry);
      },
    },
    advance(ms) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at <= now) {
          pending.delete(entry);
          entry.fn();
        }
      }
    },
  };
}

class FakeSocket extends EventEmitter {
  constructor(id, helper) {
    super();
    this.id = id;
    this.helper = helper;
    this.received = [];
    this.anyHandlers = [];
  }

  onAny(handler) {
    this.anyHandlers.push(handler);
  }

  emit(notification, payload) {
    this.received.push({ notification, payload });
    return true;
  }

  // Browser -> server, the way MagicMirror's core hands it to the helper.
  send(notification, payload) {
    this.helper.socketNotificationReceived(notification, payload);
    for (const handler of this.anyHandlers) {
      handler(notification, payload);
    }
  }

  disconnect() {
    EventEmitter.prototype.emit.call(this, "disconnect");
  }
}

function setup() {
  const helper = loadHelper();
  const clock = createClock();
  const namespace = new EventEmitter();
  namespace.sockets = new Map();
  helper.io = { of: () => namespace };
  helper.name = "MMM-HomeConnect2";
  helper.clientRegistryOptions = { timers: clock.timers, graceMs: 10 * 60 * 1000 };
  helper.init();
  helper.start();
  // No Home Connect session in these tests.
  helper.checkTokenAndInitialize = () => {};

  const broadcasts = [];
  helper.sendSocketNotification = (_notification, payload) => broadcasts.push(payload.instanceId);
  const connect = (id) => {
    const socket = new FakeSocket(id, helper);
    namespace.emit("connection", socket);
    return socket;
  };
  const configure = (socket, instanceId) =>
    socket.send(REQUEST, {
      action: "CONFIGURE",
      identifier: "module_5_MMM-HomeConnect2",
      instanceId,
      data: { config: { clientId: "client" } },
    });
  const reached = () => {
    broadcasts.length = 0;
    helper.broadcastToAllClients("DEVICES_UPDATE", []);
    return [...broadcasts];
  };
  return { helper, clock, connect, configure, reached };
}

test("a new connection is asked to register", (t) => {
  const { helper, connect } = setup();
  t.after(() => helper.stop());
  const socket = connect("s1");
  assert.equal(socket.received[0].notification, EVENT);
  assert.equal(socket.received[0].payload.action, "INIT_REQUIRED");
  assert.equal(socket.received[0].payload.instanceId, "*");
});

test("a display that stays connected keeps receiving data after 24 h", (t) => {
  const { helper, clock, connect, configure, reached } = setup();
  t.after(() => helper.stop());
  configure(connect("s1"), "hc_display");

  clock.advance(25 * 60 * 60 * 1000);
  helper.schedulePeriodicFullSnapshotRefresh();
  assert.deepEqual(reached(), ["hc_display"]);
});

test("a display whose browser is gone is released after the grace period", (t) => {
  const { helper, clock, connect, configure, reached } = setup();
  t.after(() => helper.stop());
  const socket = connect("s1");
  configure(socket, "hc_display");

  socket.disconnect();
  clock.advance(5 * 60 * 1000);
  assert.deepEqual(reached(), ["hc_display"], "a reload within the grace period is not a goodbye");

  clock.advance(6 * 60 * 1000);
  assert.deepEqual(reached(), []);
});

test("a display that reconnects and registers again is kept", (t) => {
  const { helper, clock, connect, configure, reached } = setup();
  t.after(() => helper.stop());
  const first = connect("s1");
  configure(first, "hc_display");

  first.disconnect();
  clock.advance(60 * 1000);
  configure(connect("s2"), "hc_display");
  clock.advance(60 * 60 * 1000);
  assert.deepEqual(reached(), ["hc_display"]);
});

test("the frontend answers every INIT_REQUIRED, also one crossing its first CONFIGURE", () => {
  const modulePath = require.resolve("../MMM-HomeConnect2.js");
  let definition;
  global.Module = { register: (_name, d) => (definition = d) };
  delete require.cache[modulePath];
  require(modulePath);
  delete global.Module;

  const sent = [];
  const instance = {
    ...definition,
    config: { ...definition.defaults },
    instanceId: "hc_display",
    notifications: { EVENT },
    transport: { sendRequest: (action) => sent.push(action) },
    getLanguage: () => "de",
    lifecycle: { render() {} },
  };
  const initRequired = { instanceId: "*", action: "INIT_REQUIRED", data: null };

  instance.notificationReceived("ALL_MODULES_STARTED");
  // The server restarted before it answered the first CONFIGURE: the new
  // connection's greeting must register the display again.
  instance.socketNotificationReceived(EVENT, initRequired);
  assert.deepEqual(sent, ["CONFIGURE", "CONFIGURE"]);

  // A greeting for another display is not for this one.
  instance.socketNotificationReceived(EVENT, { ...initRequired, instanceId: "other" });
  assert.deepEqual(sent, ["CONFIGURE", "CONFIGURE"]);
});
