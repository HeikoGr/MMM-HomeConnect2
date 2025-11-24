"use strict";

const { deviceAppearsActive, isDeviceConnected } = require("./device-utils");

class DeviceService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.hc = null;
    this.devices = new Map();
    this.subscribed = false;
    this.globalSession = options.globalSession;
    this.config = {};
    const debugHooks = options.debugHooks || {};
    this.recordApiCall = debugHooks.recordApiCall || (() => { });
    this.recordSseEvent = debugHooks.recordSseEvent || (() => { });

    // Heartbeat / SSE monitoring
    this.heartbeatEnabled = true;
    this.heartbeatIntervalMs = 60000;
    this.heartbeatStaleThresholdMs = 180000;
    this.heartbeatTimer = null;
    this.lastEventTimestamp = null;
    this.heartbeatArmed = false;
    this.heartbeatStale = false;

    this.deviceEventHandler = null;
    this._sseTokenRefreshPromise = null;
    this._lastTokenRefreshedAt = 0;
    this.globalSubscribeTimer = null;
  }

  attachClient(hc) {
    if (this.hc && this.hc !== hc && typeof this.hc.closeEventSources === "function") {
      try {
        this.hc.closeEventSources({ devices: true, global: true });
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
    this.logger(
      "debug",
      `Broadcasting ${this.devices.size} devices to ${this.globalSession.clientInstances.size} clients`
    );
    this.globalSession.clientInstances.forEach(() => {
      sendSocketNotification("MMM-HomeConnect_Update", Array.from(this.devices.values()));
    });
  }

  fetchDeviceStatus(device) {
    if (this.hc && typeof this.hc.getStatus === "function") {
      this.recordApiCall("status");
      return this.hc
        .getStatus(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.status)) {
            res.data.status.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(device, event);
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
            res.data.settings.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(device, event);
              }
            });
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

  setConfig(config = {}) {
    this.config = config;
    this.heartbeatEnabled = config.enableSSEHeartbeat !== false;
    this.heartbeatIntervalMs = config.sseHeartbeatCheckIntervalMs || 60000;
    this.heartbeatStaleThresholdMs = config.sseHeartbeatStaleThresholdMs || 180000;

    if (!this.heartbeatEnabled) {
      this.stopHeartbeatMonitor();
    } else if (this.subscribed) {
      this.startHeartbeatMonitor();
    }
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
        const silenceMin = Math.round(silenceMs / 60000);
        this.logger(
          "warn",
          `No SSE events received for ${silenceMin} minute(s) - broadcasting stale status`
        );
        this.broadcastToAllClients("INIT_STATUS", {
          status: "sse_stale",
          message: `No Home Connect events received for ${silenceMin} minute(s)`
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
  }

  shutdown() {
    this.resetEventSubscriptions();
  }

  resetEventSubscriptions() {
    this.stopHeartbeatMonitor();
    this.clearGlobalSubscriptionTimer();
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
      pendingFetches.push(this.fetchDeviceSettings(deviceRef));
    } else if (appearsActive) {
      this.logger(
        "info",
        `Device ${device.name} not marked connected but appears active - fetching status/settings as fallback`,
        { rawConnected: device.connected }
      );
      pendingFetches.push(this.fetchDeviceStatus(deviceRef));
      pendingFetches.push(this.fetchDeviceSettings(deviceRef));
    } else {
      this.logger("warn", `Device ${device.name} is not connected`);
    }

    if (pendingFetches.length === 0) {
      return Promise.resolve();
    }

    return Promise.allSettled(pendingFetches);
  }

  subscribeToDeviceEvents(deviceEventHandler) {
    if (!this.hc) {
      this.logger("error", "HomeConnect client not attached - cannot subscribe");
      return;
    }
    const handlerChanged = this.deviceEventHandler !== deviceEventHandler;
    this.deviceEventHandler = deviceEventHandler;

    if (this.subscribed && !handlerChanged) {
      this.logger("debug", "Global SSE subscriptions already active - skipping re-subscribe");
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
        this.scheduleGlobalSubscriptions();
      });
  }

  clearGlobalSubscriptionTimer() {
    if (this.globalSubscribeTimer) {
      clearTimeout(this.globalSubscribeTimer);
      this.globalSubscribeTimer = null;
    }
  }

  scheduleGlobalSubscriptions() {
    this.establishEventSubscriptions();
  }

  establishEventSubscriptions() {
    if (!this.hc || !this.deviceEventHandler) {
      return;
    }

    if (!this.subscribed) {
      this.logger("info", "Subscribing to global device events...");
      this.hc.subscribe("NOTIFY", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
      this.hc.subscribe("STATUS", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
      this.hc.subscribe("EVENT", (e) => {
        this.deviceEventHandler && this.deviceEventHandler(e);
      });
      this.subscribed = true;
      this.logger("info", "Global event subscriptions established");
      if (this.heartbeatEnabled) {
        this.startHeartbeatMonitor();
      }
    } else {
      this.logger("debug", "Global subscriptions already active");
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

    this.subscribeToDeviceEvents((e) => this.deviceEvent(e, sendSocketNotification));
    this.sortDevices();

    Promise.allSettled(processingTasks)
      .catch(() => { })
      .finally(() => {
        this.logger("info", "Device processing complete - broadcasting to frontend");
        this.broadcastDevices(sendSocketNotification);

        this.broadcastToAllClients("INIT_STATUS", {
          status: "complete",
          message: `${appliances.length} device(s) loaded`
        });
      });
  }

  handleGetDevicesError(error) {
    this.logger("error", "Failed to get devices:", error && error.stack ? error.stack : error);

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Device error: ${error.message}`
    });
  }

  getDevices(sendSocketNotification) {
    if (!this.hc) {
      this.logger("error", "HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready"
      });
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

      items.forEach((rawItem) => {
        const item = this.normalizeEventItem(rawItem, eventObj);
        if (!item || !item.haId || !item.key) {
          return;
        }
        const device = this.devices.get(item.haId);
        if (!device) {
          return;
        }

        if (
          item.key === "BSH.Common.Option.RemainingProgramTime" ||
          item.key === "BSH.Common.Option.ProgramProgress"
        ) {
          this.logger("debug", "SSE runtime event", {
            haId: item.haId,
            device: device.name,
            key: item.key,
            value: item.value
          });
        }

        if (this.hc && typeof this.hc.applyEventToDevice === "function") {
          this.hc.applyEventToDevice(device, item);
          processed = true;
        } else {
          this.logger(
            "warn",
            "No event parser available for device events; update homeconnect-api client"
          );
        }
      });

      if (processed) {
        this.recordSseEvent();
        this.broadcastDevices(sendSocketNotification);
        this.lastEventTimestamp = Date.now();
        if (!this.heartbeatArmed) {
          this.heartbeatArmed = true;
        }
        if (this.heartbeatStale) {
          this.heartbeatStale = false;
          this.logger("info", "SSE heartbeat recovered via incoming event");
          this.broadcastToAllClients("INIT_STATUS", {
            status: "sse_recovered",
            message: "Home Connect event stream recovered"
          });
        }
      }
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
