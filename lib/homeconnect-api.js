// Vendored single-file version of home-connect-js (utils + main combined)

/* global EventSource */
// Load EventSource polyfill explicitly for Node environments (avoid feature check noise)
// ESConstructor represents either the native EventSource or a polyfill; kept local rather than
// assigned to a global so it stays a declared binding.
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
const {
  clearDeviceFields,
  extractValueByType,
  getOptionDisplayLabel,
  humanizeApiKey,
  parseDurationSeconds,
  ESTIMATED_DURATION_FLAG_KEYS,
  ESTIMATED_TOTAL_TIME_KEYS,
  OBSERVED_RUNTIME_KEYS,
  PROGRESS_KEYS,
  REMAINING_TIME_KEYS
} = require("./device-utils");

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

const fetch = globalThis.fetch;
const baseFetch = globalThis.fetch.bind(globalThis);
const HeadersCtor = globalThis.Headers;
const AbortControllerCtor = globalThis.AbortController;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// Retry pacing for the two loops that can keep hammering Home Connect on their
// own: the token endpoint and the SSE channels. Both used to retry at a fixed
// interval, which turns a 429 into a self-sustaining penalty - the client keeps
// spending its quota on requests that can only fail until the backoff expires.
const TOKEN_REFRESH_BASE_DELAY_S = 60;
const TOKEN_REFRESH_MAX_DELAY_S = 60 * 60;
const SSE_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

const DEFAULT_ACCEPT_LANGUAGE_BY_BASE = {
  bg: "bg-BG",
  cs: "cs-CZ",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  fi: "fi-FI",
  fr: "fr-FR",
  hr: "hr-HR",
  hu: "hu-HU",
  it: "it-IT",
  nb: "nb-NO",
  nl: "nl-NL",
  pl: "pl-PL",
  pt: "pt-PT",
  ro: "ro-RO",
  ru: "ru-RU",
  sk: "sk-SK",
  sl: "sl-SI",
  sr: "sr-SR",
  sv: "sv-SE",
  tr: "tr-TR",
  uk: "uk-UA",
  zh: "zh-CN"
};

function normalizeLanguageTagPart(part, index) {
  if (!part) {
    return "";
  }

  const trimmed = String(part).trim();
  if (!trimmed) {
    return "";
  }

  if (index === 0) {
    return trimmed.toLowerCase();
  }

  if (trimmed.length === 2 || trimmed.length === 3) {
    return trimmed.toUpperCase();
  }

  if (trimmed.length === 4) {
    return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1).toLowerCase()}`;
  }

  return trimmed;
}

const normalizeAcceptLanguage = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/_/g, "-");
  const parts = normalized
    .split("-")
    .map((part, index) => normalizeLanguageTagPart(part, index))
    .filter(Boolean);

  if (!parts.length) {
    return "";
  }

  if (parts.length === 1) {
    return DEFAULT_ACCEPT_LANGUAGE_BY_BASE[parts[0]] || parts[0];
  }

  return parts.join("-");
};

const resolveAcceptLanguage = (requestOptions = {}) => {
  const language =
    typeof requestOptions.getAcceptLanguage === "function"
      ? requestOptions.getAcceptLanguage()
      : requestOptions.acceptLanguage;

  return normalizeAcceptLanguage(language);
};

const resolveRequestTimeoutMs = (requestOptions = {}) => {
  const rawTimeout =
    typeof requestOptions.getRequestTimeoutMs === "function"
      ? requestOptions.getRequestTimeoutMs()
      : requestOptions.requestTimeoutMs;

  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return Math.max(10, Math.round(rawTimeout));
};

function parseRetryAfterSeconds(headersLike) {
  if (!headersLike || typeof headersLike.get !== "function") {
    return null;
  }

  const raw = headersLike.get("retry-after");
  if (!raw) {
    return null;
  }

  const numeric = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }

  const retryDate = Date.parse(String(raw));
  if (Number.isFinite(retryDate)) {
    const seconds = Math.ceil((retryDate - Date.now()) / 1000);
    return Math.max(0, seconds);
  }

  return null;
}

function createHttpError(res, responseText) {
  const truncated =
    typeof responseText === "string" && responseText.length > 1000
      ? `${responseText.slice(0, 1000)}... (truncated)`
      : responseText;
  const err = new Error(`HTTP ${res.status} ${res.statusText}: ${truncated}`);
  err.statusCode = res.status;
  err.retryAfterSeconds = parseRetryAfterSeconds(res && res.headers);
  return err;
}

// Shared shape for the normalized-result REST wrapper methods below
// (getHomeAppliances, getActiveProgram, ...): { success: false, statusCode,
// retryAfterSeconds, error }. Falls back to parsing a "404" out of the error
// message when the thrown error carries no explicit status code.
function buildApiErrorResult(err) {
  const code =
    err.statusCode || err.status || (err.message && (err.message.includes("404") ? 404 : null));
  return {
    success: false,
    statusCode: code,
    retryAfterSeconds: Number.isFinite(err.retryAfterSeconds) ? err.retryAfterSeconds : null,
    error: err.message || String(err)
  };
}

const fetchWithTimeout = (url, options = {}, requestOptions = {}) => {
  const timeoutMs = resolveRequestTimeoutMs(requestOptions);

  if (!AbortControllerCtor || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortControllerCtor();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).catch((error) => {
    const aborted =
      controller.signal.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";

    if (!aborted) {
      throw error;
    }

    const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
    timeoutError.code = "ETIMEDOUT";
    timeoutError.statusCode = 408;
    throw timeoutError;
  }).finally(() => {
    clearTimeout(timeoutId);
  });
};

function ensureSummaryBucket(device, bucketKey) {
  if (
    !device[bucketKey] ||
    typeof device[bucketKey] !== "object" ||
    Array.isArray(device[bucketKey])
  ) {
    device[bucketKey] = {};
  }
  return device[bucketKey];
}

function setSummaryEntry(device, bucketKey, entryKey, label) {
  const bucket = ensureSummaryBucket(device, bucketKey);
  if (typeof label !== "string" || !label.trim()) {
    delete bucket[entryKey];
    if (Object.keys(bucket).length === 0) {
      delete device[bucketKey];
    }
    return;
  }
  bucket[entryKey] = label.trim();
}

function setAlertEntry(device, key, value, label) {
  if (shouldRetainAlert(value)) {
    setSummaryEntry(device, "DeviceAlertsByKey", key, label);
    return;
  }
  setSummaryEntry(device, "DeviceAlertsByKey", key, "");
}

function shouldRetainAlert(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const token = value.split(".").pop().trim().toLowerCase();
    if (!token) {
      return false;
    }
    if (["false", "off", "inactive", "closed", "none", "normal", "ok"].includes(token)) {
      return false;
    }
    return true;
  }

  if (typeof value === "object") {
    return shouldRetainAlert(value.value !== undefined ? value.value : value.displayValue);
  }

  return true;
}

function getEventLabel(event, options = {}) {
  if (!event || typeof event !== "object") {
    return "";
  }
  return getOptionDisplayLabel(event, options) || humanizeApiKey(event.key);
}

// "active" is a claim that a program is running right now. The appliance backs
// that claim with BSH.Common.Root.ActiveProgram and an operation state that has a
// program in it; once either says otherwise, what is left is the program sitting
// on the dial - still worth knowing, but merely selected. The name and its options
// therefore stay, the claim and the run-specific phase do not.
//
// Without this an appliance that finished while the helper was running keeps
// announcing an active program for the lifetime of the process, while a helper
// started afterwards correctly shows it as selected.
// Keys the switch in applyEventToDevice() converts into a friendly field. Storing
// the raw key as well would leave two spellings of the same observable on the
// device: every reader would have to know both, and clearing only one lets the
// other resurface through the parsers - which is how a finished cycle used to keep
// a full progress bar alive. Everything not listed here has no friendly field and
// is therefore still stored under its raw key.
const NORMALIZED_EVENT_KEYS = new Set([
  "BSH.Common.Option.RemainingProgramTime",
  "BSH.Common.Status.RemainingProgramTime",
  "BSH.Common.Option.ProgramProgress",
  "BSH.Common.Status.ProgramProgress",
  "BSH.Common.Option.EstimatedTotalProgramTime",
  "BSH.Common.Status.EstimatedTotalProgramTime",
  "BSH.Common.Option.FinishInRelative",
  "BSH.Common.Status.FinishInRelative",
  "BSH.Common.Option.RemainingProgramTimeIsEstimated",
  "BSH.Common.Status.RemainingProgramTimeIsEstimated",
  "BSH.Common.Status.OperationState",
  "Cooking.Common.Setting.Lighting",
  "BSH.Common.Setting.PowerState",
  "BSH.Common.Status.DoorState"
]);

function demoteActiveProgramClaim(device) {
  if (device.ActiveProgramSource === "active") {
    device.ActiveProgramSource = "selected";
  }
  delete device.ActiveProgramPhase;
}

function getPowerStateLabel(value) {
  const stringValue = extractValueByType(value, "string");
  if (!stringValue) {
    return "";
  }

  const powerStateMap = {
    "BSH.Common.EnumType.PowerState.On": "On",
    "BSH.Common.EnumType.PowerState.Standby": "Standby",
    "BSH.Common.EnumType.PowerState.Off": "Off"
  };

  return powerStateMap[stringValue] || stringValue.split(".").pop();
}

function getDoorStateLabel(value) {
  const stringValue = extractValueByType(value, "string");
  if (!stringValue) {
    return "";
  }

  const doorStateMap = {
    "BSH.Common.EnumType.DoorState.Open": "Open",
    "BSH.Common.EnumType.DoorState.Closed": "Closed",
    "BSH.Common.EnumType.DoorState.Locked": "Locked"
  };

  return doorStateMap[stringValue] || stringValue.split(".").pop();
}

function deriveTrailingLabel(key, marker) {
  if (typeof key !== "string" || !key.includes(marker)) {
    return humanizeApiKey(key);
  }
  return humanizeApiKey(key.slice(key.indexOf(marker) + marker.length));
}

function applyRefrigerationState(device, event) {
  const { key, value } = event;
  if (!/Refrigeration\./.test(key)) {
    return;
  }

  if (/Door/i.test(key)) {
    const compartment = deriveTrailingLabel(key, ".Door.");
    const doorState = getDoorStateLabel(value) || getEventLabel(event, { includeKeyLabel: false });
    if (doorState) {
      setSummaryEntry(
        device,
        "RefrigerationDoorStates",
        compartment,
        `${compartment}: ${doorState}`
      );
      setSummaryEntry(
        device,
        "DeviceStatusByKey",
        `refrigeration-door-${compartment}`,
        `${compartment}: ${doorState}`
      );
      if (/open/i.test(doorState)) {
        device.DoorOpen = true;
        device.DoorState = "Open";
      }
    }
  }

  if (/Alarm/i.test(key)) {
    const alarmLabel = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, alarmLabel);
  }
}

function applyCoffeeState(device, event) {
  const { key, value } = event;
  if (!/CoffeeMaker\./.test(key)) {
    return;
  }

  if (/\.Option\./.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/\.Event\./.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applyHoodState(device, event) {
  const { key, value } = event;
  if (!/Hood\./.test(key) && !/Cooking\.Common\.Program\.Hood\./.test(key)) {
    return;
  }

  if (/VentingLevel|IntensiveLevel/.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/Filter|Saturation|CleaningRequired/i.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applyOvenState(device, event) {
  const { key, value } = event;
  if (!/^Cooking\.Oven\./.test(key) && !/^Cooking\.Common\./.test(key)) {
    return;
  }

  if (/SetpointTemperature|FastPreHeat|WarmingLevel/.test(key)) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/PreheatFinished/.test(key)) {
    setAlertEntry(device, key, value, humanizeApiKey(key));
  }
}

function applyRobotState(device, event) {
  const { key, value } = event;
  if (!/CleaningRobot\./.test(key)) {
    return;
  }

  if (
    /CleaningMode|SuctionPower|ReferenceMapId|ProcessPhase|BatteryLevel|BatteryChargingState|ChargingConnection|LastSelectedMap/.test(
      key
    )
  ) {
    const label = getEventLabel(event);
    setSummaryEntry(device, "DeviceStatusByKey", key, label);
  }

  if (/DustBoxInserted/.test(key)) {
    if (shouldRetainAlert(value) === false) {
      setSummaryEntry(device, "DeviceAlertsByKey", key, "Dust box missing");
    } else {
      setSummaryEntry(device, "DeviceAlertsByKey", key, "");
    }
    return;
  }

  if (/RobotIsStuck|DockingStationNotFound|EmptyDustBoxAndCleanFilter|Lost|Lifted/i.test(key)) {
    const label = getEventLabel(event, { includeKeyLabel: false }) || humanizeApiKey(key);
    setAlertEntry(device, key, value, label);
  }
}

function applySpecializedEventState(device, event) {
  applyRefrigerationState(device, event);
  applyCoffeeState(device, event);
  applyHoodState(device, event);
  applyOvenState(device, event);
  applyRobotState(device, event);
}

const checkResponseStatus = (res) => {
  if (res.ok || res.status === 202) {
    return res;
  }
  // Try to get response body text for better debugging
  return res.text().then((text) => {
    throw createHttpError(res, text);
  });
},
  /*
   * --- utils ---
   * Note: The interactive browser OAuth flow has been removed.
   * This module expects a refresh token to be available (headless/device flow).
   */

  makeApiRequest = (method, path, accessToken, body = null, requestOptions = {}) => {
    const baseUrl = global.isSimulated ? global.urls.simulation.base : global.urls.physical.base,
      url = baseUrl + path,
      acceptLanguage = resolveAcceptLanguage(requestOptions),
      options = {
        method,
        headers: {
          accept: "application/vnd.bsh.sdk.v1+json",
          authorization: `Bearer ${accessToken}`
        }
      };

    if (acceptLanguage && method === "GET") {
      options.headers["accept-language"] = acceptLanguage;
    }

    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    return fetchWithTimeout(url, options, requestOptions)
      .then(checkResponseStatus)
      .then((res) => res.json())
      .then((json) => ({ body: json }));

    // Wrap in body to match swagger-client response format
  },
  getClient = function getClient(accessToken, requestOptions = {}) {
    /*
     * Return a simple client object that mimics the swagger-client API structure
     * but uses fetch directly for API calls
     */
    return Promise.resolve({
      accessToken,
      baseUrl: global.isSimulated ? global.urls.simulation.base : global.urls.physical.base,
      apis: {
        appliances: {
          get_home_appliances: () =>
            makeApiRequest("GET", "api/homeappliances", accessToken, null, requestOptions)
        },
        status: {
          get_status: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/status`,
              accessToken,
              null,
              requestOptions
            )
        },
        settings: {
          get_settings: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/settings`,
              accessToken,
              null,
              requestOptions
            )
        },
        // New: programs API support
        programs: {
          get_active_program: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/programs/active`,
              accessToken,
              null,
              requestOptions
            ),
          get_selected_program: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/programs/selected`,
              accessToken,
              null,
              requestOptions
            ),
          get_available_programs: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/programs/available`,
              accessToken,
              null,
              requestOptions
            ),
          get_available_program: (params) =>
            makeApiRequest(
              "GET",
              `api/homeappliances/${params.haId}/programs/available/${encodeURIComponent(params.programKey)}`,
              accessToken,
              null,
              requestOptions
            )
        }
      }
    });
  },
  refreshToken = (clientId, clientSecret, refreshTokenValue, requestOptions = {}) =>
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

      fetchWithTimeout(
        `${global.isSimulated ? global.urls.simulation.base : global.urls.physical.base
        }security/oauth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body
        },
        requestOptions
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
  constructor(clientId, clientSecret, refreshToken, options = {}) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.acceptLanguage = normalizeAcceptLanguage(options.acceptLanguage || options.language);
    this.requestTimeoutMs = resolveRequestTimeoutMs(options);
    this.tokens = {};
    this.tokens.refresh_token = refreshToken;
    this.eventSources = {};
    this.eventListeners = {};
    this.eventSource = null;
    this.eventListener = new Map();
    this.tokenRefreshTimeout = null;
    this._lastEventErrorAt = 0;
    this.eventSourceRetryConfig = {
      baseDelayMs: 5000,
      authDelayMs: 30000,
      maxDelayMs: SSE_RETRY_MAX_DELAY_MS
    };
    // Backoff is tracked per channel ("global" / "device:<haId>") so one failing
    // appliance cannot drag the healthy channels into its retry cycle.
    this._eventSourceRetryState = new Map();
    this._tokenRefreshFailures = 0;
    this._tokenRefreshBlockedUntil = 0;
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
      const acceptLanguage = normalizeAcceptLanguage(this.acceptLanguage);
      if (accessToken) {
        headers.set("authorization", `Bearer ${accessToken}`);
      }
      if (!headers.has("accept")) {
        headers.set("accept", "text/event-stream");
      }
      if (acceptLanguage && !headers.has("accept-language")) {
        headers.set("accept-language", acceptLanguage);
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
        this.tokens.refresh_token,
        {
          getRequestTimeoutMs: () => this.requestTimeoutMs
        }
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
    this.client = await utils.getClient(this.tokens.access_token, {
      getAcceptLanguage: () => this.acceptLanguage,
      getRequestTimeoutMs: () => this.requestTimeoutMs
    });
    this.emit("newRefreshToken", this.tokens.refresh_token);
  }

  setAcceptLanguage(language) {
    this.acceptLanguage = normalizeAcceptLanguage(language);
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
      return buildApiErrorResult(err);
    }
  }

  async getActiveProgram(haId) {
    try {
      const res = await this.command("programs", "get_active_program", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  async getSelectedProgram(haId) {
    try {
      const res = await this.command("programs", "get_selected_program", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  async getAvailablePrograms(haId) {
    try {
      const res = await this.command("programs", "get_available_programs", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  async getAvailableProgram(haId, programKey) {
    try {
      const res = await this.client.apis.programs.get_available_program({ haId, programKey });
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  async getStatus(haId) {
    try {
      const res = await this.command("status", "get_status", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  async getSettings(haId) {
    try {
      const res = await this.command("settings", "get_settings", haId);
      return { success: true, data: res.body.data };
    } catch (err) {
      return buildApiErrorResult(err);
    }
  }

  subscribeDevice(haid, event, callback) {
    if (this.eventSources && !this.eventSources[haid]) {
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
        this.resetEventSourceRetryState("global");
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
        this.resetEventSourceRetryState(`device:${haid}`);
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

  // Milliseconds left of an active token-endpoint backoff, 0 when refreshing is
  // allowed. Callers other than the scheduled refresh (SSE auth recovery, the
  // pre-subscribe refresh) must respect this or they reopen the loop the
  // backoff exists to close.
  tokenRefreshBackoffRemainingMs() {
    return Math.max(0, (this._tokenRefreshBlockedUntil || 0) - Date.now());
  }

  nextTokenRefreshDelaySeconds(error) {
    const retryAfterSeconds = Number.isFinite(error?.retryAfterSeconds)
      ? Math.max(1, Math.ceil(error.retryAfterSeconds))
      : null;
    if (retryAfterSeconds) {
      return Math.min(retryAfterSeconds, TOKEN_REFRESH_MAX_DELAY_S);
    }

    const attempt = Math.max(1, Math.min(this._tokenRefreshFailures, 8));
    const grown = TOKEN_REFRESH_BASE_DELAY_S * Math.pow(2, attempt - 1);
    const capped = Math.min(grown, TOKEN_REFRESH_MAX_DELAY_S);
    // Jitter so several mirrors sharing a client id do not retry in lockstep.
    return Math.round(capped * (1 + Math.random() * 0.2));
  }

  async refreshTokens() {
    const blockedForMs = this.tokenRefreshBackoffRemainingMs();
    if (blockedForMs > 0) {
      console.warn(
        `Token refresh suppressed - endpoint backoff active for another ${Math.ceil(blockedForMs / 1000)}s`
      );
      return;
    }

    clearTimeout(this.tokenRefreshTimeout);
    let timeToNextTokenRefresh;
    try {
      this.tokens = await utils.refreshToken(
        this.clientId,
        this.clientSecret,
        this.tokens.refresh_token,
        {
          getRequestTimeoutMs: () => this.requestTimeoutMs
        }
      );
      this._tokenRefreshFailures = 0;
      this._tokenRefreshBlockedUntil = 0;
      this.emit("newRefreshToken", this.tokens.refresh_token);
      this.client = await utils.getClient(this.tokens.access_token, {
        getAcceptLanguage: () => this.acceptLanguage,
        getRequestTimeoutMs: () => this.requestTimeoutMs
      });
      this.recreateEventSources();
      timeToNextTokenRefresh =
        this.tokens.timestamp + this.tokens.expires_in * 0.9 - Math.floor(Date.now() / 1000);
    } catch (error) {
      // A fixed 60s retry kept the client inside a 429 penalty window forever:
      // every attempt is answered with another 429 and spends quota. Back off
      // exponentially, honour Retry-After, and block other callers meanwhile.
      this._tokenRefreshFailures += 1;
      timeToNextTokenRefresh = this.nextTokenRefreshDelaySeconds(error);
      this._tokenRefreshBlockedUntil = Date.now() + timeToNextTokenRefresh * 1000;

      if (this.extractStatusCode(error) === 429) {
        this.emit("rateLimit", {
          source: "token",
          retryAfterSeconds: timeToNextTokenRefresh
        });
      }

      console.error(`Could not refresh tokens: ${error.message}`);
      console.error(
        `Retrying in ${timeToNextTokenRefresh}s (consecutive failures: ${this._tokenRefreshFailures})`
      );
    }
    this.tokenRefreshTimeout = setTimeout(
      () => this.refreshTokens(),
      timeToNextTokenRefresh * 1000
    );
  }

  recreateEventSources() {
    this.clearEventSourceRetryTimers();
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

  // Tears down everything the instance keeps running in the background: the
  // token auto-refresh timer, any pending reconnect timer, and all SSE
  // channels. Callers that discard a HomeConnect instance (e.g. replacing it
  // with a freshly re-authenticated one) must call this first, otherwise
  // tokenRefreshTimeout keeps firing against a client nobody references anymore.
  destroy() {
    clearTimeout(this.tokenRefreshTimeout);
    this.tokenRefreshTimeout = null;
    this.clearEventSourceRetryTimers();
    this._eventSourceRetryState.clear();
    this.closeEventSources();
  }

  getEventSourceRetryState(label) {
    let state = this._eventSourceRetryState.get(label);
    if (!state) {
      state = { attempts: 0, timer: null };
      this._eventSourceRetryState.set(label, state);
    }
    return state;
  }

  // Called from the "open" listener: a channel that reconnected successfully
  // starts from the base delay again. This is what keeps a routine stream
  // restart (Home Connect ends idle streams) from escalating the backoff -
  // only reconnects that keep failing ever climb.
  resetEventSourceRetryState(label) {
    const state = this._eventSourceRetryState.get(label);
    if (state) {
      state.attempts = 0;
    }
  }

  nextEventSourceRetryDelayMs(label, err, { isAuthError, isRateLimited }) {
    const state = this.getEventSourceRetryState(label);
    state.attempts += 1;

    const retryAfterSeconds = Number.isFinite(err?.retryAfterSeconds)
      ? Math.max(1, Math.ceil(err.retryAfterSeconds))
      : null;
    if (retryAfterSeconds) {
      return Math.min(retryAfterSeconds * 1000, this.eventSourceRetryConfig.maxDelayMs);
    }

    const base =
      isAuthError || isRateLimited
        ? this.eventSourceRetryConfig.authDelayMs
        : this.eventSourceRetryConfig.baseDelayMs;
    const grown = base * Math.pow(2, Math.min(state.attempts - 1, 10));
    return Math.min(grown, this.eventSourceRetryConfig.maxDelayMs);
  }

  handleEventSourceError(sourceLabel, err) {
    const code = this.extractStatusCode(err);
    const message = err && err.message ? err.message : err;
    const isAuthError = code === 401 || code === 403;
    const isRateLimited = code === 429;

    console.error(`EventSource error (${sourceLabel})${code ? ` [${code}]` : ""}: ${message}`);

    this.closeEventSourceByLabel(sourceLabel);

    const delay = this.nextEventSourceRetryDelayMs(sourceLabel, err, {
      isAuthError,
      isRateLimited
    });

    if (isRateLimited) {
      this.emit("rateLimit", {
        source: `sse:${sourceLabel}`,
        retryAfterSeconds: Math.ceil(delay / 1000)
      });
    }

    if (isAuthError) {
      this.recoverFromAuthError(delay, sourceLabel);
      return;
    }

    console.error(`Re-subscribing ${sourceLabel} in ${delay}ms due to event source error`);
    this.scheduleEventSourceRecreate(delay, sourceLabel);
  }

  recoverFromAuthError(delayMs, sourceLabel) {
    if (this._authRecoveryInFlight) {
      console.debug &&
        console.debug("Auth recovery already in progress - skipping additional trigger");
      return;
    }

    const fallback = () => {
      console.error(
        `Auth recovery failed - will retry ${sourceLabel} event source recreate in ${delayMs}ms`
      );
      this.scheduleEventSourceRecreate(delayMs, sourceLabel);
    };

    // Refreshing is pointless (and quota-expensive) while the token endpoint is
    // still in backoff - wait it out and rebuild the channel afterwards.
    const blockedForMs = this.tokenRefreshBackoffRemainingMs();
    if (blockedForMs > 0) {
      console.warn(
        `SSE auth recovery deferred - token endpoint backoff active for another ${Math.ceil(blockedForMs / 1000)}s`
      );
      this.scheduleEventSourceRecreate(Math.max(delayMs, blockedForMs), sourceLabel);
      return;
    }

    this._authRecoveryInFlight = true;

    this.refreshTokens()
      .then(() => {
        // refreshTokens() rebuilds every live channel, but the one that just
        // failed was closed above and is no longer in the map.
        this.scheduleEventSourceRecreate(0, sourceLabel);
      })
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

  // One timer per channel, and the retry rebuilds only that channel. Rebuilding
  // every channel because one of them failed multiplied a single offline
  // appliance into N reconnects per retry - the fastest way to burn the quota.
  scheduleEventSourceRecreate(delayMs, sourceLabel) {
    if (!sourceLabel) {
      return;
    }

    const state = this.getEventSourceRetryState(sourceLabel);
    if (state.timer) {
      // Existing retry scheduled for this channel; do not stack timers
      return;
    }

    const safeDelay = Number.isFinite(delayMs) ? Math.max(delayMs, 0) : 0;
    const jitterRange = Math.max(1, Math.round(safeDelay * 0.2));
    const jitteredDelay = safeDelay + Math.floor(Math.random() * jitterRange);

    state.timer = setTimeout(() => {
      state.timer = null;
      try {
        this.recreateEventSourceByLabel(sourceLabel);
      } catch (err) {
        console.error(`Failed to recreate event source ${sourceLabel} after backoff:`, err);
      }
    }, jitteredDelay);
  }

  recreateEventSourceByLabel(label) {
    if (label === "global") {
      const listeners = this.eventListener;
      if (!listeners || listeners.size === 0) {
        return;
      }
      this.eventSource = null;
      this._globalEventMonitorAttached = false;
      for (const [event, callback] of listeners) {
        this.subscribe(event, callback);
      }
      return;
    }

    if (!label.startsWith("device:")) {
      return;
    }

    const haid = label.slice("device:".length);
    const listeners = this.eventListeners && this.eventListeners[haid];
    if (!listeners || listeners.size === 0) {
      return;
    }

    // Drop the dead entry entirely: subscribeDevice only creates a new stream
    // when the key is absent, and closeEventSourceByLabel leaves it as null.
    delete this.eventSources[haid];
    if (this._deviceEventMonitors[haid]) {
      this._deviceEventMonitors[haid].attached = false;
    }
    for (const [event, callback] of listeners) {
      this.subscribeDevice(haid, event, callback);
    }
  }

  clearEventSourceRetryTimers() {
    for (const state of this._eventSourceRetryState.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
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
    const now = Date.now();

    // Any successfully applied API payload or SSE event proves the appliance is
    // currently reachable via Home Connect, even if the last /homeappliances
    // snapshot still carries a stale connected=false flag.
    device.connected = true;
    if (!NORMALIZED_EVENT_KEYS.has(key)) {
      device[key] = value;
    }

    switch (key) {
      case "BSH.Common.Option.RemainingProgramTime":
      case "BSH.Common.Status.RemainingProgramTime":
        device.RemainingProgramTime = value;
        // Persist an initial remaining value when we first see a positive remaining time
        try {
          const rem = parseDurationSeconds(value);
          if (Number.isFinite(rem) && rem > 0) {
            const staleFinishedState =
              device.OperationState === "BSH.Common.EnumType.OperationState.Finished";
            const staleCompletedProgress =
              Number.isFinite(Number(device.ProgramProgress)) &&
              Number(device.ProgramProgress) >= 100;

            if (staleFinishedState) {
              delete device.OperationState;
            }

            if (staleCompletedProgress) {
              clearDeviceFields(device, PROGRESS_KEYS);
            }

            if (!device._initialRemaining) {
              device._initialRemaining = rem;
            }
            if (!device._remainingObservedAt) {
              device._remainingObservedAt = now;
            }
            device._lastRemainingSeenAt = now;
          }
          // If remaining is explicitly zero, clear the initial estimate
          if (Number.isFinite(rem) && rem === 0) {
            delete device._initialRemaining;
            delete device._remainingObservedAt;
            delete device._lastRemainingSeenAt;
          }
        } catch {
          // ignore parse errors
        }
        break;
      case "BSH.Common.Option.ProgramProgress":
      case "BSH.Common.Status.ProgramProgress": {
        const numericProgress = extractValueByType(value, "number", (val) => {
          const p = Number(val);
          return Number.isFinite(p) ? p : null;
        });
        device.ProgramProgress = numericProgress !== null ? numericProgress : value;
        // If program progress reaches 100, clear any stored initialRemaining estimate
        try {
          const p = extractValueByType(value, "number", (val) => {
            const num = Number(val);
            return Number.isFinite(num) ? num : null;
          });
          if (Number.isFinite(p) && Math.round(p) >= 100) {
            delete device._initialRemaining;
            delete device._remainingObservedAt;
            delete device._lastRemainingSeenAt;
          }
        } catch {
          // ignore
        }
        break;
      }
      case "BSH.Common.Option.EstimatedTotalProgramTime":
      case "BSH.Common.Status.EstimatedTotalProgramTime": {
        const totalSeconds = parseDurationSeconds(value);
        device.EstimatedTotalProgramTime = totalSeconds !== null ? totalSeconds : value;
        break;
      }
      case "BSH.Common.Option.FinishInRelative":
      case "BSH.Common.Status.FinishInRelative":
        device.FinishInRelative = value;
        break;
      case "BSH.Common.Option.RemainingProgramTimeIsEstimated":
      case "BSH.Common.Status.RemainingProgramTimeIsEstimated":
        device.RemainingProgramTimeIsEstimated = value;
        break;
      case "BSH.Common.Status.OperationState": {
        const stateValue =
          typeof value === "string"
            ? value
            : value && typeof value.value === "string"
              ? value.value
              : value;
        device.OperationState = stateValue;
        const stateLabel = typeof stateValue === "string" ? stateValue.split(".").pop() : "";
        // "Inactive"/"Ready" mean no program is running any more - typically
        // reported when the door is opened after a finished cycle. The appliance
        // stops updating its runtime values at that point, so leftovers (a reset
        // progress of 0, a remaining time stuck at 0) would survive for the
        // lifetime of the process and paint a stale bar on long-running
        // instances, while a freshly started one shows nothing. A remaining time
        // of 0 is the worse of the two: combined with the planned duration it
        // computes to a permanent 100 %.
        //
        // The planned duration and the program identity are deliberately kept -
        // an idle appliance legitimately reports the program sitting on its dial.
        if (stateLabel === "Inactive" || stateLabel === "Ready") {
          clearDeviceFields(device, PROGRESS_KEYS, REMAINING_TIME_KEYS, OBSERVED_RUNTIME_KEYS);
          demoteActiveProgramClaim(device);
        }
        if (stateValue === "BSH.Common.EnumType.OperationState.Finished") {
          // finished -> drop the whole runtime block, then restate remaining as zero.
          clearDeviceFields(
            device,
            REMAINING_TIME_KEYS,
            OBSERVED_RUNTIME_KEYS,
            ESTIMATED_TOTAL_TIME_KEYS,
            ESTIMATED_DURATION_FLAG_KEYS
          );
          device.RemainingProgramTime = 0;
          delete device.ActiveProgramKey;
          delete device.ActiveProgramName;
          delete device.ActiveProgramSource;
          delete device.ActiveProgramPhase;
          delete device.ActiveProgramDetails;
        }
        break;
      }
      case "BSH.Common.Root.ActiveProgram": {
        // Home Connect clears this to null the moment a program ends. It is the
        // appliance stating outright that nothing is running, which outranks any
        // program data left over from the run that just ended.
        if (!extractValueByType(value, "string")) {
          demoteActiveProgramClaim(device);
        }
        break;
      }
      case "Cooking.Common.Setting.Lighting":
        device.Lighting = value;
        break;
      case "BSH.Common.Setting.PowerState":
        {
          // A value this does not understand must not wipe a known power state:
          // the appliance is telling us something, just not something we map.
          const powerStateLabel = getPowerStateLabel(value);
          if (powerStateLabel) {
            device.PowerState = powerStateLabel;
          }
        }
        break;
      case "BSH.Common.Status.DoorState":
        {
          device.DoorState = getDoorStateLabel(value);
        }
        break;
      default:
        // no-op for unhandled keys
        break;
    }

    applySpecializedEventState(device, event);
  }
}

module.exports = HomeConnect;
