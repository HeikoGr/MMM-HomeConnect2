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
    console.warn(
      `EventSource polyfill not available. Install 'eventsource'. ${error.message}`
    );
  }
}

const EventEmitter = require("events");
/* eslint-enable n/no-unsupported-features/node-builtins */

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

const { fetch } = require("undici");

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
    const baseUrl = global.isSimulated
      ? global.urls.simulation.base
      : global.urls.physical.base,
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
      baseUrl: global.isSimulated
        ? global.urls.simulation.base
        : global.urls.physical.base,
      apis: {
        appliances: {
          get_home_appliances: () =>
            makeApiRequest("GET", "api/homeappliances", accessToken)
        },
        status: {
          get_status: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/status`,
              accessToken
            )
        },
        settings: {
          get_settings: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/settings`,
              accessToken
            )
        },
        // New: programs API support
        programs: {
          get_active_program: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/programs/active`,
              accessToken
            )
        }
      }
    });
  },
  refreshToken = (clientSecret, refreshTokenValue) =>
    new Promise((resolve, reject) => {
      // Build form body; include client_secret only if provided
      const params = [
        `grant_type=refresh_token`,
        `refresh_token=${encodeURIComponent(refreshTokenValue)}`
      ];
      if (clientSecret) {
        params.push(`client_secret=${encodeURIComponent(clientSecret)}`);
      }
      const body = params.join("&");

      fetch(
        `${global.isSimulated
          ? global.urls.simulation.base
          : global.urls.physical.base
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
      this.tokens.timestamp +
      this.tokens.expires_in * 0.9 -
      Math.floor(Date.now() / 1000);
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
        err.statusCode ||
        err.status ||
        (err.message && (err.message.includes("404") ? 404 : null));
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
        err.statusCode ||
        err.status ||
        (err.message && (err.message.includes("404") ? 404 : null));
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
        err.statusCode ||
        err.status ||
        (err.message && (err.message.includes("404") ? 404 : null));
      return {
        success: false,
        statusCode: code,
        error: err.message || String(err)
      };
    }
  }

  subscribeDevice(haid, event, callback) {
    if (this.eventSources && !(haid in this.eventSources)) {
      const url = global.isSimulated
        ? global.urls.simulation.base
        : global.urls.physical.base,
        eventSource = new ESConstructor(
          `${url}api/homeappliances/${haid}/events`,
          {
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${this.tokens.access_token}`
            }
          }
        );
      this.eventSources = { ...this.eventSources, [haid]: eventSource };
    }

    if (this.eventListeners && !(haid in this.eventListeners)) {
      const listeners = new Map();
      listeners.set(event, callback);
      this.eventListeners = { ...this.eventListeners, [haid]: listeners };
    }

    this.eventSources[haid].addEventListener(event, callback);
    this.eventListeners[haid].set(event, callback);
  }

  subscribe(event, callback) {
    if (!this.eventSource) {
      const url = global.isSimulated
        ? global.urls.simulation.base
        : global.urls.physical.base;
      this.eventSource = new ESConstructor(`${url}api/homeappliances/events`, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.tokens.access_token}`
        }
      });
    }

    this.eventSource.addEventListener(event, callback);
    this.eventListener.set(event, callback);
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
        this.clientSecret,
        this.tokens.refresh_token
      );
      this.emit("newRefreshToken", this.tokens.refresh_token);
      this.client = await utils.getClient(this.tokens.access_token);
      this.recreateEventSources();
      timeToNextTokenRefresh =
        this.tokens.timestamp +
        this.tokens.expires_in * 0.9 -
        Math.floor(Date.now() / 1000);
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
    for (const haid of Object.keys(this.eventSources)) {
      this.eventSources[haid].close();
      for (const [event, callback] of this.eventListeners[haid]) {
        this.eventSources[haid].removeEventListener(event, callback);
      }
      const url = global.isSimulated
        ? global.urls.simulation.base
        : global.urls.physical.base;
      this.eventSources[haid] = new ESConstructor(
        `${url}api/homeappliances/${haid}/events`,
        {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${this.tokens.access_token}`
          }
        }
      );
      for (const [event, callback] of this.eventListeners[haid]) {
        this.eventSources[haid].addEventListener(event, callback);
      }
    }
    if (this.eventSource) {
      this.eventSource.close();
      for (const [event, callback] of this.eventListener) {
        this.eventSource.removeEventListener(event, callback);
      }
      const url = global.isSimulated
        ? global.urls.simulation.base
        : global.urls.physical.base;
      this.eventSource = new ESConstructor(`${url}api/homeappliances/events`, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.tokens.access_token}`
        }
      });
      for (const [event, callback] of this.eventListener) {
        this.eventSource.addEventListener(event, callback);
      }
    }
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
        break;
      case "BSH.Common.Option.ProgramProgress":
        device.ProgramProgress = value;
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
