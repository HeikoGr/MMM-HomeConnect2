// Vendored single-file version of home-connect-js (utils + main combined)

/* global EventSource */
/* eslint-disable n/no-unsupported-features/node-builtins */
// Load EventSource polyfill explicitly for Node environments (avoid feature check noise)
// ESConstructor represents either the native EventSource or a polyfill; kept local to avoid global no-undef lint errors.
let ESConstructor = typeof EventSource !== "undefined" ? EventSource : null;
if (!ESConstructor) {
  try {
    const es = require("eventsource");
    ESConstructor = es && (es.default || es.EventSource || es);
  } catch (error) {
    console.warn(`EventSource polyfill not available. Install 'eventsource'. ${error.message}`);
  }
}

const EventEmitter = require("events");

// URLs used by the library
global.urls = {
  simulation: {
    base: "https://simulator.home-connect.com/",
    api: "https://apiclient.home-connect.com/hcsdk.yaml"
  },
  physical: {
    base: "https://api.home-connect.com/",
    api: "https://apiclient.home-connect.com/hcsdk-production.yaml"
  }
};

// Default simulation flag
global.isSimulated = false;

const { fetch: undiciFetch, Headers } = require("undici");
const fetch = undiciFetch;
const baseFetch =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undiciFetch;
const HeadersCtor = typeof globalThis.Headers === "function" ? globalThis.Headers : Headers;

const checkResponseStatus = (res) => {
    if (res.ok) {
      return res;
    }
    // Try to get response body text for better debugging
    return res.text().then((text) => {
      const truncated =
        typeof text === "string" && text.length > 1000
          ? `${text.slice(0, 1000)}... (truncated)`
          : text;
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${truncated}`);
    });
  },
  /*
   * --- utils ---
   * Note: The interactive browser OAuth flow has been removed.
   * This module expects a refresh token to be available (headless/device flow).
   */

  makeApiRequest = (method, path, accessToken, body = null) => {
    const baseUrl = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base,
      url = baseUrl + path,
      options = {
        method,
        headers: {
          accept: "application/vnd.bsh.sdk.v1+json",
          authorization: `Bearer ${accessToken}`
        }
      };

    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    return fetch(url, options)
      .then(checkResponseStatus)
      .then((res) => res.json())
      .then((json) => ({ body: json }));

    // Wrap in body to match swagger-client response format
  },
  getClient = function getClient(accessToken) {
    /*
     * Return a simple client object that mimics the swagger-client API structure
     * but uses fetch directly for API calls
     */
    return Promise.resolve({
      accessToken,
      baseUrl: global.isSimulated ? global.urls.simulation.base : global.urls.physical.base,
      apis: {
        appliances: {
          get_home_appliances: () => makeApiRequest("GET", "api/homeappliances", accessToken)
        },
        status: {
          get_status: (params) =>
            makeApiRequest("GET", `api/homeappliances/${params.haId}/status`, accessToken)
        },
        settings: {
          get_settings: (params) =>
            makeApiRequest("GET", `api/homeappliances/${params.haId}/settings`, accessToken)
        },
        // New: programs API support
        programs: {
          get_active_program: (params) =>
            makeApiRequest("GET", `api/homeappliances/${params.haId}/programs/active`, accessToken)
        }
      }
    });
  },
  refreshToken = (clientId, clientSecret, refreshTokenValue) =>
    new Promise((resolve, reject) => {
      // Build form body; include client_secret only if provided
      const params = [
        `grant_type=refresh_token`,
        `client_id=${encodeURIComponent(clientId)}`,
        `refresh_token=${encodeURIComponent(refreshTokenValue)}`
      ];
      if (clientSecret) {
        params.push(`client_secret=${encodeURIComponent(clientSecret)}`);
      }
      const body = params.join("&");

      fetch(
        `${
          global.isSimulated ? global.urls.simulation.base : global.urls.physical.base
        }security/oauth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body
        }
      )
        .then(checkResponseStatus)
        .then((res) => res.json())
        .then((json) =>
          resolve({
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_in: json.expires_in,
            timestamp: Math.floor(Date.now() / 1000)
          })
        )
        .catch((err) => reject(err));
    }),
  // Interactive OAuth helpers removed. Use the device (headless) flow instead.

  utils = {
    getClient,
    refreshToken
  };

// --- HomeConnect class ---
class HomeConnect extends EventEmitter {
  constructor(clientId, clientSecret, refreshToken) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = {};
    this.tokens.refresh_token = refreshToken;
    this.eventSources = {};
    this.eventListeners = {};
    this.eventSource = null;
    this.eventListener = new Map();
    this.tokenRefreshTimeout = null;
    this._lastEventErrorAt = 0;
    this.eventSourceRetryTimer = null;
    this.eventSourceRetryConfig = {
      baseDelayMs: 5000,
      authDelayMs: 30000
    };
    this._authRecoveryInFlight = false;
    this._globalEventMonitorAttached = false;
    this._globalEventOpenListener = null;
    this._globalEventErrorListener = null;
    this._deviceEventMonitors = {};
  }

  createEventSource(url) {
    if (!ESConstructor) {
      throw new Error("EventSource not available");
    }

    const authFetch = (input, init = {}) => {
      const headers = new HeadersCtor(init && init.headers ? init.headers : undefined);
      const accessToken = this.tokens && this.tokens.access_token;
      if (accessToken) {
        headers.set("authorization", `Bearer ${accessToken}`);
      }
      if (!headers.has("accept")) {
        headers.set("accept", "text/event-stream");
      }
      return baseFetch(input, { ...init, headers });
    };

    return new ESConstructor(url, { fetch: authFetch });
  }

  async init(options) {
    global.isSimulated =
      typeof options !== "undefined" &&
      "isSimulated" in options &&
      typeof options.isSimulated === "boolean"
        ? options.isSimulated
        : false;

    // Refresh tokens
    if (this.tokens.refresh_token) {
      this.tokens = await utils.refreshToken(
        this.clientId,
        this.clientSecret,
        this.tokens.refresh_token
      );
    } else {
      // The module no longer supports the interactive browser OAuth flow.
      throw new Error(
        "No refresh token available. This module requires headless authentication (device flow)."
      );
    }

    // Schedule token refresh
    clearTimeout(this.tokenRefreshTimeout);
    const timeToNextTokenRefresh =
      this.tokens.timestamp + this.tokens.expires_in * 0.9 - Math.floor(Date.now() / 1000);
    this.tokenRefreshTimeout = setTimeout(
      () => this.refreshTokens(),
      timeToNextTokenRefresh * 1000
    );
    this.client = await utils.getClient(this.tokens.access_token);
    this.emit("newRefreshToken", this.tokens.refresh_token);
  }

  async command(tag, operationId, haId, body) {
    return this.client.apis[tag][operationId]({ haId, body });
  }

  /*
   * High-level convenience wrappers that return normalized results instead of
   * raw swagger-client shaped responses. They return an object with either
   * { success: true, data } or { success: false, statusCode, error }.
   */
  async getHomeAppliances() {
    try {
      const res = await this.command("appliances", "get_home_appliances");
      return { success: true, data: res.body.data };
    } catch (err) {
      return {
        success: false,
        statusCode: err.statusCode || err.status || null,
        error: err.message || String(err)
      };
    }
  }

  async getActiveProgram(haId) {
    try {
      const res = await this.command("programs", "get_active_program", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      const code =
        err.statusCode || err.status || (err.message && (err.message.includes("404") ? 404 : null));
      return {
        success: false,
        statusCode: code,
        error: err.message || String(err)
      };
    }
  }

  async getStatus(haId) {
    try {
      const res = await this.command("status", "get_status", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      const code =
        err.statusCode || err.status || (err.message && (err.message.includes("404") ? 404 : null));
      return {
        success: false,
        statusCode: code,
        error: err.message || String(err)
      };
    }
  }

  async getSettings(haId) {
    try {
      const res = await this.command("settings", "get_settings", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      const code =
        err.statusCode || err.status || (err.message && (err.message.includes("404") ? 404 : null));
      return {
        success: false,
        statusCode: code,
        error: err.message || String(err)
      };
    }
  }

  subscribeDevice(haid, event, callback) {
    if (this.eventSources && !(haid in this.eventSources)) {
      const url = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base,
        eventSource = this.createEventSource(`${url}api/homeappliances/${haid}/events`);
      this.eventSources = { ...this.eventSources, [haid]: eventSource };
      // Reset monitor flag when a new EventSource is created so listeners reattach once
      if (this._deviceEventMonitors && this._deviceEventMonitors[haid]) {
        this._deviceEventMonitors[haid].attached = false;
      } else {
        this._deviceEventMonitors[haid] = {
          attached: false,
          openListener: null,
          errorListener: null
        };
      }
    }

    if (this.eventListeners && !(haid in this.eventListeners)) {
      const listeners = new Map();
      listeners.set(event, callback);
      this.eventListeners = { ...this.eventListeners, [haid]: listeners };
    }

    // Attach monitoring listeners for open/error to improve resilience
    this.attachDeviceEventSourceMonitors(haid);

    this.eventSources[haid].addEventListener(event, callback);
    this.eventListeners[haid].set(event, callback);
  }

  subscribe(event, callback) {
    if (!this.eventSource) {
      const url = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base;
      this.eventSource = this.createEventSource(`${url}api/homeappliances/events`);
      this._globalEventMonitorAttached = false;
    }

    this.attachGlobalEventSourceMonitors();

    this.eventSource.addEventListener(event, callback);
    this.eventListener.set(event, callback);
  }

  attachGlobalEventSourceMonitors() {
    if (!this.eventSource) {
      return;
    }

    if (!this._globalEventOpenListener) {
      this._globalEventOpenListener = () => {
        console.debug && console.debug("EventSource open for global events");
      };
    }

    if (!this._globalEventErrorListener) {
      this._globalEventErrorListener = (err) => {
        this.handleEventSourceError("global", err);
      };
    }

    if (this._globalEventMonitorAttached) {
      return;
    }

    try {
      this.eventSource.addEventListener("open", this._globalEventOpenListener);
      this.eventSource.addEventListener("error", this._globalEventErrorListener);
      this._globalEventMonitorAttached = true;
    } catch {
      // ignore environments that lack addEventListener on EventSource polyfill
    }
  }

  detachGlobalEventSourceMonitors() {
    if (!this.eventSource || !this._globalEventMonitorAttached) {
      this._globalEventMonitorAttached = false;
      return;
    }

    try {
      if (this._globalEventOpenListener) {
        this.eventSource.removeEventListener("open", this._globalEventOpenListener);
      }
      if (this._globalEventErrorListener) {
        this.eventSource.removeEventListener("error", this._globalEventErrorListener);
      }
    } catch {
      // ignore removal failures
    } finally {
      this._globalEventMonitorAttached = false;
    }
  }

  attachDeviceEventSourceMonitors(haid) {
    if (!haid || !this.eventSources || !this.eventSources[haid]) {
      return;
    }

    if (!this._deviceEventMonitors[haid]) {
      this._deviceEventMonitors[haid] = {
        attached: false,
        openListener: null,
        errorListener: null
      };
    }

    const monitorState = this._deviceEventMonitors[haid];
    const source = this.eventSources[haid];

    if (!monitorState.openListener) {
      monitorState.openListener = () => {
        console.debug && console.debug(`EventSource open for ${haid}`);
      };
    }

    if (!monitorState.errorListener) {
      monitorState.errorListener = (err) => {
        this.handleEventSourceError(`device:${haid}`, err);
      };
    }

    if (monitorState.attached) {
      return;
    }

    try {
      source.addEventListener("open", monitorState.openListener);
      source.addEventListener("error", monitorState.errorListener);
      monitorState.attached = true;
    } catch {
      // ignore
    }
  }

  detachDeviceEventSourceMonitors(haid, source) {
    if (!haid || !this._deviceEventMonitors[haid]) {
      return;
    }

    const monitorState = this._deviceEventMonitors[haid];
    const target = source || (this.eventSources && this.eventSources[haid]);

    if (!monitorState.attached || !target) {
      monitorState.attached = false;
      return;
    }

    try {
      if (monitorState.openListener) {
        target.removeEventListener("open", monitorState.openListener);
      }
      if (monitorState.errorListener) {
        target.removeEventListener("error", monitorState.errorListener);
      }
    } catch {
      // ignore
    } finally {
      monitorState.attached = false;
    }
  }

  unsubscribe(event, callback) {
    if (this.eventSource) {
      this.eventSource.removeEventListener(event, callback);
    }
    if (this.eventListener) {
      this.eventListener.delete(event);
    }
  }

  async refreshTokens() {
    clearTimeout(this.tokenRefreshTimeout);
    let timeToNextTokenRefresh;
    try {
      this.tokens = await utils.refreshToken(
        this.clientId,
        this.clientSecret,
        this.tokens.refresh_token
      );
      this.emit("newRefreshToken", this.tokens.refresh_token);
      this.client = await utils.getClient(this.tokens.access_token);
      this.recreateEventSources();
      timeToNextTokenRefresh =
        this.tokens.timestamp + this.tokens.expires_in * 0.9 - Math.floor(Date.now() / 1000);
    } catch (error) {
      timeToNextTokenRefresh = 60;
      console.error(`Could not refresh tokens: ${error.message}`);
      console.error("Retrying in 60 seconds");
    }
    this.tokenRefreshTimeout = setTimeout(
      () => this.refreshTokens(),
      timeToNextTokenRefresh * 1000
    );
  }

  recreateEventSources() {
    if (this.eventSourceRetryTimer) {
      clearTimeout(this.eventSourceRetryTimer);
      this.eventSourceRetryTimer = null;
    }
    for (const haid of Object.keys(this.eventSources)) {
      const existing = this.eventSources[haid];
      if (existing && typeof existing.close === "function") {
        try {
          this.detachDeviceEventSourceMonitors(haid, existing);
          existing.close();
        } catch (err) {
          console.warn(
            `Failed to close stale EventSource for ${haid}:`,
            err && err.message ? err.message : err
          );
        }
        if (this.eventListeners[haid]) {
          for (const [event, callback] of this.eventListeners[haid]) {
            try {
              existing.removeEventListener(event, callback);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const url = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base;
      this.eventSources[haid] = this.createEventSource(`${url}api/homeappliances/${haid}/events`);
      if (this._deviceEventMonitors[haid]) {
        this._deviceEventMonitors[haid].attached = false;
      }
      if (this.eventListeners[haid]) {
        for (const [event, callback] of this.eventListeners[haid]) {
          this.eventSources[haid].addEventListener(event, callback);
        }
      }
      this.attachDeviceEventSourceMonitors(haid);
    }
    const shouldRecreateGlobal =
      this.eventSource || (this.eventListener && this.eventListener.size > 0);
    if (shouldRecreateGlobal) {
      if (this.eventSource) {
        try {
          this.detachGlobalEventSourceMonitors();
          this.eventSource.close();
        } catch (err) {
          console.warn(
            "Failed to close stale global EventSource:",
            err && err.message ? err.message : err
          );
        }
        for (const [event, callback] of this.eventListener) {
          try {
            this.eventSource.removeEventListener(event, callback);
          } catch {
            /* ignore */
          }
        }
      }
      const url = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base;
      this.eventSource = this.createEventSource(`${url}api/homeappliances/events`);
      this._globalEventMonitorAttached = false;
      for (const [event, callback] of this.eventListener) {
        this.eventSource.addEventListener(event, callback);
      }
      this.attachGlobalEventSourceMonitors();
    }
  }

  closeEventSources(options = {}) {
    const config = {
      devices: true,
      global: true,
      ...options
    };

    if (config.devices && this.eventSources) {
      for (const haid of Object.keys(this.eventSources)) {
        try {
          if (this.eventSources[haid]) {
            this.detachDeviceEventSourceMonitors(haid, this.eventSources[haid]);
            this.eventSources[haid].close && this.eventSources[haid].close();
          }
          console.debug && console.debug(`Closed device EventSource for ${haid}`);
        } catch (err) {
          console.warn(
            `Failed to close EventSource for ${haid}:`,
            err && err.message ? err.message : err
          );
        }
      }
      this.eventSources = {};
      this.eventListeners = {};
      this._deviceEventMonitors = {};
    }

    if (config.global && this.eventSource) {
      try {
        this.detachGlobalEventSourceMonitors();
        this.eventSource.close();
        console.debug && console.debug("Closed global EventSource");
      } catch (err) {
        console.warn("Failed to close global EventSource:", err && err.message ? err.message : err);
      }
      this.eventSource = null;
      this.eventListener = new Map();
      this._globalEventMonitorAttached = false;
    }
  }

  setEventSourceRetryConfig(config = {}) {
    if (!config || typeof config !== "object") {
      return;
    }

    const updated = { ...this.eventSourceRetryConfig };
    if (Number.isFinite(config.baseDelayMs) && config.baseDelayMs >= 0) {
      updated.baseDelayMs = config.baseDelayMs;
    }
    if (Number.isFinite(config.authDelayMs) && config.authDelayMs >= 0) {
      updated.authDelayMs = config.authDelayMs;
    }

    this.eventSourceRetryConfig = updated;
  }

  handleEventSourceError(sourceLabel, err) {
    const code = this.extractStatusCode(err);
    const message = err && err.message ? err.message : err;
    const isAuthError = code === 401 || code === 403;
    const isRateLimited = code === 429;
    const delay =
      isAuthError || isRateLimited
        ? this.eventSourceRetryConfig.authDelayMs
        : this.eventSourceRetryConfig.baseDelayMs;

    console.error(`EventSource error (${sourceLabel})${code ? ` [${code}]` : ""}: ${message}`);

    this.closeEventSourceByLabel(sourceLabel);

    if (isAuthError) {
      this.recoverFromAuthError(delay);
      return;
    }

    console.error(`Re-subscribing in ${delay}ms due to event source error`);
    this.scheduleEventSourceRecreate(delay);
  }

  recoverFromAuthError(delayMs) {
    if (this._authRecoveryInFlight) {
      console.debug &&
        console.debug("Auth recovery already in progress - skipping additional trigger");
      return;
    }

    this._authRecoveryInFlight = true;

    const fallback = () => {
      console.error(`Auth recovery failed - will retry event source recreate in ${delayMs}ms`);
      this.scheduleEventSourceRecreate(delayMs);
    };

    this.refreshTokens()
      .catch((error) => {
        console.error(
          "Token refresh during SSE auth recovery failed:",
          error && error.message ? error.message : error
        );
        fallback();
      })
      .finally(() => {
        this._authRecoveryInFlight = false;
      });
  }

  closeEventSourceByLabel(label) {
    if (!label) {
      return;
    }

    if (label === "global") {
      if (this.eventSource && typeof this.eventSource.close === "function") {
        try {
          this.detachGlobalEventSourceMonitors();
          this.eventSource.close();
          console.debug && console.debug("Closed global EventSource due to error");
        } catch (err) {
          console.warn(
            "Failed to close global EventSource on error:",
            err && err.message ? err.message : err
          );
        }
      }
      this.eventSource = null;
      this._globalEventMonitorAttached = false;
      return;
    }

    if (label.startsWith("device:")) {
      const haid = label.split(":")[1];
      const source = this.eventSources && this.eventSources[haid];
      if (source && typeof source.close === "function") {
        try {
          this.detachDeviceEventSourceMonitors(haid, source);
          source.close();
          console.debug && console.debug(`Closed device EventSource for ${haid} due to error`);
        } catch (err) {
          console.warn(
            `Failed to close device EventSource for ${haid} on error:`,
            err && err.message ? err.message : err
          );
        }
      }
      this.eventSources[haid] = null;
      if (this._deviceEventMonitors[haid]) {
        this._deviceEventMonitors[haid].attached = false;
      }
    }
  }

  scheduleEventSourceRecreate(delayMs) {
    if (this.eventSourceRetryTimer) {
      // Existing retry scheduled; do not stack timers
      return;
    }

    const safeDelay = Number.isFinite(delayMs) ? Math.max(delayMs, 0) : 0;

    this.eventSourceRetryTimer = setTimeout(() => {
      this.eventSourceRetryTimer = null;
      try {
        this.recreateEventSources();
      } catch (err) {
        console.error("Failed to recreate event sources after backoff:", err);
      }
    }, safeDelay);
  }

  extractStatusCode(err) {
    if (!err) {
      return null;
    }
    const directCode = err.status || err.statusCode || err.code;
    if (typeof directCode === "number") {
      return directCode;
    }
    if (typeof directCode === "string" && /^\d{3}$/.test(directCode)) {
      return parseInt(directCode, 10);
    }
    const message = err.message || "";
    const match = message.match(/\b([45]\d{2})\b/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  /*
   * Helpers to normalize and apply events to device objects. These were
   * previously implemented in the node_helper; moving them here centralizes
   * API-specific parsing.
   */
  applyEventToDevice(device, event) {
    if (!device || !event || !event.key) return;
    const key = event.key;
    const value = event.value;

    switch (key) {
      case "BSH.Common.Option.RemainingProgramTime":
        device.RemainingProgramTime = value;
        // Persist an initial remaining value when we first see a positive remaining time
        try {
          const rem = typeof value === "number" ? value : parseInt(String(value || ""), 10);
          if (Number.isFinite(rem) && rem > 0 && !device._initialRemaining) {
            device._initialRemaining = rem;
          }
          // If remaining is explicitly zero, clear the initial estimate
          if (Number.isFinite(rem) && rem === 0 && device._initialRemaining) {
            delete device._initialRemaining;
          }
        } catch {
          // ignore parse errors
        }
        break;
      case "BSH.Common.Option.ProgramProgress":
        device.ProgramProgress = value;
        // If program progress reaches 100, clear any stored initialRemaining estimate
        try {
          const p = typeof value === "number" ? value : parseFloat(String(value || ""));
          if (Number.isFinite(p) && Math.round(p) >= 100 && device._initialRemaining) {
            delete device._initialRemaining;
          }
        } catch {
          // ignore
        }
        break;
      case "BSH.Common.Status.OperationState": {
        const stateValue =
          typeof value === "string"
            ? value
            : value && typeof value.value === "string"
              ? value.value
              : value;
        device.OperationState = stateValue;
        if (stateValue === "BSH.Common.EnumType.OperationState.Finished") {
          device.RemainingProgramTime = 0;
          // finished -> clear any initial remaining estimate
          if (device._initialRemaining) delete device._initialRemaining;
        }
        break;
      }
      case "Cooking.Common.Setting.Lighting":
        device.Lighting = value;
        break;
      case "BSH.Common.Setting.PowerState":
        {
          const powerStateMap = {
            "BSH.Common.EnumType.PowerState.On": "On",
            "BSH.Common.EnumType.PowerState.Standby": "Standby",
            "BSH.Common.EnumType.PowerState.Off": "Off"
          };
          device.PowerState = powerStateMap[value];
        }
        break;
      case "BSH.Common.Status.DoorState":
        {
          const doorStateMap = {
            "BSH.Common.EnumType.DoorState.Open": "Open",
            "BSH.Common.EnumType.DoorState.Closed": "Closed",
            "BSH.Common.EnumType.DoorState.Locked": "Locked"
          };
          device.DoorState = doorStateMap[value];
        }
        break;
      default:
        // no-op for unhandled keys
        break;
    }
  }
}

module.exports = HomeConnect;
