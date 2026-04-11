let HomeConnect = null;
const fs = require("fs");
const util = require("util");
const ActiveProgramManager = require("./lib/active-program-manager");
const AuthService = require("./lib/auth-service");
const DeviceService = require("./lib/device-service");
const { refreshTokenPath } = require("./lib/module-paths");
const ProgramService = require("./lib/program-service");
const { deviceAppearsActive, isDeviceConnected } = require("./lib/device-utils");
/* eslint-disable n/no-missing-require */
const NodeHelper = require("node_helper"),
  globalSession = {
    accessToken: null, // Access token for API requests
    refreshToken: null, // Refresh token for obtaining new access tokens
    clientInstances: new Set(), // Set of client instance IDs using this helper
    lastAuthAttempt: 0, // Timestamp of the last authentication attempt
    MIN_AUTH_INTERVAL: 60000, // 1 minute between auth attempts
    rateLimitUntil: 0, // Timestamp until which rate limiting is active
    lastActiveProgramFetch: 0, // Timestamp of last active program fetch
    MIN_ACTIVE_PROGRAM_INTERVAL: 10 * 60 * 1000 // 10 minutes between fetches
  };

const ACTIVE_PROGRAM_RETRY_DELAY_MS = 5000; // 5s
const ACTIVE_PROGRAM_MAX_RETRIES = 3; // Maximum number of retries for active program requests

const SESSION_STATES = Object.freeze({
  BOOT: "boot",
  AUTHENTICATING: "authenticating",
  INITIALIZING: "initializing",
  READY: "ready",
  REFRESHING_DEVICES: "refreshing_devices",
  REFRESHING_PROGRAMS: "refreshing_programs",
  RATE_LIMITED: "rate_limited",
  ERROR: "error"
});

const SESSION_EVENTS = Object.freeze({
  CONFIG_RECEIVED: "CONFIG_RECEIVED",
  AUTH_START: "AUTH_START",
  HC_INIT_START: "HC_INIT_START",
  AUTH_SUCCESS: "AUTH_SUCCESS",
  AUTH_ERROR: "AUTH_ERROR",
  DEVICE_REFRESH_START: "DEVICE_REFRESH_START",
  DEVICE_REFRESH_DONE: "DEVICE_REFRESH_DONE",
  PROGRAM_FETCH_START: "PROGRAM_FETCH_START",
  PROGRAM_FETCH_DONE: "PROGRAM_FETCH_DONE",
  RATE_LIMIT_HIT: "RATE_LIMIT_HIT",
  RATE_LIMIT_CLEARED: "RATE_LIMIT_CLEARED",
  ERROR: "ERROR",
  RESET: "RESET"
});

const AUTHENTICATED_SESSION_STATES = new Set([
  SESSION_STATES.READY,
  SESSION_STATES.REFRESHING_DEVICES,
  SESSION_STATES.REFRESHING_PROGRAMS,
  SESSION_STATES.RATE_LIMITED
]);

const AUTH_FLOW_SESSION_STATES = new Set([
  SESSION_STATES.AUTHENTICATING,
  SESSION_STATES.INITIALIZING
]);

const ALL_SESSION_STATES = new Set(Object.values(SESSION_STATES));

const SESSION_TRANSITIONS = Object.freeze({
  [SESSION_EVENTS.CONFIG_RECEIVED]: {
    from: "*",
    resolve: ({ currentState, hasAuthenticatedSession }) => {
      if (currentState === SESSION_STATES.BOOT && hasAuthenticatedSession) {
        return SESSION_STATES.READY;
      }
      return currentState;
    }
  },
  [SESSION_EVENTS.AUTH_START]: {
    from: [SESSION_STATES.BOOT, SESSION_STATES.ERROR, SESSION_STATES.READY],
    to: SESSION_STATES.AUTHENTICATING
  },
  [SESSION_EVENTS.HC_INIT_START]: {
    from: [SESSION_STATES.BOOT, SESSION_STATES.AUTHENTICATING, SESSION_STATES.ERROR],
    to: SESSION_STATES.INITIALIZING
  },
  [SESSION_EVENTS.AUTH_SUCCESS]: {
    from: [SESSION_STATES.AUTHENTICATING, SESSION_STATES.INITIALIZING],
    to: SESSION_STATES.READY
  },
  [SESSION_EVENTS.AUTH_ERROR]: {
    from: [SESSION_STATES.AUTHENTICATING, SESSION_STATES.INITIALIZING],
    to: SESSION_STATES.ERROR
  },
  [SESSION_EVENTS.DEVICE_REFRESH_START]: {
    from: [SESSION_STATES.READY, SESSION_STATES.RATE_LIMITED, SESSION_STATES.REFRESHING_PROGRAMS],
    to: SESSION_STATES.REFRESHING_DEVICES
  },
  [SESSION_EVENTS.DEVICE_REFRESH_DONE]: {
    from: [SESSION_STATES.REFRESHING_DEVICES],
    resolve: ({ isRateLimited }) =>
      isRateLimited ? SESSION_STATES.RATE_LIMITED : SESSION_STATES.READY
  },
  [SESSION_EVENTS.PROGRAM_FETCH_START]: {
    from: [SESSION_STATES.READY, SESSION_STATES.RATE_LIMITED, SESSION_STATES.REFRESHING_DEVICES],
    to: SESSION_STATES.REFRESHING_PROGRAMS
  },
  [SESSION_EVENTS.PROGRAM_FETCH_DONE]: {
    from: [SESSION_STATES.REFRESHING_PROGRAMS],
    resolve: ({ isRateLimited }) =>
      isRateLimited ? SESSION_STATES.RATE_LIMITED : SESSION_STATES.READY
  },
  [SESSION_EVENTS.RATE_LIMIT_HIT]: {
    from: "*",
    to: SESSION_STATES.RATE_LIMITED
  },
  [SESSION_EVENTS.RATE_LIMIT_CLEARED]: {
    from: [SESSION_STATES.RATE_LIMITED],
    resolve: ({ isRateLimited }) =>
      isRateLimited ? SESSION_STATES.RATE_LIMITED : SESSION_STATES.READY
  },
  [SESSION_EVENTS.ERROR]: {
    from: [
      SESSION_STATES.BOOT,
      SESSION_STATES.AUTHENTICATING,
      SESSION_STATES.INITIALIZING,
      SESSION_STATES.READY,
      SESSION_STATES.REFRESHING_DEVICES,
      SESSION_STATES.REFRESHING_PROGRAMS,
      SESSION_STATES.RATE_LIMITED
    ],
    to: SESSION_STATES.ERROR
  },
  [SESSION_EVENTS.RESET]: {
    from: "*",
    to: SESSION_STATES.BOOT
  }
});

const INIT_STATUS_MESSAGES = Object.freeze({
  initializing: "Initialization started",
  session_active: "Session active - using existing authentication",
  auth_in_progress: "Authentication in progress",
  complete: "Already initialized",
  hc_not_ready: "HomeConnect not ready",
  token_found: "Token found - initializing HomeConnect",
  rate_limited: "Rate limit - please wait...",
  initializing_hc: "Initializing HomeConnect...",
  auth_failed: "Authentication failed - please check manually",
  success: "Successfully initialized",
  reauth_required: "Stored HomeConnect token invalid - re-authentication required",
  fetching_programs: "Fetching active programs..."
});

const AUTH_STATUS_MESSAGES = Object.freeze({
  success: "Authentication successful",
  error: "Authentication failed",
  token_invalid: "Token invalid - starting new authentication flow"
});

const { moduleLog, setModuleLogLevel } = require("./lib/logger");

module.exports = NodeHelper.create({
  refreshToken: null,
  hc: null,
  configReceived: false,
  initializationAttempts: 0,
  maxInitAttempts: 3,
  instanceId: null,
  activeProgramManager: null,
  authService: null,
  deviceService: null,
  programService: null,
  sessionState: SESSION_STATES.BOOT,
  sessionStateMeta: {
    updatedAt: 0,
    event: "init",
    reason: null
  },
  rateLimitReleaseTimer: null,
  debugStats: {
    lastApiCallTs: null,
    lastSseEventTs: null,
    apiCounters: {}
  },

  transitionSessionState(event, payload = {}) {
    const prevState = this.sessionState || SESSION_STATES.BOOT;
    const transition = SESSION_TRANSITIONS[event];

    if (!transition) {
      moduleLog("warn", "Unknown session event ignored", {
        event,
        state: prevState
      });
      return prevState;
    }

    const transitionFrom = transition.from;
    const allowedFromCurrent =
      transitionFrom === "*" ||
      (Array.isArray(transitionFrom) && transitionFrom.includes(prevState));

    if (!allowedFromCurrent) {
      moduleLog("warn", "Invalid session transition blocked", {
        event,
        from: prevState,
        allowedFrom: transitionFrom
      });
      return prevState;
    }

    const context = {
      currentState: prevState,
      isRateLimited: Date.now() < globalSession.rateLimitUntil,
      hasAuthenticatedSession:
        AUTHENTICATED_SESSION_STATES.has(prevState) ||
        Boolean(this.hc && globalSession.refreshToken)
    };
    const nextState =
      typeof transition.resolve === "function"
        ? transition.resolve(context, payload)
        : transition.to || prevState;

    if (!ALL_SESSION_STATES.has(nextState)) {
      moduleLog("warn", "Invalid target state ignored", {
        event,
        from: prevState,
        to: nextState
      });
      return prevState;
    }

    this.sessionStateMeta = {
      updatedAt: Date.now(),
      event,
      reason: payload.reason || null
    };

    if (nextState !== prevState) {
      this.sessionState = nextState;
      moduleLog("debug", `Session state transition: ${prevState} -> ${nextState}`, {
        event,
        reason: payload.reason || null
      });
      this.broadcastDebugStats();
    }

    return this.sessionState;
  },

  scheduleRateLimitRelease(untilTs) {
    if (this.rateLimitReleaseTimer) {
      clearTimeout(this.rateLimitReleaseTimer);
      this.rateLimitReleaseTimer = null;
    }

    const waitMs = Math.max(0, Number(untilTs || 0) - Date.now());
    if (waitMs <= 0) {
      this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_CLEARED, {
        reason: "rate_limit_elapsed"
      });
      return;
    }

    this.rateLimitReleaseTimer = setTimeout(() => {
      this.rateLimitReleaseTimer = null;
      if (Date.now() >= globalSession.rateLimitUntil) {
        this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_CLEARED, {
          reason: "rate_limit_elapsed"
        });
      }
    }, waitMs);
  },

  syncRateLimitState() {
    const now = Date.now();
    if (now >= globalSession.rateLimitUntil) {
      if (this.sessionState === SESSION_STATES.RATE_LIMITED) {
        this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_CLEARED, {
          reason: "rate_limit_elapsed"
        });
      }
      return false;
    }

    this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_HIT, {
      reason: "rate_limit_active"
    });
    this.scheduleRateLimitRelease(globalSession.rateLimitUntil);
    return true;
  },

  getRateLimitUntil() {
    return globalSession.rateLimitUntil || 0;
  },

  setRateLimitUntil(untilTs) {
    globalSession.rateLimitUntil = Math.max(0, Number(untilTs || 0));
    return globalSession.rateLimitUntil;
  },

  buildStatusPayload(messageMap, status, payload = {}) {
    const baseMessage = messageMap[status] || "";
    const message =
      typeof payload.message === "string" && payload.message.length ? payload.message : baseMessage;

    return {
      status,
      message,
      ...payload
    };
  },

  emitStatus(notification, messageMap, status, payload = {}, options = {}) {
    const { broadcast = true } = options;
    const builtPayload = this.buildStatusPayload(messageMap, status, payload);

    if (broadcast) {
      this.broadcastToAllClients(notification, builtPayload);
      return;
    }

    this.sendSocketNotification(notification, builtPayload);
  },

  buildInitStatusPayload(status, payload = {}) {
    return this.buildStatusPayload(INIT_STATUS_MESSAGES, status, payload);
  },

  emitInitStatus(status, payload = {}, options = {}) {
    this.emitStatus("INIT_STATUS", INIT_STATUS_MESSAGES, status, payload, options);
  },

  buildAuthStatusPayload(status, payload = {}) {
    return this.buildStatusPayload(AUTH_STATUS_MESSAGES, status, payload);
  },

  emitAuthStatus(status, payload = {}, options = {}) {
    this.emitStatus("AUTH_STATUS", AUTH_STATUS_MESSAGES, status, payload, options);
  },

  isSessionAuthenticated() {
    return AUTHENTICATED_SESSION_STATES.has(this.sessionState);
  },

  isAuthFlowInProgress() {
    return AUTH_FLOW_SESSION_STATES.has(this.sessionState);
  },

  beginDeviceRefresh(reason) {
    this.transitionSessionState(SESSION_EVENTS.DEVICE_REFRESH_START, { reason });
  },

  endDeviceRefresh(reason) {
    this.transitionSessionState(SESSION_EVENTS.DEVICE_REFRESH_DONE, { reason });
  },

  makeDeviceRefreshCallback(doneReason) {
    const sendSocketNotification = this.sendSocketNotification.bind(this);
    let refreshCompleted = false;
    return (notification, payload) => {
      sendSocketNotification(notification, payload);
      if (!refreshCompleted) {
        refreshCompleted = true;
        this.endDeviceRefresh(doneReason);
      }
    };
  },

  beginProgramFetch(reason) {
    this.transitionSessionState(SESSION_EVENTS.PROGRAM_FETCH_START, { reason });
  },

  endProgramFetch(reason) {
    this.transitionSessionState(SESSION_EVENTS.PROGRAM_FETCH_DONE, { reason });
  },

  init() {
    moduleLog("info", "init module helper: MMM-HomeConnect2 (session-based)");
    this.transitionSessionState(SESSION_EVENTS.CONFIG_RECEIVED, { reason: "helper_init" });

    this.authService = new AuthService({
      logger: moduleLog,
      broadcastToAllClients: this.broadcastToAllClients.bind(this),
      setModuleLogLevel,
      globalSession,
      maxInitAttempts: this.maxInitAttempts
    });

    this.deviceService = new DeviceService({
      logger: moduleLog,
      broadcastToAllClients: this.broadcastToAllClients.bind(this),
      globalSession,
      debugHooks: {
        recordApiCall: this.recordApiCall.bind(this),
        recordSseEvent: this.recordSseEvent.bind(this)
      }
    });

    try {
      this.activeProgramManager = new ActiveProgramManager({
        fetchFn: this.fetchActiveProgramForDevice.bind(this),
        broadcastFn: this.broadcastProgramData.bind(this),
        logger: moduleLog,
        maxRetries: ACTIVE_PROGRAM_MAX_RETRIES,
        retryDelayMs: ACTIVE_PROGRAM_RETRY_DELAY_MS
      });
      moduleLog("debug", "ActiveProgramManager initialized");
    } catch (err) {
      moduleLog("error", "Failed to initialize ActiveProgramManager:", err);
      this.activeProgramManager = null;
    }

    this.programService = new ProgramService({
      logger: moduleLog,
      globalSession,
      activeProgramManager: this.activeProgramManager,
      devices: this.deviceService.devices,
      debugHooks: {
        recordApiCall: this.recordApiCall.bind(this)
      },
      setRateLimitUntil: this.setRateLimitUntil.bind(this)
    });
  },

  start() {
    moduleLog("info", `Starting module helper: ${this.name}`);
  },

  stop() {
    moduleLog("info", `Stopping module helper: ${this.name}`);
    if (this.activeProgramManager && typeof this.activeProgramManager.clearAll === "function") {
      this.activeProgramManager.clearAll();
    }
    if (this.rateLimitReleaseTimer) {
      clearTimeout(this.rateLimitReleaseTimer);
      this.rateLimitReleaseTimer = null;
    }
    if (this.deviceService && typeof this.deviceService.shutdown === "function") {
      this.deviceService.shutdown();
    }
  },

  handleConfigNotificationFirstTime() {
    this.configReceived = true;

    if (this.isSessionAuthenticated()) {
      return this.handleSessionAlreadyActive();
    }

    if (this.isAuthFlowInProgress()) {
      return this.notifyAuthInProgress();
    }

    this.emitInitStatus(
      "initializing",
      {
        instanceId: this.instanceId
      },
      { broadcast: false }
    );

    this.checkTokenAndInitialize();
  },

  handleSessionAlreadyActive() {
    moduleLog("info", "Session already authenticated - using existing tokens");
    this.emitInitStatus(
      "session_active",
      {
        instanceId: this.instanceId
      },
      { broadcast: false }
    );

    if (this.hc && this.deviceService) {
      setTimeout(() => {
        this.deviceService.getDevices(this.sendSocketNotification.bind(this));
      }, 1000);
    }
  },

  notifyAuthInProgress() {
    moduleLog("info", "Authentication already in progress for another client instance");
    this.emitInitStatus(
      "auth_in_progress",
      {
        instanceId: this.instanceId
      },
      { broadcast: false }
    );
  },

  handleConfigNotificationSubsequent() {
    if (this.isSessionAuthenticated() && this.hc && this.deviceService) {
      this.emitInitStatus(
        "complete",
        {
          instanceId: this.instanceId
        },
        { broadcast: false }
      );

      setTimeout(() => {
        this.deviceService.broadcastDevices(this.sendSocketNotification.bind(this));
      }, 500);
    } else if (this.isAuthFlowInProgress()) {
      this.notifyAuthInProgress();
    }
  },

  handleConfigNotification(payload) {
    this.transitionSessionState(SESSION_EVENTS.CONFIG_RECEIVED, {
      reason: "config_notification"
    });

    this.instanceId = payload.instanceId || "default";
    globalSession.clientInstances.add(this.instanceId);

    moduleLog("debug", `Processing CONFIG notification for instance: ${this.instanceId}`);
    moduleLog("debug", `Registered clients: ${globalSession.clientInstances.size}`);

    // Wenn bereits Debug-Informationen gesammelt wurden, sofort einen Snapshot
    // an alle bekannten Clients senden, damit auch frisch geladene Instanzen
    // das Debug-Panel ohne weitere Events sehen.
    try {
      if (this.debugStats && (this.debugStats.lastApiCallTs || this.debugStats.lastSseEventTs)) {
        this.broadcastDebugStats();
      }
    } catch (e) {
      moduleLog("warn", "Failed to broadcast initial debug stats", e);
    }

    if (!this.configReceived) {
      this.config = payload;
      // Normalize legacy config keys (support both snake_case and camelCase)
      if (this.config && typeof this.config === "object") {
        if (!this.config.clientId && this.config.client_ID) {
          this.config.clientId = this.config.client_ID;
        }
        if (!this.config.clientSecret && this.config.client_Secret) {
          this.config.clientSecret = this.config.client_Secret;
        }
        if (!this.config.apiLanguage && this.config.api_language) {
          this.config.apiLanguage = this.config.api_language;
        }
      }
      // apply configured log level for module-level logging via auth service
      this.authService.setConfig(this.config);
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationFirstTime();
    } else {
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationSubsequent();
    }
  },

  handleStateRefreshRequest(payload = {}) {
    const requester = payload.instanceId || this.instanceId || "unknown";
    if (!this.deviceService) {
      moduleLog("warn", "State refresh requested but DeviceService unavailable", {
        requester
      });
      return;
    }

    const forceRefresh = Boolean(payload.forceRefresh);
    const bypassActiveProgramThrottle = Boolean(payload.bypassActiveProgramThrottle);
    const haIds = Array.isArray(payload.haIds) ? payload.haIds : null;
    const hasDevices = this.deviceService.devices && this.deviceService.devices.size > 0;
    const sseHealthy =
      this.deviceService.subscribed && !this.deviceService.heartbeatStale && hasDevices;
    const shouldFetchDevices = forceRefresh || !sseHealthy;

    if (shouldFetchDevices && this.hc && !this.isAuthFlowInProgress()) {
      this.beginDeviceRefresh("state_refresh_poll");
      moduleLog("info", "State refresh requires polling Home Connect", {
        requester,
        forceRefresh,
        sseHealthy
      });
      this.deviceService.getDevices(this.makeDeviceRefreshCallback("state_refresh_dispatched"));
    } else if (hasDevices) {
      moduleLog("debug", "State refresh served from cache (SSE data)", {
        requester,
        forceRefresh,
        sseHealthy
      });
      this.deviceService.broadcastDevices(this.sendSocketNotification.bind(this));
    } else {
      moduleLog("warn", "State refresh unable to respond - no device data available", {
        requester
      });
      this.transitionSessionState(SESSION_EVENTS.ERROR, {
        reason: "state_refresh_no_devices"
      });
    }

    this.handleGetActivePrograms({
      instanceId: requester,
      haIds,
      force: bypassActiveProgramThrottle
    });
  },

  handleRetryAuth() {
    moduleLog("info", "Manual retry requested");
    this.retryAuthentication();
  },

  handleGetActivePrograms(payload = {}) {
    const requester = payload.instanceId || null;
    const haIds = Array.isArray(payload.haIds) ? payload.haIds : null;
    const force = Boolean(payload.force);

    const requesterLabel = requester || "unknown";

    moduleLog("info", "📊 GET_ACTIVE_PROGRAMS request received", requesterLabel);

    if (!this.hc) {
      moduleLog("warn", "HomeConnect not initialized - cannot fetch active programs");
      this.emitInitStatus("hc_not_ready", {
        instanceId: requester
      });
      return;
    }

    const now = Date.now();

    const rateLimitActive = this.syncRateLimitState();
    if (!force && rateLimitActive) {
      const remainingSeconds = Math.ceil((globalSession.rateLimitUntil - now) / 1000);
      moduleLog("info", `Rate limited - ${remainingSeconds}s remaining`);
      this.emitInitStatus("device_error", {
        message: `Rate limit active - please wait ${remainingSeconds}s`,
        rateLimitSeconds: remainingSeconds,
        statusCode: 429,
        isRateLimit: true,
        instanceId: requester
      });
      return;
    }

    const sinceLastFetch = now - globalSession.lastActiveProgramFetch;
    if (
      !force &&
      globalSession.MIN_ACTIVE_PROGRAM_INTERVAL > 0 &&
      sinceLastFetch < globalSession.MIN_ACTIVE_PROGRAM_INTERVAL
    ) {
      const waitMs = globalSession.MIN_ACTIVE_PROGRAM_INTERVAL - sinceLastFetch;
      moduleLog("debug", `Throttling GET_ACTIVE_PROGRAMS for ${requesterLabel} - wait ${waitMs}ms`);
      return;
    }

    const deviceArray =
      this.deviceService && this.deviceService.devices
        ? Array.from(this.deviceService.devices.values())
        : [];
    const targetDevices =
      haIds && haIds.length
        ? deviceArray.filter((device) => haIds.includes(device.haId))
        : deviceArray;

    if (targetDevices.length === 0) {
      moduleLog("debug", "No devices matched active program request", {
        requester: requesterLabel,
        requestedHaIds: haIds
      });
      return;
    }

    moduleLog("debug", "Active program request accepted", {
      requester: requesterLabel,
      deviceCount: targetDevices.length,
      force
    });

    this.beginProgramFetch("active_program_request");
    globalSession.lastActiveProgramFetch = now;
    this.fetchActiveProgramsForDevices(targetDevices, requester);
  },

  socketNotificationReceived(notification, payload) {
    const safePayload = payload || {};

    switch (notification) {
      case "CONFIG":
        this.handleConfigNotification(safePayload);
        break;

      case "REQUEST_DEVICE_REFRESH":
        this.handleStateRefreshRequest(safePayload);
        break;

      case "RETRY_AUTH":
        this.handleRetryAuth();
        break;

      case "GET_ACTIVE_PROGRAMS":
        this.handleGetActivePrograms(safePayload);
        break;

      default:
        break;
    }
  },

  broadcastToAllClients(notification, payload) {
    globalSession.clientInstances.forEach((instanceId) => {
      this.sendSocketNotification(notification, {
        ...payload,
        instanceId
      });
    });
  },

  broadcastDebugStats() {
    this.broadcastToAllClients("DEBUG_STATS", {
      lastApiCallTs: this.debugStats.lastApiCallTs,
      lastSseEventTs: this.debugStats.lastSseEventTs,
      apiCounters: { ...this.debugStats.apiCounters },
      session: {
        state: this.sessionState,
        event: this.sessionStateMeta.event,
        updatedAt: this.sessionStateMeta.updatedAt,
        reason: this.sessionStateMeta.reason,
        rateLimitUntil: this.getRateLimitUntil(),
        rateLimitRemainingMs: Math.max(0, this.getRateLimitUntil() - Date.now())
      }
    });
  },

  recordApiCall(apiName) {
    if (!apiName) return;
    const now = Date.now();
    this.debugStats.lastApiCallTs = now;
    const counters = this.debugStats.apiCounters || {};
    counters[apiName] = (counters[apiName] || 0) + 1;
    this.debugStats.apiCounters = counters;
    this.broadcastDebugStats();
  },

  recordSseEvent() {
    this.debugStats.lastSseEventTs = Date.now();
    this.broadcastDebugStats();
  },

  readRefreshTokenFromFile() {
    return this.authService.readRefreshTokenFromFile();
  },

  checkRateLimit() {
    const now = Date.now();
    if (now - globalSession.lastAuthAttempt < globalSession.MIN_AUTH_INTERVAL) {
      globalSession.rateLimitUntil =
        globalSession.lastAuthAttempt + globalSession.MIN_AUTH_INTERVAL;
      this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_HIT, {
        reason: "auth_interval_rate_limit"
      });
      moduleLog("warn", "Rate limit: waiting before next auth attempt");
      this.emitInitStatus("rate_limited");
      this.scheduleRateLimitRelease(globalSession.rateLimitUntil);
      return false;
    }
    globalSession.rateLimitUntil = 0;
    return true;
  },

  initiateAuthFlow() {
    this.authService.initiateAuthFlow();
    if (!globalSession.refreshToken) {
      this.initWithHeadlessAuth();
    }
  },

  checkTokenAndInitialize() {
    const token = this.readRefreshTokenFromFile();

    if (token) {
      moduleLog("info", "Using saved refresh token - initializing HomeConnect");
      globalSession.refreshToken = token;
      this.refreshToken = token;

      this.emitInitStatus("token_found");

      this.initializeHomeConnect(token);
      return;
    }

    if (!this.checkRateLimit()) {
      return;
    }

    this.initiateAuthFlow();
  },

  handleHeadlessAuthSuccess(tokens) {
    fs.writeFileSync(refreshTokenPath, tokens.refresh_token);
    moduleLog("info", "Refresh token saved successfully");

    globalSession.refreshToken = tokens.refresh_token;
    globalSession.accessToken = tokens.access_token;

    this.emitInitStatus("initializing_hc");

    return this.initializeHomeConnect(tokens.refresh_token);
  },

  handleHeadlessAuthError(error) {
    this.transitionSessionState(SESSION_EVENTS.AUTH_ERROR, {
      reason: error && error.message ? error.message : "headless_auth_error"
    });
    moduleLog("error", "Headless authentication failed:", error.message);

    this.emitAuthStatus("error", {
      message: `Authentication failed: ${error.message}`
    });

    if (error.message.includes("polling too quickly")) {
      moduleLog("info", "Rate limiting detected - will not retry automatically");
      this.emitInitStatus("rate_limited", {
        message: "Rate limit reached - please restart in 2 minutes"
      });
      return;
    }

    if (this.initializationAttempts < this.maxInitAttempts) {
      moduleLog(
        "info",
        `Retrying headless authentication in 30 seconds (${this.initializationAttempts}/${this.maxInitAttempts})`
      );
      setTimeout(() => {
        if (!this.hc) {
          this.initWithHeadlessAuth();
        }
      }, 30 * 1000);
      return;
    }

    moduleLog("error", "Max initialization attempts reached - aborting headless authentication");
    this.emitInitStatus("auth_failed");
  },

  async initWithHeadlessAuth() {
    if (this.isAuthFlowInProgress()) {
      moduleLog("warn", "Authentication already in progress, skipping...");
      return;
    }

    this.transitionSessionState(SESSION_EVENTS.AUTH_START, {
      reason: "headless_auth"
    });
    this.initializationAttempts++;

    moduleLog(
      "info",
      `Starting headless authentication (attempt ${this.initializationAttempts}/${this.maxInitAttempts})`
    );

    try {
      const tokens = await this.authService.headlessAuth((notification, payload) => {
        if (notification === "AUTH_STATUS") {
          const status = payload && payload.status ? payload.status : "error";
          this.emitAuthStatus(status, payload || {});
          return;
        }

        this.broadcastToAllClients(notification, payload);
      });

      await this.handleHeadlessAuthSuccess(tokens);
    } catch (error) {
      this.handleHeadlessAuthError(error);
    }
  },

  handleHomeConnectInitSuccess() {
    moduleLog("info", "HomeConnect initialized successfully");

    this.transitionSessionState(SESSION_EVENTS.AUTH_SUCCESS, {
      reason: "homeconnect_initialized"
    });

    this.emitInitStatus("success");

    if (this.deviceService) {
      // Perform a single initial device fetch; further updates are normally
      // driven by SSE, with fallback polling only when SSE is unhealthy.
      setTimeout(() => {
        this.beginDeviceRefresh("initial_device_fetch");
        this.deviceService.getDevices(
          this.makeDeviceRefreshCallback("initial_device_fetch_dispatched")
        );
      }, 2000);
    }
  },

  handleHomeConnectInitError(error) {
    moduleLog("error", "HomeConnect initialization failed:", error);
    this.transitionSessionState(SESSION_EVENTS.AUTH_ERROR, {
      reason: error && error.message ? error.message : "homeconnect_init_error"
    });

    const errorMessage = error && error.message ? error.message : String(error || "");
    const normalizedMsg = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
    const invalidGrantDetected = normalizedMsg.includes("invalid_grant");

    if (invalidGrantDetected) {
      moduleLog(
        "warn",
        "Detected invalid_grant response while initializing HomeConnect - triggering re-authentication"
      );

      this.emitInitStatus("reauth_required");

      this.emitAuthStatus("token_invalid");

      try {
        if (fs.existsSync(refreshTokenPath)) {
          fs.unlinkSync(refreshTokenPath);
          moduleLog("info", "Removed cached refresh_token.json after invalid_grant");
        }
      } catch (fsErr) {
        moduleLog("warn", "Failed to delete cached refresh token file:", fsErr);
      }

      globalSession.refreshToken = null;
      globalSession.accessToken = null;
      this.refreshToken = null;
      this.hc = null;

      // Reset attempts so a fresh authentication cycle can proceed without hitting attempt limits.
      this.initializationAttempts = 0;
      globalSession.lastAuthAttempt = 0;
      this.setRateLimitUntil(0);
      this.transitionSessionState(SESSION_EVENTS.RESET, {
        reason: "invalid_grant"
      });

      // Start a fresh headless authentication flow (shows QR code on clients)
      setTimeout(() => {
        if (!this.isAuthFlowInProgress()) {
          this.initWithHeadlessAuth();
        }
      }, 1500);

      return;
    }

    this.emitInitStatus("hc_error", {
      message: `HomeConnect error: ${error.message}`
    });
  },

  setupHomeConnectRefreshToken() {
    this.hc.on("newRefreshToken", (refreshToken) => {
      fs.writeFileSync(refreshTokenPath, refreshToken);
      moduleLog("info", "Refresh token updated");
      globalSession.refreshToken = refreshToken;
      // After init has completed (subscriptions established), refresh devices on token update.
      // During initial init (subscribed === false), skip to avoid double fetching.
      if (this.deviceService && this.deviceService.subscribed) {
        moduleLog("info", "Token updated post-init - refreshing device list");
        this.beginDeviceRefresh("token_refresh_device_sync");
        this.deviceService.getDevices(this.sendSocketNotification.bind(this));
        this.endDeviceRefresh("token_refresh_device_sync_dispatched");
      } else {
        moduleLog("info", "Token updated during initialization");
      }
    });
  },

  async initializeHomeConnect(refreshToken) {
    return new Promise((resolve, reject) => {
      moduleLog("info", "Initializing HomeConnect with token...");
      this.transitionSessionState(SESSION_EVENTS.HC_INIT_START, {
        reason: "initialize_homeconnect"
      });
      if (!HomeConnect) {
        HomeConnect = require("./lib/homeconnect-api.js");
      }
      this.hc = new HomeConnect(this.config.clientId, this.config.clientSecret, refreshToken, {
        acceptLanguage: this.config.apiLanguage
      });

      // attach client to services
      if (this.deviceService) {
        this.deviceService.attachClient(this.hc);
      }
      if (this.programService) {
        this.programService.attachClient(this.hc);
      }

      const initTimeout = setTimeout(() => {
        moduleLog("error", "HomeConnect initialization timeout");
        this.transitionSessionState(SESSION_EVENTS.AUTH_ERROR, {
          reason: "homeconnect_init_timeout"
        });
        reject(new Error("HomeConnect initialization timeout"));
      }, 30000);

      this.hc
        .init({
          isSimulated: false
        })
        .then(() => {
          clearTimeout(initTimeout);
          this.handleHomeConnectInitSuccess();
          resolve();
        })
        .catch((error) => {
          clearTimeout(initTimeout);
          this.handleHomeConnectInitError(error);
          reject(error);
        });

      this.setupHomeConnectRefreshToken();
    });
  },

  retryAuthentication() {
    moduleLog("info", "Manual authentication retry");
    this.transitionSessionState(SESSION_EVENTS.RESET, {
      reason: "manual_retry_auth"
    });
    globalSession.accessToken = null;
    globalSession.refreshToken = null;
    globalSession.clientInstances.clear();

    this.configReceived = false;
    this.initializationAttempts = 0;
    this.hc = null;
    if (this.deviceService) {
      this.deviceService.devices.clear();
      if (typeof this.deviceService.shutdown === "function") {
        this.deviceService.shutdown();
      }
    }
    if (this.activeProgramManager && typeof this.activeProgramManager.clearAll === "function") {
      this.activeProgramManager.clearAll();
    }

    if (fs.existsSync(refreshTokenPath)) {
      fs.unlinkSync(refreshTokenPath);
      moduleLog("info", "Old token file deleted");
    }

    this.refreshToken = null;

    this.checkTokenAndInitialize();
  },

  broadcastDevices() {
    if (!this.deviceService) return;
    this.deviceService.broadcastDevices(this.sendSocketNotification.bind(this));
  },

  async fetchActiveProgramForDevice(haId, deviceName) {
    if (!this.programService)
      return { haId, success: false, error: "ProgramService not available" };
    return this.programService.fetchActiveProgramForDevice(haId, deviceName);
  },

  async fetchActiveProgramsForDevices(deviceArray, requestingInstanceId) {
    if (!this.deviceService) {
      moduleLog("debug", "DeviceService not available - cannot fetch programs");
      return;
    }

    if (!Array.isArray(deviceArray) || deviceArray.length === 0) {
      moduleLog("debug", "No target devices provided for fetching active programs");
      return;
    }

    moduleLog("info", `Fetching active programs for ${deviceArray.length} device(s)`);

    this.emitInitStatus("fetching_programs", {
      instanceId: requestingInstanceId
    });

    try {
      const results = [];
      const retryCandidates = [];

      // Fetch sequentially to avoid overwhelming the API
      for (const device of deviceArray) {
        // Fallback: if device is not connected according to the API but appears
        // active (e.g. reports RemainingProgramTime/ProgramProgress/OperationState),
        // still attempt to fetch the active program. This mirrors the iOS app
        // behavior where program state can take a short while to reflect in
        // the /homeappliances list connected flag.
        const connected = isDeviceConnected(device);
        const appearsActive = deviceAppearsActive(device);
        if (connected || appearsActive) {
          if (!connected && appearsActive) {
            moduleLog(
              "info",
              `Device ${device.name} not marked connected but appears active - using fallback to fetch program`,
              { rawConnected: device.connected }
            );
          }
          moduleLog(
            "debug",
            `Requesting active program ${results.length + 1}/${deviceArray.length} for ${device.name}`
          );
          const result = await this.fetchActiveProgramForDevice(device.haId, device.name);
          moduleLog("debug", `Active program response for ${device.name}:`, {
            success: result.success,
            hasData: !!(result.data && Object.keys(result.data).length),
            error: result.error || null
          });
          if (result && result.data) {
            moduleLog(
              "debug",
              `Active program raw payload for ${device.name} (${result.source || "unknown"}):\n${util.inspect(
                result.data,
                {
                  depth: null,
                  colors: false,
                  compact: false,
                  breakLength: 120,
                  maxArrayLength: null,
                  maxStringLength: null
                }
              )}`
            );
          }
          results.push(result);

          // Small delay between requests to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          moduleLog("debug", `Skipping ${device.name} - not connected`, {
            rawConnected: device.connected
          });
        }
      }

      // Process successful results
      const programData = {};
      results.forEach((result) => {
        if (result.success && result.data) {
          const payload = this.programService
            ? this.programService.applyProgramResult(result)
            : null;
          if (payload) {
            programData[result.haId] = payload;
            if (
              this.activeProgramManager &&
              typeof this.activeProgramManager.clear === "function"
            ) {
              this.activeProgramManager.clear(result.haId);
            } else {
              moduleLog(
                "warn",
                `ActiveProgramManager missing - cannot clear retry for ${result.haId}`
              );
            }
          }
        } else if (result.error === "No active program") {
          const device = this.deviceService.devices.get(result.haId);
          if (device) {
            const appearsActive = deviceAppearsActive(device);
            moduleLog(
              "debug",
              `Device ${device.name} reported no active program (appearsActive=${appearsActive})`
            );
            if (appearsActive) {
              retryCandidates.push(device);
            }
          }
        }
      });

      this.broadcastProgramData(programData, requestingInstanceId);

      if (retryCandidates.length) {
        moduleLog(
          "info",
          `Scheduling retries for ${retryCandidates.length} device(s) awaiting active program data`
        );
        if (this.activeProgramManager && typeof this.activeProgramManager.schedule === "function") {
          this.activeProgramManager.schedule(retryCandidates, requestingInstanceId);
        } else {
          moduleLog("error", "ActiveProgramManager not available - cannot schedule retries");
        }
      } else {
        moduleLog("debug", "No retry candidates detected for active programs");
      }
    } catch (error) {
      this.handleActiveProgramFetchError(error);
    } finally {
      this.endProgramFetch("active_program_cycle_finished");
    }
  },

  handleActiveProgramFetchError(error) {
    if (!this.programService) return;
    this.programService.handleActiveProgramFetchError(error, this.broadcastToAllClients.bind(this));
    if (globalSession.rateLimitUntil > Date.now()) {
      this.transitionSessionState(SESSION_EVENTS.RATE_LIMIT_HIT, {
        reason: "active_program_429"
      });
      this.scheduleRateLimitRelease(globalSession.rateLimitUntil);
    } else {
      this.transitionSessionState(SESSION_EVENTS.ERROR, {
        reason: error && error.message ? error.message : "active_program_error"
      });
    }
  },

  applyProgramResult(result) {
    if (!this.programService) return null;
    return this.programService.applyProgramResult(result);
  },

  broadcastProgramData(programData, requestingInstanceId) {
    if (!this.programService) return;
    this.programService.broadcastProgramData(
      programData,
      requestingInstanceId,
      this.broadcastDevices.bind(this),
      this.broadcastToAllClients.bind(this)
    );
  },

  updateActiveProgramInterval() {
    const minInterval =
      this.config && typeof this.config.minActiveProgramIntervalMs === "number"
        ? Math.max(0, this.config.minActiveProgramIntervalMs)
        : 10 * 60 * 1000;
    globalSession.MIN_ACTIVE_PROGRAM_INTERVAL = minInterval;
  }
});
