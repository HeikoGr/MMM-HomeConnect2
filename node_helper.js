let HomeConnect = null;
const fs = require("fs");
const util = require("util");
const ActiveProgramManager = require("./lib/active-program-manager");
const AuthService = require("./lib/auth-service");
const DeviceService = require("./lib/device-service");
const { refreshTokenPath } = require("./lib/module-paths");
const ProgramService = require("./lib/program-service");
const { deviceAppearsActive, isDeviceConnected } = require("./lib/device-utils");
const shared = require("./lib/mmm-shared/mmm-shared");
const NodeHelper = require("node_helper"),
  globalSession = {
    accessToken: null, // Access token for API requests
    refreshToken: null, // Refresh token for obtaining new access tokens
    clientInstances: new Set(), // Set of client instance IDs using this helper
    clientInstanceLastSeen: new Map(), // instanceId -> timestamp of last CONFIGURE, for stale-entry pruning
    lastAuthAttempt: 0, // Timestamp of the last authentication attempt
    MIN_AUTH_INTERVAL: 60000, // 1 minute between auth attempts
    rateLimitUntil: 0, // Timestamp until which rate limiting is active
    lastActiveProgramFetch: 0, // Timestamp of last active program fetch
    MIN_ACTIVE_PROGRAM_INTERVAL: 10 * 60 * 1000 // 10 minutes between fetches
  };

const ACTIVE_PROGRAM_RETRY_DELAY_MS = 5000; // 5s
const ACTIVE_PROGRAM_MAX_RETRIES = 3; // Maximum number of retries for active program requests
const FORCED_ACTIVE_PROGRAM_DEDUP_WINDOW_MS = 15000;
const FULL_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
// clientInstances has no disconnect hook (MagicMirror's node_helper API doesn't
// expose one), so entries only ever accumulate as browsers reload/change. Prune
// any instance that hasn't sent a CONFIGURE in this long during the periodic
// snapshot tick, to bound growth over months of uptime.
const STALE_CLIENT_INSTANCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Transient init errors (e.g. network/DNS not ready yet right after a device reboot)
// must not strand the session forever - retry with capped exponential backoff.
const HC_INIT_RETRY_BASE_DELAY_MS = 5000; // 5s
const HC_INIT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000; // 5min cap
// Debug stats reach every client as a broadcast, and every client re-renders on
// arrival. A busy SSE stream would otherwise mean a full re-render per event, so
// the panel settles for being at most this stale.
const DEBUG_STATS_BROADCAST_INTERVAL_MS = 5000;
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

// Config keys that shape the shared HomeConnect session. All displays are served
// by one API session and one SSE stream, so these settings can only exist once.
// Everything else (showDeviceIcon, showDeviceIf*, header, progressRefreshIntervalMs,
// ...) is evaluated in the browser and may legitimately differ per display.
const SESSION_CONFIG_KEYS = Object.freeze([
  "apiLanguage",
  "apiRequestTimeoutMs",
  "clientId",
  "clientSecret",
  "enableSSEHeartbeat",
  "logLevel",
  "minActiveProgramIntervalMs",
  "ssePreSubscribeRefreshMs",
  "sseRecoveryCooldownMs",
  "sseHeartbeatCheckIntervalMs",
  "sseHeartbeatStaleThresholdMs"
]);

// Different credentials mean a different HomeConnect account - the shared session
// cannot serve such a client at all, so it is turned away. Every other difference
// is harmless enough to just log: the session settings simply keep precedence.
const CRITICAL_CONFIG_KEYS = Object.freeze(["clientId", "clientSecret"]);

// The API language is baked into the shared device data (Accept-Language), so it
// can only be resolved once - by the client that opens the session. An explicitly
// configured value always wins over the browser-derived hint.
function resolveSessionLanguage(config = {}) {
  const configured = typeof config.apiLanguage === "string" ? config.apiLanguage.trim() : "";
  if (configured) {
    return configured;
  }

  const preferred =
    typeof config.preferredApiLanguage === "string" ? config.preferredApiLanguage.trim() : "";
  return preferred;
}

// Writing/deleting refresh_token.json happens both inside event-emitter callbacks
// and socket-notification handlers with no enclosing try/catch of their own - an
// unguarded EACCES/ENOSPC/EROFS here would throw synchronously and crash the whole
// Node process hosting every MagicMirror module, not just this one.
function persistRefreshToken(token) {
  try {
    // Owner-only permissions: this file holds a long-lived OAuth refresh token,
    // equivalent to a credential for the user's Home Connect account. The mode
    // option only applies when the file is newly created, so chmod explicitly
    // in case a previous run left it with looser (e.g. default 0o666) permissions.
    fs.writeFileSync(refreshTokenPath, token, { mode: 0o600 });
    fs.chmodSync(refreshTokenPath, 0o600);
    moduleLog("info", "Refresh token saved successfully");
    return true;
  } catch (err) {
    moduleLog("error", "Failed to persist refresh token to disk:", err);
    return false;
  }
}

function deleteRefreshTokenFile() {
  try {
    if (fs.existsSync(refreshTokenPath)) {
      fs.unlinkSync(refreshTokenPath);
      moduleLog("info", "Cached refresh token file deleted");
      return true;
    }
  } catch (err) {
    moduleLog("warn", "Failed to delete cached refresh token file:", err);
  }
  return false;
}

module.exports = NodeHelper.create({
  refreshToken: null,
  hc: null,
  configReceived: false,
  initializationAttempts: 0,
  maxInitAttempts: 3,
  instanceId: null,
  sharedConfigOwnerInstanceId: null,
  activeProgramManager: null,
  authService: null,
  deviceService: null,
  programService: null,
  // Session lifecycle as plain flags: `sessionAuthenticated` means the HomeConnect
  // client is up and usable, `authFlowInProgress` keeps a second auth/init from
  // starting while one is running, and the two *InFlight flags keep the scheduled
  // snapshot from piling onto a refresh that is already underway. Rate limiting is
  // derived from globalSession.rateLimitUntil, never mirrored into a separate state.
  sessionAuthenticated: false,
  authFlowInProgress: false,
  deviceRefreshInFlight: false,
  programFetchInFlight: false,
  fullSnapshotTimer: null,
  hcInitRetryTimer: null,
  hcInitRetryAttempts: 0,
  headlessAuthRetryTimer: null,
  invalidGrantRetryTimer: null,
  sessionOwnerConfig: null,
  activeProgramFetchInFlight: false,
  activeProgramFetchSignature: null,
  // Devices whose "active program" request was dropped only because it
  // collided with another fetch already in flight - not a real failure, so
  // they're picked up again as soon as that fetch finishes instead of waiting
  // for another SSE delta to re-trigger them (see handleGetActivePrograms).
  pendingActiveProgramHaIds: new Set(),
  recentForcedProgramFetch: null,
  debugStats: {
    lastApiCallTs: null,
    lastSseEventTs: null,
    lastSseTrafficTs: null,
    apiCounters: {}
  },
  lastDebugStatsBroadcastTs: 0,

  isRateLimited() {
    return Date.now() < this.getRateLimitUntil();
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
    const { broadcast = true, targetInstanceId = null } = options;
    const builtPayload = this.buildStatusPayload(messageMap, status, payload);

    if (broadcast) {
      this.broadcastToAllClients(notification, builtPayload);
      return;
    }

    this.sendEventToInstance(
      targetInstanceId || builtPayload.instanceId || this.instanceId || "default",
      notification,
      builtPayload
    );
  },

  sendEventToInstance(instanceId, action, data) {
    this.sendSocketNotification(
      this.notifications.EVENT,
      shared.createEnvelope({
        identifier: instanceId || "default",
        instanceId: instanceId || "default",
        action,
        ok: true,
        data,
        error: null,
        meta: {}
      })
    );
  },

  emitInitStatus(status, payload = {}, options = {}) {
    this.emitStatus("INIT_STATUS", INIT_STATUS_MESSAGES, status, payload, options);
  },

  emitAuthStatus(status, payload = {}, options = {}) {
    this.emitStatus("AUTH_STATUS", AUTH_STATUS_MESSAGES, status, payload, options);
  },

  isSessionAuthenticated() {
    return this.sessionAuthenticated;
  },

  isAuthFlowInProgress() {
    return this.authFlowInProgress;
  },

  makeDeviceRefreshCallback() {
    const broadcast = this.broadcastToAllClients.bind(this);
    let refreshCompleted = false;
    return (notification, payload) => {
      broadcast(notification, payload);
      if (!refreshCompleted) {
        refreshCompleted = true;
        this.deviceRefreshInFlight = false;
      }
    };
  },

  dispatchDeviceRefreshWithProgramSync({
    reason,
    requester,
    forcePrograms = false,
    haIds = null
  } = {}) {
    if (!this.deviceService || !this.hc || this.isAuthFlowInProgress()) {
      return false;
    }

    moduleLog("debug", "Dispatching device refresh", { reason: reason || "device_refresh" });
    this.deviceRefreshInFlight = true;
    const sendSocketNotification = this.makeDeviceRefreshCallback();
    let followUpRequested = false;

    this.deviceService.getDevices((notification, callbackPayload) => {
      sendSocketNotification(notification, callbackPayload);

      if (followUpRequested || notification !== "DEVICES_UPDATE") {
        return;
      }

      followUpRequested = true;
      this.handleGetActivePrograms({
        instanceId: requester || this.instanceId || "unknown",
        haIds,
        force: forcePrograms
      });
    });

    return true;
  },

  buildActiveProgramFetchScopeKey(devices) {
    const deviceIds = Array.isArray(devices)
      ? devices
        .map((device) => device && device.haId)
        .filter((haId) => typeof haId === "string" && haId.length)
        .sort()
      : [];

    return deviceIds.join(",") || "all";
  },

  buildActiveProgramFetchSignature(devices, requester) {
    return `${requester || "unknown"}:${this.buildActiveProgramFetchScopeKey(devices)}`;
  },

  hasRecentForcedProgramFetch(scopeKey, now = Date.now()) {
    const recentFetch = this.recentForcedProgramFetch;
    if (!recentFetch || recentFetch.scopeKey !== scopeKey) {
      return false;
    }

    return now - recentFetch.completedAt < FORCED_ACTIVE_PROGRAM_DEDUP_WINDOW_MS;
  },

  rememberForcedProgramFetch(scopeKey, completedAt = Date.now()) {
    this.recentForcedProgramFetch = {
      scopeKey,
      completedAt
    };
  },

  // Warn about session settings a late client asked for but will not get. Purely
  // diagnostic: the display stays connected and keeps its own rendering options.
  warnAboutIgnoredSessionConfig(instanceId, clientSessionConfig) {
    const ignored = SESSION_CONFIG_KEYS.filter(
      (key) => (this.sessionOwnerConfig[key] ?? null) !== (clientSessionConfig[key] ?? null)
    );

    if (ignored.length === 0) {
      return;
    }

    moduleLog(
      "warn",
      "Client config differs from the running session - session settings keep precedence",
      { instanceId, keys: ignored, owner: this.sharedConfigOwnerInstanceId }
    );
  },

  rejectConfigMismatch(instanceId, mismatchKeys = []) {
    moduleLog("warn", "Rejecting client instance: credentials differ from the running session", {
      instanceId,
      mismatchKeys
    });

    globalSession.clientInstances.delete(instanceId);
    globalSession.clientInstanceLastSeen.delete(instanceId);

    this.emitInitStatus(
      "device_error",
      {
        instanceId,
        isConfigMismatch: true,
        mismatchKeys: [...mismatchKeys]
      },
      { broadcast: false, targetInstanceId: instanceId }
    );
  },

  shouldRetryNoActiveProgram(device) {
    return deviceAppearsActive(device);
  },

  init() {
    moduleLog("info", "init module helper: MMM-HomeConnect2 (session-based)");
    this.notifications = shared.buildNotifications("MMM-HomeConnect2");

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
      onSseStale: this.handleSseStale.bind(this),
      onActiveProgramNeeded: this.handleActiveProgramNeededFromSse.bind(this),
      debugHooks: {
        recordApiCall: this.recordApiCall.bind(this),
        recordSseEvent: this.recordSseEvent.bind(this),
        recordSseKeepAlive: this.recordSseKeepAlive.bind(this)
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

  pruneStaleClientInstances() {
    const now = Date.now();
    globalSession.clientInstances.forEach((instanceId) => {
      const lastSeen = globalSession.clientInstanceLastSeen.get(instanceId) || 0;
      if (now - lastSeen > STALE_CLIENT_INSTANCE_TTL_MS) {
        globalSession.clientInstances.delete(instanceId);
        globalSession.clientInstanceLastSeen.delete(instanceId);
        moduleLog("debug", `Pruned stale client instance (no CONFIGURE in 24h): ${instanceId}`);
      }
    });
  },

  schedulePeriodicFullSnapshotRefresh() {
    if (this.fullSnapshotTimer) {
      return;
    }

    this.fullSnapshotTimer = setInterval(() => {
      this.pruneStaleClientInstances();

      if (!this.hc || !this.deviceService || this.isAuthFlowInProgress()) {
        return;
      }

      if (
        !this.sessionAuthenticated ||
        this.deviceRefreshInFlight ||
        this.programFetchInFlight
      ) {
        return;
      }

      moduleLog("debug", "Running scheduled full device snapshot refresh");
      this.dispatchDeviceRefreshWithProgramSync({
        reason: "scheduled_full_snapshot",
        requester: "scheduled_snapshot",
        forcePrograms: true
      });
    }, FULL_SNAPSHOT_INTERVAL_MS);
  },

  clearPeriodicFullSnapshotRefresh() {
    if (this.fullSnapshotTimer) {
      clearInterval(this.fullSnapshotTimer);
      this.fullSnapshotTimer = null;
    }
  },

  stop() {
    moduleLog("info", `Stopping module helper: ${this.name}`);
    if (this.activeProgramManager && typeof this.activeProgramManager.clearAll === "function") {
      this.activeProgramManager.clearAll();
    }
    if (this.headlessAuthRetryTimer) {
      clearTimeout(this.headlessAuthRetryTimer);
      this.headlessAuthRetryTimer = null;
    }
    if (this.invalidGrantRetryTimer) {
      clearTimeout(this.invalidGrantRetryTimer);
      this.invalidGrantRetryTimer = null;
    }
    this.clearHomeConnectInitRetry();
    this.clearPeriodicFullSnapshotRefresh();
    this.pendingActiveProgramHaIds.clear();
    if (this.deviceService && typeof this.deviceService.shutdown === "function") {
      this.deviceService.shutdown();
    }
  },

  handleConfigNotificationFirstTime(instanceId) {
    this.configReceived = true;

    if (this.isSessionAuthenticated()) {
      return this.handleSessionAlreadyActive(instanceId);
    }

    if (this.isAuthFlowInProgress()) {
      return this.notifyAuthInProgress(instanceId);
    }

    this.emitInitStatus(
      "initializing",
      {
        instanceId
      },
      { broadcast: false, targetInstanceId: instanceId }
    );

    this.checkTokenAndInitialize(instanceId);
  },

  handleSessionAlreadyActive(instanceId) {
    moduleLog("info", "Session already authenticated - using existing tokens");
    this.schedulePeriodicFullSnapshotRefresh();
    this.emitInitStatus(
      "session_active",
      {
        instanceId
      },
      { broadcast: false, targetInstanceId: instanceId }
    );

    this.dispatchDeviceRefreshWithProgramSync({
      reason: "session_active_refresh",
      requester: instanceId || "session_active",
      forcePrograms: false
    });
  },

  notifyAuthInProgress(instanceId) {
    moduleLog("info", "Authentication already in progress for another client instance");
    this.emitInitStatus(
      "auth_in_progress",
      {
        instanceId
      },
      { broadcast: false, targetInstanceId: instanceId }
    );
  },

  handleConfigNotificationSubsequent(instanceId) {
    if (this.isSessionAuthenticated() && this.hc && this.deviceService) {
      this.emitInitStatus(
        "complete",
        {
          instanceId
        },
        { broadcast: false, targetInstanceId: instanceId }
      );

      this.deviceService.broadcastDevices(this.broadcastToAllClients.bind(this));
    } else if (this.isAuthFlowInProgress()) {
      this.notifyAuthInProgress(instanceId);
    }
  },

  handleConfigNotification(payload) {
    // A helper that was restarted while a valid client + token were already in
    // place has no auth flow to run - adopt the existing session instead.
    if (!this.sessionAuthenticated && !this.authFlowInProgress && this.hc && globalSession.refreshToken) {
      this.sessionAuthenticated = true;
    }

    const instanceId = payload.instanceId || "default";
    // Compare resolved languages: a client that leaves apiLanguage empty and lands
    // on the session language through its browser hint is not a real difference.
    const clientSessionConfig = { ...payload, apiLanguage: resolveSessionLanguage(payload) };

    if (this.sessionOwnerConfig) {
      // A different account cannot be served by this session at all.
      const mismatchKeys = CRITICAL_CONFIG_KEYS.filter(
        (key) => this.sessionOwnerConfig[key] !== clientSessionConfig[key]
      );
      if (mismatchKeys.length > 0) {
        this.rejectConfigMismatch(instanceId, mismatchKeys);
        return;
      }

      this.warnAboutIgnoredSessionConfig(instanceId, clientSessionConfig);
    } else {
      this.sessionOwnerConfig = clientSessionConfig;
    }

    globalSession.clientInstances.add(instanceId);
    globalSession.clientInstanceLastSeen.set(instanceId, Date.now());

    moduleLog("debug", `Processing CONFIG notification for instance: ${instanceId}`);
    moduleLog("debug", `Registered clients: ${globalSession.clientInstances.size}`);

    // If debug information has already been collected, immediately send a snapshot
    // to all known clients so newly loaded instances can see the debug panel
    // without waiting for additional events.
    try {
      if (
        this.debugStats &&
        (this.debugStats.lastApiCallTs ||
          this.debugStats.lastSseEventTs ||
          this.debugStats.lastSseTrafficTs)
      ) {
        this.broadcastDebugStats(true);
      }
    } catch (e) {
      moduleLog("warn", "Failed to broadcast initial debug stats", e);
    }

    if (!this.configReceived) {
      this.instanceId = instanceId;
      this.sharedConfigOwnerInstanceId = instanceId;
      this.config = { ...payload, apiLanguage: this.sessionOwnerConfig.apiLanguage };
      // apply configured log level for module-level logging via auth service
      this.authService.setConfig(this.config);
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationFirstTime(instanceId);
    } else {
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationSubsequent(instanceId);
    }
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
      this.emitInitStatus(
        "hc_not_ready",
        {
          instanceId: requester
        },
        requester ? { broadcast: false, targetInstanceId: requester } : {}
      );
      return;
    }

    const now = Date.now();

    const rateLimitActive = this.isRateLimited();
    if (!force && rateLimitActive) {
      const remainingSeconds = Math.ceil((globalSession.rateLimitUntil - now) / 1000);
      moduleLog("info", `Rate limited - ${remainingSeconds}s remaining`);
      this.emitInitStatus(
        "device_error",
        {
          message: `Rate limit active - please wait ${remainingSeconds}s`,
          rateLimitSeconds: remainingSeconds,
          statusCode: 429,
          isRateLimit: true,
          instanceId: requester
        },
        requester ? { broadcast: false, targetInstanceId: requester } : {}
      );
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

    const scopeKey = this.buildActiveProgramFetchScopeKey(targetDevices);
    if (force && this.hasRecentForcedProgramFetch(scopeKey, now)) {
      moduleLog("debug", "Skipping recently completed forced active program request", {
        requester: requesterLabel,
        scopeKey
      });
      return;
    }

    const fetchSignature = this.buildActiveProgramFetchSignature(targetDevices, requesterLabel);
    if (this.activeProgramFetchInFlight) {
      if (this.activeProgramFetchSignature === fetchSignature) {
        moduleLog("debug", "Skipping duplicate active program request while fetch in flight", {
          requester: requesterLabel,
          deviceCount: targetDevices.length,
          force
        });
        return;
      }

      moduleLog("debug", "Skipping overlapping active program request while another fetch is in flight", {
        requester: requesterLabel,
        deviceCount: targetDevices.length,
        force,
        activeFetchSignature: this.activeProgramFetchSignature
      });
      // Not a failure, just bad timing (e.g. an SSE-triggered single-device
      // fetch colliding with the full-snapshot batch) - queue it so it's
      // picked up immediately once the in-flight fetch finishes, instead of
      // being lost until another SSE delta happens to re-trigger it.
      targetDevices.forEach((device) => this.pendingActiveProgramHaIds.add(device.haId));
      return;
    }

    this.programFetchInFlight = true;
    this.activeProgramFetchInFlight = true;
    this.activeProgramFetchSignature = fetchSignature;
    globalSession.lastActiveProgramFetch = now;
    this.fetchActiveProgramsForDevices(targetDevices, requester, {
      force,
      scopeKey
    });
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== this.notifications.REQUEST) {
      return;
    }

    const safePayload = payload || {};
    const action = safePayload.action;

    switch (action) {
      case "CONFIGURE":
        this.handleConfigNotification({
          ...(safePayload?.data?.config || {}),
          instanceId: safePayload.instanceId || safePayload.identifier || "default"
        });
        break;

      case "RETRY_AUTH":
        this.handleRetryAuth();
        break;

      case "GET_ACTIVE_PROGRAMS":
        this.handleGetActivePrograms({
          ...(safePayload?.data || {}),
          instanceId: safePayload.instanceId || safePayload.identifier || "default"
        });
        break;

      default:
        break;
    }
  },

  broadcastToAllClients(notification, payload) {
    globalSession.clientInstances.forEach((instanceId) => {
      // Keep payload shape intact (arrays must remain arrays for DEVICES_UPDATE).
      this.sendEventToInstance(instanceId, notification, payload);
    });
  },

  broadcastDebugStats(force = false) {
    const now = Date.now();
    if (!force && now - this.lastDebugStatsBroadcastTs < DEBUG_STATS_BROADCAST_INTERVAL_MS) {
      return;
    }
    this.lastDebugStatsBroadcastTs = now;

    this.broadcastToAllClients("DEBUG_STATS", {
      lastApiCallTs: this.debugStats.lastApiCallTs,
      lastSseEventTs: this.debugStats.lastSseEventTs,
      lastSseTrafficTs: this.debugStats.lastSseTrafficTs,
      apiCounters: { ...this.debugStats.apiCounters },
      session: {
        authenticated: this.sessionAuthenticated,
        authFlowInProgress: this.authFlowInProgress,
        deviceRefreshInFlight: this.deviceRefreshInFlight,
        programFetchInFlight: this.programFetchInFlight,
        rateLimitUntil: this.getRateLimitUntil(),
        rateLimitRemainingMs: Math.max(0, this.getRateLimitUntil() - Date.now())
      }
    });
  },

  recordApiCall(apiName) {
    if (!apiName) return;
    this.debugStats.lastApiCallTs = Date.now();
    this.debugStats.apiCounters[apiName] = (this.debugStats.apiCounters[apiName] || 0) + 1;
    this.broadcastDebugStats();
  },

  recordSseEvent() {
    const now = Date.now();
    this.debugStats.lastSseEventTs = now;
    this.debugStats.lastSseTrafficTs = now;
    this.broadcastDebugStats();
  },

  recordSseKeepAlive() {
    this.debugStats.lastSseTrafficTs = Date.now();
    this.broadcastDebugStats();
  },

  handleSseStale(context = {}) {
    if (!this.hc || this.isAuthFlowInProgress()) {
      moduleLog("debug", "Ignoring SSE stale recovery while HomeConnect is unavailable", context);
      return;
    }

    if (!this.deviceService || typeof this.deviceService.reconnectEventSubscriptions !== "function") {
      moduleLog("warn", "SSE watchdog cannot rebuild subscriptions - DeviceService unavailable", context);
      return;
    }

    moduleLog("warn", "SSE watchdog triggered subscription rebuild", context);
    this.deviceService.reconnectEventSubscriptions().then((rebuilt) => {
      if (!rebuilt) {
        return;
      }

      this.dispatchDeviceRefreshWithProgramSync({
        reason: "sse_watchdog_resync",
        requester: "sse_watchdog",
        forcePrograms: true
      });
    });
  },

  // A device just started reporting a program in progress (via SSE) but we don't
  // know which program it is yet - fetch it now instead of waiting for the next
  // scheduled full snapshot (up to 30 minutes later). Runs through the normal
  // GET_ACTIVE_PROGRAMS path so existing throttling/dedup/retry logic still applies.
  handleActiveProgramNeededFromSse(haId) {
    if (!haId || !this.hc || this.isAuthFlowInProgress()) {
      return;
    }

    moduleLog("debug", "SSE indicates a device is active without known program - fetching it", {
      haId
    });

    this.handleGetActivePrograms({
      instanceId: "sse_program_detected",
      haIds: [haId],
      force: true
    });
  },

  readRefreshTokenFromFile() {
    return this.authService.readRefreshTokenFromFile();
  },

  checkRateLimit(targetInstanceId = null) {
    const now = Date.now();
    if (now - globalSession.lastAuthAttempt < globalSession.MIN_AUTH_INTERVAL) {
      globalSession.rateLimitUntil =
        globalSession.lastAuthAttempt + globalSession.MIN_AUTH_INTERVAL;
      moduleLog("warn", "Rate limit: waiting before next auth attempt");
      this.emitInitStatus(
        "rate_limited",
        targetInstanceId
          ? {
            instanceId: targetInstanceId
          }
          : {},
        targetInstanceId ? { broadcast: false, targetInstanceId } : {}
      );
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

  checkTokenAndInitialize(targetInstanceId = null) {
    const token = this.readRefreshTokenFromFile();

    if (token) {
      moduleLog("info", "Using saved refresh token - initializing HomeConnect");
      globalSession.refreshToken = token;
      this.refreshToken = token;

      this.emitInitStatus(
        "token_found",
        targetInstanceId
          ? {
            instanceId: targetInstanceId
          }
          : {},
        targetInstanceId ? { broadcast: false, targetInstanceId } : {}
      );

      this.initializeHomeConnect(token);
      return;
    }

    if (!this.checkRateLimit(targetInstanceId)) {
      return;
    }

    this.initiateAuthFlow();
  },

  handleHeadlessAuthSuccess(tokens) {
    persistRefreshToken(tokens.refresh_token);

    globalSession.refreshToken = tokens.refresh_token;
    globalSession.accessToken = tokens.access_token;

    this.emitInitStatus("initializing_hc");

    return this.initializeHomeConnect(tokens.refresh_token);
  },

  handleHeadlessAuthError(error) {
    this.authFlowInProgress = false;
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
      this.headlessAuthRetryTimer = setTimeout(() => {
        this.headlessAuthRetryTimer = null;
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

    this.authFlowInProgress = true;
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

    this.clearHomeConnectInitRetry();

    this.authFlowInProgress = false;
    this.sessionAuthenticated = true;

    this.schedulePeriodicFullSnapshotRefresh();

    this.emitInitStatus("success");

    if (this.deviceService) {
      // Perform a single initial snapshot from the API, then rely on SSE deltas.
      this.dispatchDeviceRefreshWithProgramSync({
        reason: "initial_device_fetch",
        requester: this.instanceId || "initial_sync",
        forcePrograms: false
      });
    }
  },

  handleHomeConnectInitError(error) {
    moduleLog("error", "HomeConnect initialization failed:", error);
    this.authFlowInProgress = false;
    this.sessionAuthenticated = false;

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

      deleteRefreshTokenFile();

      globalSession.refreshToken = null;
      globalSession.accessToken = null;
      this.refreshToken = null;
      this.hc = null;

      // Reset attempts so a fresh authentication cycle can proceed without hitting attempt limits.
      this.initializationAttempts = 0;
      this.clearHomeConnectInitRetry();
      globalSession.lastAuthAttempt = 0;
      this.setRateLimitUntil(0);

      // Start a fresh headless authentication flow (shows QR code on clients)
      this.invalidGrantRetryTimer = setTimeout(() => {
        this.invalidGrantRetryTimer = null;
        if (!this.isAuthFlowInProgress()) {
          this.initWithHeadlessAuth();
        }
      }, 1500);

      return;
    }

    this.emitInitStatus("hc_error", {
      message: `HomeConnect error: ${error.message}`
    });

    // Not an invalid_grant - most likely a transient failure (e.g. network/DNS not
    // ready yet right after a device reboot). The refresh token itself is probably
    // still fine, so retry the same init with backoff instead of stranding the
    // session in ERROR forever.
    this.scheduleHomeConnectInitRetry();
  },

  scheduleHomeConnectInitRetry() {
    const token = globalSession.refreshToken || this.refreshToken;
    if (!token) {
      moduleLog("debug", "No refresh token available - skipping automatic HomeConnect init retry");
      return;
    }

    if (this.hcInitRetryTimer) {
      return;
    }

    const attempt = this.hcInitRetryAttempts;
    const delay = Math.min(HC_INIT_RETRY_BASE_DELAY_MS * 2 ** attempt, HC_INIT_RETRY_MAX_DELAY_MS);
    this.hcInitRetryAttempts = attempt + 1;

    moduleLog(
      "info",
      `Scheduling HomeConnect init retry in ${Math.round(delay / 1000)}s (attempt ${this.hcInitRetryAttempts}) after transient error`
    );

    this.hcInitRetryTimer = setTimeout(() => {
      this.hcInitRetryTimer = null;

      if (this.isSessionAuthenticated()) {
        return;
      }

      this.initializeHomeConnect(token).catch(() => {
        // Failure is already handled inside initializeHomeConnect via
        // handleHomeConnectInitError, which schedules the next retry.
      });
    }, delay);
  },

  clearHomeConnectInitRetry() {
    if (this.hcInitRetryTimer) {
      clearTimeout(this.hcInitRetryTimer);
      this.hcInitRetryTimer = null;
    }
    this.hcInitRetryAttempts = 0;
  },

  setupHomeConnectRefreshToken() {
    this.hc.on("newRefreshToken", (refreshToken) => {
      persistRefreshToken(refreshToken);
      globalSession.refreshToken = refreshToken;
      if (this.deviceService && typeof this.deviceService.noteTokenRefreshed === "function") {
        this.deviceService.noteTokenRefreshed();
      }
      if (this.deviceService && this.deviceService.subscribed) {
        moduleLog("info", "Token updated post-init - SSE session remains authoritative");
      } else {
        moduleLog("info", "Token updated during initialization");
      }
    });
  },

  async initializeHomeConnect(refreshToken) {
    return new Promise((resolve, reject) => {
      moduleLog("info", "Initializing HomeConnect with token...");
      this.authFlowInProgress = true;
      if (!HomeConnect) {
        HomeConnect = require("./lib/homeconnect-api.js");
      }
      this.hc = new HomeConnect(this.config.clientId, this.config.clientSecret, refreshToken, {
        acceptLanguage: this.config.apiLanguage,
        requestTimeoutMs: this.config.apiRequestTimeoutMs
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
        this.authFlowInProgress = false;
        this.sessionAuthenticated = false;
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
    this.clearHomeConnectInitRetry();
    this.sessionAuthenticated = false;
    this.authFlowInProgress = false;
    globalSession.accessToken = null;
    globalSession.refreshToken = null;

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

    deleteRefreshTokenFile();

    this.refreshToken = null;

    this.checkTokenAndInitialize();
  },

  broadcastDevices() {
    if (!this.deviceService) return;
    this.deviceService.broadcastDevices(this.broadcastToAllClients.bind(this));
  },

  async fetchActiveProgramForDevice(haId, deviceName) {
    if (!this.programService)
      return { haId, success: false, error: "ProgramService not available" };
    return this.programService.fetchActiveProgramForDevice(haId, deviceName);
  },

  async fetchActiveProgramsForDevices(deviceArray, requestingInstanceId, requestMeta = {}) {
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
            const shouldRetry = this.shouldRetryNoActiveProgram(device);
            moduleLog(
              "debug",
              `Device ${device.name} reported no active program (retry=${shouldRetry})`
            );
            if (shouldRetry) {
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
      if (requestMeta.force && requestMeta.scopeKey) {
        this.rememberForcedProgramFetch(requestMeta.scopeKey);
      }
      this.activeProgramFetchInFlight = false;
      this.activeProgramFetchSignature = null;
      this.programFetchInFlight = false;

      if (this.pendingActiveProgramHaIds.size > 0) {
        const pendingHaIds = [...this.pendingActiveProgramHaIds];
        this.pendingActiveProgramHaIds.clear();
        this.handleGetActivePrograms({
          instanceId: "active_program_overlap_followup",
          haIds: pendingHaIds,
          force: true
        });
      }
    }
  },

  handleActiveProgramFetchError(error) {
    if (!this.programService) return;
    this.programService.handleActiveProgramFetchError(error, this.broadcastToAllClients.bind(this));
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
