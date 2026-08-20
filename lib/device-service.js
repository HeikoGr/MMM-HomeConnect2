"use strict";

const { deviceAppearsActive, isDeviceConnected, isRateLimitError } = require("./device-utils");

// Used when Home Connect answers 429 without a Retry-After header.
const DEVICE_RATE_LIMIT_FALLBACK_S = 5 * 60;

class DeviceService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.onSseStale = options.onSseStale || (() => { });
    this.onActiveProgramNeeded = options.onActiveProgramNeeded || (() => { });
    // Fires once per getDevices() run, on success and on failure alike, so the
    // caller's in-flight flag can never latch on an error path.
    this.onRefreshSettled = options.onRefreshSettled || (() => { });
    this.setRateLimitUntil = options.setRateLimitUntil || (() => { });
    this.hc = null;
    this.devices = new Map();
    this.subscribed = false;
    this.subscribedHaIds = new Set();
    this.settingsFetchedHaIds = new Set();
    this.globalSession = options.globalSession;
    this.config = {};
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => { });
    this.recordSseEvent = debugHooks.recordSseEvent || (() => { });
    this.recordSseKeepAlive = debugHooks.recordSseKeepAlive || (() => { });

    // Heartbeat / SSE monitoring
    this.heartbeatEnabled = true;
    this.heartbeatIntervalMs = 60000;
    this.heartbeatStaleThresholdMs = 180000;
    this.heartbeatTimer = null;
    this.lastEventTimestamp = null;
    this.lastSubscriptionTimestamp = null;
    this.lastKeepAliveTimestamp = null;
    this.heartbeatArmed = false;
    this.heartbeatStale = false;
    this.staleRecoveryInFlight = false;
    this.lastStaleRecoveryAt = 0;
    this.staleRecoveryCooldownMs = 60000;

    this.deviceEventHandler = null;
    this._deviceRefreshPending = false;
    this._deviceEventNotifier = null;
    this._stableDeviceEventHandler = null;
    this._sseTokenRefreshPromise = null;
    this._lastTokenRefreshedAt = 0;
  }

  attachClient(hc) {
    if (this.hc && this.hc !== hc) {
      try {
        // destroy() also clears the previous client's token-refresh timer -
        // closeEventSources() alone leaves it running against a discarded client.
        if (typeof this.hc.destroy === "function") {
          this.hc.destroy();
        } else if (typeof this.hc.closeEventSources === "function") {
          this.hc.closeEventSources({ devices: true, global: true });
        }
        this.logger("info", "Detached previous Home Connect client and closed SSE channels");
      } catch (err) {
        this.logger(
          "warn",
          "Failed to close event sources on previous Home Connect client",
          err && err.message ? err.message : err
        );
      }
    }

    this.hc = hc;
  }

  broadcastDevices(sendSocketNotification) {
    const devices = Array.from(this.devices.values());
    this.logger(
      "debug",
      `Broadcasting ${devices.length} devices to ${this.globalSession.clientInstances.size} clients`
    );
    sendSocketNotification("DEVICES_UPDATE", devices);
  }

  // Re-reads the device from the live Map right before applying fetched data,
  // instead of mutating the object reference captured when the fetch started.
  // processDevice() replaces that Map entry with a new merged object on every
  // refresh cycle - if a second refresh (or SSE resync) lands while this fetch
  // is still in flight, the originally captured reference is orphaned and
  // mutating it would silently discard the result.
  currentDevice(device) {
    return this.devices.get(device.haId) || device;
  }

  fetchDeviceStatus(device) {
    if (this.hc && typeof this.hc.getStatus === "function") {
      this.recordApiCall("status");
      return this.hc
        .getStatus(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.status)) {
            const liveDevice = this.currentDevice(device);
            liveDevice.connected = true;
            res.data.status.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(liveDevice, event);
              }
            });
          }
        })
        .catch((err) => {
          this.logger("error", `Status error for ${device.name}:`, err);
          return null;
        });
    }
    this.logger(
      "error",
      `HomeConnect client missing getStatus wrapper - cannot fetch status for ${device.name}`
    );
    return Promise.resolve();
  }

  fetchDeviceSettings(device) {
    if (this.hc && typeof this.hc.getSettings === "function") {
      this.recordApiCall("settings");
      return this.hc
        .getSettings(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.settings)) {
            const liveDevice = this.currentDevice(device);
            liveDevice.connected = true;
            res.data.settings.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(liveDevice, event);
              }
            });
            // Only on success: a transient failure must stay retryable on the
            // next refresh instead of leaving the appliance without settings.
            this.settingsFetchedHaIds.add(device.haId);
          }
        })
        .catch((err) => {
          this.logger("error", `Settings error for ${device.name}:`, err);
          return null;
        });
    }
    this.logger(
      "error",
      `HomeConnect client missing getSettings wrapper - cannot fetch settings for ${device.name}`
    );
    return Promise.resolve();
  }

  // BSH.Common.Setting.PowerState (and the hood's Lighting) are settings, so they
  // never appear in /status - /settings is their only REST source. Without this
  // seed an appliance has no known power state until it happens to change it
  // while the module runs, which leaves e.g. a dishwasher that was switched on
  // before the mirror started showing no power icon at all.
  //
  // Fetched once per appliance rather than on every refresh: the live value comes
  // from SSE NOTIFY afterwards, and one call per appliance per session keeps this
  // far away from the API rate limit.
  shouldFetchInitialSettings(device) {
    return Boolean(device?.haId) && !this.settingsFetchedHaIds.has(device.haId);
  }

  setConfig(config = {}) {
    this.config = config;
    this.heartbeatEnabled = config.enableSSEHeartbeat !== false;
    this.heartbeatIntervalMs = config.sseHeartbeatCheckIntervalMs || 60000;
    this.heartbeatStaleThresholdMs = config.sseHeartbeatStaleThresholdMs || 180000;
    this.staleRecoveryCooldownMs = Math.max(
      config.sseRecoveryCooldownMs || 0,
      this.heartbeatStaleThresholdMs,
      this.heartbeatIntervalMs * 2,
      60000
    );

    if (!this.heartbeatEnabled) {
      this.stopHeartbeatMonitor();
    } else if (this.subscribed) {
      this.startHeartbeatMonitor();
    }
  }

  noteTokenRefreshed(timestamp = Date.now()) {
    this._lastTokenRefreshedAt = timestamp;
  }

  startHeartbeatMonitor() {
    if (!this.heartbeatEnabled) {
      return;
    }
    if (this.heartbeatTimer) {
      return;
    }

    this.logger(
      "debug",
      `Starting SSE heartbeat monitor (interval=${this.heartbeatIntervalMs}ms, stale=${this.heartbeatStaleThresholdMs}ms)`
    );
    this.lastEventTimestamp = Date.now();
    this.lastSubscriptionTimestamp = Date.now();
    this.lastKeepAliveTimestamp = null;
    this.heartbeatArmed = false;

    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatEnabled) {
        return;
      }

      if (!this.heartbeatArmed || !this.lastEventTimestamp) {
        return;
      }

      const now = Date.now();
      const silenceMs = now - this.lastEventTimestamp;

      if (silenceMs >= this.heartbeatStaleThresholdMs && !this.heartbeatStale) {
        this.heartbeatStale = true;
        const durationLabel = this.formatSilenceDuration(silenceMs);
        this.logger(
          "warn",
          `No SSE events received for ${durationLabel} - broadcasting stale status`
        );
        this.broadcastToAllClients("INIT_STATUS", {
          status: "sse_stale",
          message: `No Home Connect events received for ${durationLabel}`
        });
        this.triggerSseRecovery({
          silenceMs
        });
      } else if (silenceMs < this.heartbeatStaleThresholdMs && this.heartbeatStale) {
        this.heartbeatStale = false;
        this.logger("info", "SSE heartbeat recovered");
        this.broadcastToAllClients("INIT_STATUS", {
          status: "sse_recovered",
          message: "Home Connect event stream recovered"
        });
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatStale = false;
    this.heartbeatArmed = false;
    this.lastEventTimestamp = null;
    this.lastSubscriptionTimestamp = null;
    this.lastKeepAliveTimestamp = null;
    this.staleRecoveryInFlight = false;
  }

  markSseTraffic(timestamp = Date.now()) {
    this.lastEventTimestamp = timestamp;
    this.lastSubscriptionTimestamp = timestamp;
    if (!this.heartbeatArmed) {
      this.heartbeatArmed = true;
    }
    if (this.heartbeatStale) {
      this.heartbeatStale = false;
      this.logger("info", "SSE heartbeat recovered via incoming traffic");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "sse_recovered",
        message: "Home Connect event stream recovered"
      });
    }
  }

  handleKeepAliveEvent(data) {
    const now = Date.now();
    const sinceLastKeepAlive =
      Number.isFinite(this.lastKeepAliveTimestamp) && this.lastKeepAliveTimestamp > 0
        ? now - this.lastKeepAliveTimestamp
        : null;

    this.lastKeepAliveTimestamp = now;
    const keepAliveMessage = `SSE KEEP-ALIVE received${sinceLastKeepAlive !== null ? ` (${sinceLastKeepAlive}ms since last KEEP-ALIVE)` : ""}`;
    if (data && data.data !== undefined) {
      this.logger("debug", keepAliveMessage, data.data);
    } else {
      this.logger("debug", keepAliveMessage);
    }
    this.recordSseKeepAlive();
    this.markSseTraffic(now);
  }

  formatSilenceDuration(silenceMs) {
    const seconds = Math.max(1, Math.round(silenceMs / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.round(seconds / 60);
    return `${minutes} minute(s)`;
  }

  triggerSseRecovery(context = {}) {
    if (!this.devices || this.devices.size === 0) {
      this.logger("debug", "Skipping SSE recovery because no devices are known yet");
      return;
    }

    if (this.staleRecoveryInFlight) {
      this.logger("debug", "SSE recovery already in flight - skipping duplicate trigger");
      return;
    }

    const now = Date.now();
    if (now - this.lastStaleRecoveryAt < this.staleRecoveryCooldownMs) {
      this.logger("debug", "SSE recovery cooldown active - skipping trigger");
      return;
    }

    this.staleRecoveryInFlight = true;
    this.lastStaleRecoveryAt = now;

    Promise.resolve()
      .then(() => this.onSseStale(context))
      .catch((err) => {
        this.logger(
          "warn",
          "SSE stale recovery callback failed",
          err && err.message ? err.message : err
        );
      })
      .finally(() => {
        this.staleRecoveryInFlight = false;
      });
  }

  shutdown() {
    this.resetEventSubscriptions();
    // Only a real teardown invalidates the "settings already seeded" cache -
    // a plain channel rebuild must keep it, or /settings is refetched for every
    // appliance on every reconnect.
    this.settingsFetchedHaIds.clear();
  }

  resetEventSubscriptions() {
    this.stopHeartbeatMonitor();
    if (this.hc && typeof this.hc.closeEventSources === "function") {
      try {
        this.hc.closeEventSources({ devices: true, global: true });
        this.logger("info", "Closed Home Connect SSE channels (global + devices)");
      } catch (err) {
        this.logger(
          "warn",
          "Failed to close existing Home Connect event sources",
          err && err.message ? err.message : err
        );
      }
    }
    this.subscribed = false;
    this.subscribedHaIds.clear();
  }

  processDevice(device, index) {
    this.logger("debug", `Device ${index + 1}: ${device.name} (${device.haId})`);

    // Merge with existing entry so runtime fields (RemainingProgramTime, OperationState, etc.)
    // survive periodic refreshes until the program service overwrites them.
    const existingDevice = this.devices.get(device.haId);
    const mergedDevice = existingDevice ? { ...existingDevice, ...device } : device;
    this.devices.set(device.haId, mergedDevice);

    const deviceRef = mergedDevice;

    const connected = isDeviceConnected(deviceRef);
    const appearsActive = deviceAppearsActive(deviceRef);

    const pendingFetches = [];

    if (connected) {
      this.logger("info", `Device ${device.name} is connected - fetching status`);
      pendingFetches.push(this.fetchDeviceStatus(deviceRef));
      if (this.shouldFetchInitialSettings(deviceRef)) {
        pendingFetches.push(this.fetchDeviceSettings(deviceRef));
      }
    } else if (appearsActive) {
      this.logger(
        "info",
        `Device ${device.name} not marked connected but appears active - fetching status as fallback`,
        { rawConnected: device.connected }
      );
      pendingFetches.push(this.fetchDeviceStatus(deviceRef));
    } else {
      this.logger("warn", `Device ${device.name} is not connected`);
    }

    if (pendingFetches.length === 0) {
      return Promise.resolve();
    }

    return Promise.allSettled(pendingFetches);
  }

  // subscribeToDeviceEvents tears down and rebuilds every SSE channel whenever
  // the handler identity changes. Passing a fresh closure per refresh therefore
  // meant a full reconnect - plus a token refresh - on every device snapshot,
  // i.e. every 30 minutes, for channels that were working fine. Keep one handler
  // and swap only the broadcast sink it forwards to.
  getDeviceEventHandler(sendSocketNotification) {
    this._deviceEventNotifier = sendSocketNotification;
    if (!this._stableDeviceEventHandler) {
      this._stableDeviceEventHandler = (e) => this.deviceEvent(e, this._deviceEventNotifier);
    }
    return this._stableDeviceEventHandler;
  }

  subscribeToDeviceEvents(deviceEventHandler) {
    if (!this.hc) {
      this.logger("error", "HomeConnect client not attached - cannot subscribe");
      return;
    }
    const handlerChanged = this.deviceEventHandler !== deviceEventHandler;
    this.deviceEventHandler = deviceEventHandler;

    if (this.subscribed && !handlerChanged) {
      this.logger("debug", "SSE subscriptions already active - ensuring channels for known devices");
      this.establishEventSubscriptions();
      return;
    }

    this.logger("debug", "Preparing SSE subscriptions (resetting existing channels if any)");
    this.resetEventSubscriptions();

    this.ensureFreshTokenForSSE()
      .catch((err) => {
        this.logger(
          "warn",
          "Pre-SSE token refresh failed - continuing with existing token",
          err && err.message ? err.message : err
        );
      })
      .finally(() => {
        this.establishEventSubscriptions();
      });
  }

  reconnectEventSubscriptions() {
    if (!this.hc || !this.deviceEventHandler) {
      this.logger("warn", "Cannot rebuild SSE subscriptions without HomeConnect client and handler");
      return Promise.resolve(false);
    }

    this.logger("warn", "Rebuilding Home Connect SSE subscriptions");
    this.resetEventSubscriptions();

    return this.ensureFreshTokenForSSE()
      .catch((err) => {
        this.logger(
          "warn",
          "Pre-SSE token refresh during rebuild failed - continuing with existing token",
          err && err.message ? err.message : err
        );
      })
      .then(() => {
        this.establishEventSubscriptions();
        return true;
      });
  }

  establishEventSubscriptions() {
    if (!this.hc || !this.deviceEventHandler) {
      return;
    }

    // Home Connect best practice: open one monitoring channel per appliance.
    // Respect the documented limit of 10 parallel monitoring channels.
    const allHaIds = Array.from(this.devices.keys()).filter(Boolean);
    const maxChannels = 10;
    const targetHaIds = allHaIds.slice(0, maxChannels);

    if (allHaIds.length > maxChannels) {
      this.logger(
        "warn",
        `Only opening ${maxChannels} of ${allHaIds.length} SSE channels due to Home Connect channel limit`
      );
    }

    if (typeof this.hc.subscribeDevice === "function") {
      let newSubscriptions = 0;
      targetHaIds.forEach((haId) => {
        if (this.subscribedHaIds.has(haId)) {
          return;
        }

        this.hc.subscribeDevice(haId, "KEEP-ALIVE", (e) => {
          this.handleKeepAliveEvent(e);
        });
        this.hc.subscribeDevice(haId, "NOTIFY", (e) => {
          this.deviceEventHandler && this.deviceEventHandler(e);
        });
        this.hc.subscribeDevice(haId, "STATUS", (e) => {
          this.deviceEventHandler && this.deviceEventHandler(e);
        });
        this.hc.subscribeDevice(haId, "EVENT", (e) => {
          this.deviceEventHandler && this.deviceEventHandler(e);
        });

        this.subscribedHaIds.add(haId);
        newSubscriptions += 1;
      });

      if (newSubscriptions > 0) {
        this.logger("info", `Established SSE subscriptions for ${newSubscriptions} device(s)`);
      } else {
        this.logger("debug", "No new device SSE subscriptions required");
      }
    } else if (!this.subscribed && typeof this.hc.subscribe === "function") {
      // Compatibility fallback for clients without per-device subscribe.
      this.logger("warn", "Falling back to global SSE subscription (no subscribeDevice API)");
      this.hc.subscribe("KEEP-ALIVE", (e) => {
        this.handleKeepAliveEvent(e);
      });
      this.hc.subscribe("NOTIFY", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
      this.hc.subscribe("STATUS", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
      this.hc.subscribe("EVENT", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
    }

    this.subscribed = true;
    if (this.heartbeatEnabled) {
      this.startHeartbeatMonitor();
    }
  }

  sortDevices() {
    const array = [...this.devices.entries()];
    const sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1 : -1));
    this.devices = new Map(sortedArray);
  }

  handleGetDevicesSuccess(result, sendSocketNotification) {
    let appliances = [];
    if (Array.isArray(result?.body?.data?.homeappliances)) {
      appliances = result.body.data.homeappliances;
    } else if (Array.isArray(result?.data?.homeappliances)) {
      appliances = result.data.homeappliances;
    } else if (Array.isArray(result?.data)) {
      appliances = result.data;
    }

    this.logger("info", `API response received - Found ${appliances.length} appliances`);

    if (appliances.length === 0) {
      this.logger("warn", "No appliances found - check Home Connect app");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "no_devices",
        message: "No devices found - check Home Connect app"
      });
    }

    const processingTasks = appliances.map((device, index) => this.processDevice(device, index));

    this.subscribeToDeviceEvents(this.getDeviceEventHandler(sendSocketNotification));
    this.sortDevices();
    this.broadcastDevices(sendSocketNotification);

    Promise.allSettled(processingTasks)
      .catch(() => { })
      .finally(() => {
        this.logger("info", "Device processing complete - broadcasting to frontend");
        this.broadcastDevices(sendSocketNotification);

        this.broadcastToAllClients("INIT_STATUS", {
          status: "complete",
          message: `${appliances.length} device(s) loaded`
        });

        this.settleDeviceRefresh();
      });
  }

  handleGetDevicesError(error) {
    this.logger("error", "Failed to get devices:", error && error.stack ? error.stack : error);

    const message = error && error.message ? error.message : "Unknown device error";
    const isRateLimit = isRateLimitError(error);
    const retryAfterSeconds = Number.isFinite(error?.retryAfterSeconds)
      ? Math.max(1, Math.ceil(error.retryAfterSeconds))
      : null;

    // A 429 here used to be a UI message and nothing else, so the periodic
    // snapshot and the forced program fetches kept running straight into the
    // penalty. Engage the shared backoff the program service already honours.
    let backoffSeconds = null;
    if (isRateLimit) {
      backoffSeconds = retryAfterSeconds || DEVICE_RATE_LIMIT_FALLBACK_S;
      this.setRateLimitUntil(Date.now() + backoffSeconds * 1000);
      this.logger(
        "warn",
        retryAfterSeconds
          ? `Rate limit on device fetch - honoring Retry-After=${retryAfterSeconds}s`
          : `Rate limit on device fetch - backing off for ${backoffSeconds}s`
      );
    }

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: isRateLimit
        ? retryAfterSeconds
          ? `HTTP 429: ${message} (Retry-After ${retryAfterSeconds}s)`
          : `HTTP 429: ${message}`
        : `Device error: ${message}`,
      statusCode: isRateLimit ? 429 : error?.statusCode || error?.status || null,
      rateLimitSeconds: backoffSeconds,
      isRateLimit
    });

    this.settleDeviceRefresh();
  }

  // Exactly one settle per getDevices() run - the guard keeps a late status
  // rejection from re-firing after the run already completed.
  settleDeviceRefresh() {
    if (!this._deviceRefreshPending) {
      return;
    }
    this._deviceRefreshPending = false;
    try {
      this.onRefreshSettled();
    } catch (err) {
      this.logger("warn", "Device refresh settle handler failed", err && err.message ? err.message : err);
    }
  }

  getDevices(sendSocketNotification) {
    this._deviceRefreshPending = true;

    if (!this.hc) {
      this.logger("error", "HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready"
      });
      this.settleDeviceRefresh();
      return;
    }

    this.logger("info", "Fetching devices from Home Connect API...");

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Fetching devices..."
    });

    if (this.hc && typeof this.hc.getHomeAppliances === "function") {
      this.recordApiCall("homeappliances");
      this.hc
        .getHomeAppliances()
        .then((res) => {
          if (res && res.success && res.data) {
            this.handleGetDevicesSuccess(res, sendSocketNotification);
          } else {
            const err = new Error(res && res.error ? res.error : "Failed to fetch appliances");
            err.statusCode = res && res.statusCode ? res.statusCode : null;
            err.retryAfterSeconds =
              res && Number.isFinite(res.retryAfterSeconds) ? res.retryAfterSeconds : null;
            this.handleGetDevicesError(err);
          }
        })
        .catch((err) => this.handleGetDevicesError(err));
      return;
    }

    const err = new Error(
      "HomeConnect client missing getHomeAppliances wrapper - cannot fetch devices"
    );
    this.logger("error", err.message);
    this.handleGetDevicesError(err);
  }

  deviceEvent(data, sendSocketNotification) {
    try {
      const eventObj = JSON.parse(data.data);
      const items = this.normalizeEventItems(eventObj);
      let processed = false;
      const haIdsNeedingActiveProgram = new Set();

      items.forEach((rawItem) => {
        const item = this.normalizeEventItem(rawItem, eventObj);
        if (!item || !item.haId || !item.key) {
          return;
        }
        const device = this.devices.get(item.haId);
        if (!device) {
          return;
        }

        device.connected = true;

        // Every applied key, not a hand-picked few: when an appliance does not show
        // the state it should, the first question is always whether the event for
        // it arrived at all.
        this.logger("debug", "SSE event applied", {
          haId: item.haId,
          device: device.name,
          key: item.key,
          value: item.value
        });

        if (this.hc && typeof this.hc.applyEventToDevice === "function") {
          this.hc.applyEventToDevice(device, item);
          processed = true;
        } else {
          this.logger(
            "warn",
            "No event parser available for device events; update homeconnect-api client"
          );
        }

        // SSE only ever updates raw runtime fields (remaining time, progress, ...) -
        // the program's name/options come from a separate REST call that nothing
        // else re-triggers once a device goes from idle to running. Without this,
        // a device that was idle when the helper started (e.g. right after a
        // restart) shows live progress forever but never the program itself.
        if (deviceAppearsActive(device) && !device.ActiveProgramName) {
          haIdsNeedingActiveProgram.add(item.haId);
        }
      });

      if (processed) {
        this.recordSseEvent();
        this.broadcastDevices(sendSocketNotification);
        this.markSseTraffic();
      }

      haIdsNeedingActiveProgram.forEach((haId) => {
        this.onActiveProgramNeeded(haId);
      });
    } catch (error) {
      this.logger("error", "Error processing device event:", error);
    }
  }

  normalizeEventItems(payload) {
    if (!payload) {
      return [];
    }
    if (Array.isArray(payload.items) && payload.items.length) {
      return payload.items;
    }
    return [payload];
  }

  normalizeEventItem(item, fallback) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const normalized = { ...item };
    if (!normalized.key && normalized.data && normalized.data.key) {
      normalized.key = normalized.data.key;
    }
    if (normalized.value === undefined && normalized.data && normalized.data.value !== undefined) {
      normalized.value = normalized.data.value;
    } else if (
      normalized.value === undefined &&
      normalized.data &&
      normalized.data.value === undefined
    ) {
      normalized.value = normalized.data;
    }
    if (!normalized.uri && normalized.data && normalized.data.uri) {
      normalized.uri = normalized.data.uri;
    }

    normalized.haId =
      normalized.haId ||
      (fallback && fallback.haId) ||
      this.extractHaIdFromUri(normalized.uri || (fallback && fallback.uri));

    return normalized;
  }

  extractHaIdFromUri(uri) {
    if (!uri || typeof uri !== "string") {
      return null;
    }
    const parts = uri.split("/");
    const index = parts.findIndex((part) => part === "homeappliances");
    if (index !== -1 && parts.length > index + 1) {
      return parts[index + 1];
    }
    // Legacy URIs like /notifications/homeappliances/<haId>/events/...
    if (parts.length >= 4) {
      return parts[3];
    }
    return null;
  }

  ensureFreshTokenForSSE() {
    if (!this.hc || typeof this.hc.refreshTokens !== "function") {
      return Promise.resolve();
    }

    if (this._sseTokenRefreshPromise) {
      return this._sseTokenRefreshPromise;
    }

    if (
      typeof this.hc.tokenRefreshBackoffRemainingMs === "function" &&
      this.hc.tokenRefreshBackoffRemainingMs() > 0
    ) {
      this.logger(
        "warn",
        "Skipping pre-SSE token refresh - token endpoint is in backoff; using existing token"
      );
      return Promise.resolve();
    }

    const maxAgeMs = (this.config && this.config.ssePreSubscribeRefreshMs) || 5 * 60 * 1000;
    const now = Date.now();
    if (this._lastTokenRefreshedAt && now - this._lastTokenRefreshedAt < maxAgeMs) {
      return Promise.resolve();
    }

    this.logger("debug", "Refreshing Home Connect token before establishing SSE streams");

    this._sseTokenRefreshPromise = this.hc
      .refreshTokens()
      .catch((err) => {
        this.logger(
          "error",
          "Token refresh before SSE failed",
          err && err.message ? err.message : err
        );
        throw err;
      })
      .finally(() => {
        this._lastTokenRefreshedAt = Date.now();
        this._sseTokenRefreshPromise = null;
      });

    return this._sseTokenRefreshPromise;
  }
}

module.exports = DeviceService;
