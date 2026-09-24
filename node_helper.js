const ActiveProgramManager = require("./lib/active-program-manager");
const AuthService = require("./lib/auth-service");
const DeviceService = require("./lib/device-service");
const ProgramService = require("./lib/program-service");
const { ProgramFetchCoordinator } = require("./lib/program-fetch-coordinator");
const shared = require("./lib/mmm-shared/mmm-shared");
const { createClientRegistry, formatLogEntry } = require("./lib/mmm-shared/backend-session");
const NodeHelper = require("node_helper"),
  globalSession = {
    accessToken: null, // Access token for API requests
    refreshToken: null, // Refresh token for obtaining new access tokens
    clientInstances: new Set(), // Set of client instance IDs using this helper
    lastAuthAttempt: 0, // Timestamp of the last authentication attempt
    MIN_AUTH_INTERVAL: 60000, // 1 minute between auth attempts
    rateLimitUntil: 0, // Timestamp until which rate limiting is active
    lastActiveProgramFetch: 0, // Timestamp of last active program fetch
    MIN_ACTIVE_PROGRAM_INTERVAL: 10 * 60 * 1000, // 10 minutes between fetches
  };

const ACTIVE_PROGRAM_RETRY_DELAY_MS = 5000; // 5s
const ACTIVE_PROGRAM_MAX_RETRIES = 3; // Maximum number of retries for active program requests
const FULL_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
const DEVICE_REFRESH_STUCK_TIMEOUT_MS = 5 * 60 * 1000;
const { log, setLogSink, setModuleLogLevel } = require("./lib/logger");

// MagicMirror's logger carries the global logLevel; outside MagicMirror (tests) console.
const Log = (() => {
  try {
    return require("logger");
  } catch {
    return console;
  }
})();

// One line per entry. Defined in this file on purpose: MagicMirror tags each line
// with the folder of the file that calls Log, so it reads [MMM-HomeConnect2], not [mmm-shared].
setLogSink(
  Object.fromEntries(
    ["debug", "info", "warn", "error"].map((method) => [method, (entry) => Log[method](formatLogEntry(entry))]),
  ),
);
const authOrchestration = require("./lib/auth-orchestration");
const clientSessions = require("./lib/client-sessions");
const debugStatsMethods = require("./lib/debug-stats");
const { AUTH_STATUS_MESSAGES, INIT_STATUS_MESSAGES, buildStatusPayload } = require("./lib/status-messages");

module.exports = NodeHelper.create({
  // Grouped helper methods, each in its own file (see the files for details).
  ...authOrchestration,
  ...clientSessions,
  ...debugStatsMethods,

  // Shared across every display of this MagicMirror; the mixins reach it here.
  globalSession,
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
  fullSnapshotTimer: null,
  hcInitRetryTimer: null,
  hcInitRetryAttempts: 0,
  // How long one HomeConnect init may take before it counts as failed.
  hcInitTimeoutMs: 30 * 1000,
  headlessAuthRetryTimer: null,
  invalidGrantRetryTimer: null,
  sessionOwnerConfig: null,
  // The last failed device flow, replayed to displays that connect afterwards.
  lastAuthFailure: null,
  // The QR code / user code of the running device flow, for displays joining late.
  pendingAuthInfo: null,
  debugStats: {
    lastApiCallTs: null,
    lastSseEventTs: null,
    lastSseTrafficTs: null,
    apiCounters: {},
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

  emitStatus(notification, messageMap, status, payload = {}, options = {}) {
    const { broadcast = true, targetInstanceId = null } = options;
    const builtPayload = buildStatusPayload(messageMap, status, payload);

    if (broadcast) {
      this.broadcastToAllClients(notification, builtPayload);
      return;
    }

    this.sendEventToInstance(
      targetInstanceId || builtPayload.instanceId || this.instanceId || "default",
      notification,
      builtPayload,
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
        meta: {},
      }),
    );
  },

  emitInitStatus(status, payload = {}, options = {}) {
    this.emitStatus("INIT_STATUS", INIT_STATUS_MESSAGES, status, payload, options);
  },

  emitAuthStatus(status, payload = {}, options = {}) {
    this.emitStatus("AUTH_STATUS", AUTH_STATUS_MESSAGES, status, payload, options);
  },

  /**
   * Device snapshot, then the program sync once the status calls are done.
   * `activeProgramsOnly` limits the program sync to appliances that are running
   * (by their fresh status): an idle appliance answers /programs/active with a
   * 404 - quota spent, and an error on the way to Home Connect's "10 failed
   * requests in a row" block - and SSE triggers the fetch when it starts.
   */
  dispatchDeviceRefreshWithProgramSync({
    reason,
    requester,
    forcePrograms = false,
    activeProgramsOnly = false,
    haIds = null,
  } = {}) {
    if (!this.deviceService || !this.hc || this.authFlowInProgress) {
      return false;
    }

    log.debug("Dispatching device refresh", { reason: reason || "device_refresh" });
    this.deviceRefreshInFlight = true;
    this.deviceRefreshStartedAt = Date.now();

    // Pure broadcast sink. The in-flight flag is released by DeviceService's
    // onRefreshSettled hook: a failing fetch never sends a notification, so
    // clearing it here left it stuck on true after a single 429.
    this.deviceService.getDevices(
      (notification, callbackPayload) => this.broadcastToAllClients(notification, callbackPayload),
      {
        onDetailsRefreshed: () =>
          this.handleGetActivePrograms({
            instanceId: requester || this.instanceId || "unknown",
            haIds,
            force: forcePrograms,
            activeOnly: activeProgramsOnly,
          }),
      },
    );

    return true;
  },

  init() {
    log.info("init module helper: MMM-HomeConnect2 (session-based)");
    this.notifications = shared.buildNotifications("MMM-HomeConnect2");

    this.authService = new AuthService({
      logger: log,
      broadcastToAllClients: this.broadcastToAllClients.bind(this),
      setModuleLogLevel,
      globalSession,
      maxInitAttempts: this.maxInitAttempts,
    });

    this.deviceService = new DeviceService({
      logger: log,
      broadcastToAllClients: this.broadcastToAllClients.bind(this),
      globalSession,
      onSseStale: this.handleSseStale.bind(this),
      onActiveProgramNeeded: this.handleActiveProgramNeededFromSse.bind(this),
      onRefreshSettled: () => {
        this.deviceRefreshInFlight = false;
      },
      setRateLimitUntil: this.setRateLimitUntil.bind(this),
      debugHooks: {
        recordApiCall: this.recordApiCall.bind(this),
        recordSseEvent: this.recordSseEvent.bind(this),
        recordSseKeepAlive: this.recordSseKeepAlive.bind(this),
      },
    });

    try {
      this.activeProgramManager = new ActiveProgramManager({
        fetchFn: this.fetchActiveProgramForDevice.bind(this),
        broadcastFn: this.broadcastProgramData.bind(this),
        logger: log,
        maxRetries: ACTIVE_PROGRAM_MAX_RETRIES,
        retryDelayMs: ACTIVE_PROGRAM_RETRY_DELAY_MS,
      });
      log.debug("ActiveProgramManager initialized");
    } catch (err) {
      log.error("Failed to initialize ActiveProgramManager:", err);
      this.activeProgramManager = null;
    }

    this.programService = new ProgramService({
      logger: log,
      globalSession,
      activeProgramManager: this.activeProgramManager,
      devices: this.deviceService.devices,
      debugHooks: {
        recordApiCall: this.recordApiCall.bind(this),
      },
      setRateLimitUntil: this.setRateLimitUntil.bind(this),
    });
  },

  start() {
    log.info(`Starting module helper: ${this.name}`);
    this.startedAt = Date.now();

    /*
     * A display stays registered while its browser socket is connected; one
     * whose socket is gone for the grace period is dropped from clientInstances.
     * The old rule ("no CONFIGURE for 24 h") also dropped every display that
     * simply kept running, because the frontend sends CONFIGURE only once.
     * A new connection is asked for CONFIGURE (INIT_REQUIRED), so a display
     * re-registers after a server restart without a page reload.
     */
    this.clientRegistry = createClientRegistry({
      namespace: this.name || "MMM-HomeConnect2",
      keyOf: (payload) => payload?.instanceId || null,
      onConnect: (socket) =>
        socket.emit(
          this.notifications.EVENT,
          shared.createEnvelope({
            identifier: "*",
            instanceId: "*",
            action: "INIT_REQUIRED",
            ok: true,
            data: null,
          }),
        ),
      onGone: (instanceId) => this.releaseClientInstance(instanceId),
      // Tests inject timers and a grace period here.
      ...this.clientRegistryOptions,
    }).attach(this.io);
  },

  // The display's browser is gone: stop addressing it.
  releaseClientInstance(instanceId) {
    if (globalSession.clientInstances.delete(instanceId)) {
      log.info(`Released client instance without a connected display: ${instanceId}`);
    }
  },

  // Belt and braces for the in-flight guard: if a refresh somehow never settles,
  // treat it as finished after DEVICE_REFRESH_STUCK_TIMEOUT_MS so the periodic
  // snapshot recovers on its own instead of staying dead until a restart.
  isDeviceRefreshInFlight() {
    if (!this.deviceRefreshInFlight) {
      return false;
    }
    const startedAt = this.deviceRefreshStartedAt || 0;
    if (startedAt && Date.now() - startedAt > DEVICE_REFRESH_STUCK_TIMEOUT_MS) {
      log.warn("Device refresh never settled - clearing stale in-flight flag");
      this.deviceRefreshInFlight = false;
      return false;
    }
    return true;
  },

  schedulePeriodicFullSnapshotRefresh() {
    if (this.fullSnapshotTimer) {
      return;
    }

    this.fullSnapshotTimer = setInterval(() => {
      if (!this.hc || !this.deviceService || this.authFlowInProgress) {
        return;
      }

      if (!this.sessionAuthenticated || this.programFetchCoordinator().isInFlight()) {
        return;
      }

      // The scheduled snapshot is the one caller that runs with nobody watching,
      // so it must not spend quota while a backoff is active. Forced program
      // fetches deliberately bypass the check downstream, hence the guard here.
      if (this.isRateLimited()) {
        const remainingSeconds = Math.ceil((this.getRateLimitUntil() - Date.now()) / 1000);
        log.info(`Skipping scheduled snapshot - rate limited for another ${remainingSeconds}s`);
        return;
      }

      if (this.isDeviceRefreshInFlight()) {
        log.debug("Skipping scheduled snapshot - a device refresh is still running");
        return;
      }

      log.debug("Running scheduled full device snapshot refresh");
      this.dispatchDeviceRefreshWithProgramSync({
        reason: "scheduled_full_snapshot",
        requester: "scheduled_snapshot",
        forcePrograms: true,
        activeProgramsOnly: true,
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
    log.info(`Stopping module helper: ${this.name}`);
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
    this.clientRegistry?.stop();
    this.programFetchCoordinator().reset();
    if (this.deviceService && typeof this.deviceService.shutdown === "function") {
      this.deviceService.shutdown();
    }
  },

  // Admission and fetch loop live in lib/program-fetch-coordinator.js; these
  // two stay on the helper as the entry points (and test seams).
  programFetchCoordinator() {
    if (!this.programFetch) {
      this.programFetch = new ProgramFetchCoordinator({
        session: globalSession,
        getHc: () => this.hc,
        getDeviceService: () => this.deviceService,
        getProgramService: () => this.programService,
        getActiveProgramManager: () => this.activeProgramManager,
        isRateLimited: () => this.isRateLimited(),
        emitInitStatus: (status, payload, options) => this.emitInitStatus(status, payload, options),
        request: (payload) => this.handleGetActivePrograms(payload),
        runFetch: (devices, requester, meta) => this.fetchActiveProgramsForDevices(devices, requester, meta),
        fetchOne: (haId, name) => this.fetchActiveProgramForDevice(haId, name),
        broadcastProgramData: (data, requester) => this.broadcastProgramData(data, requester),
        handleError: (error) => this.handleActiveProgramFetchError(error),
      });
    }
    return this.programFetch;
  },

  handleGetActivePrograms(payload = {}) {
    return this.programFetchCoordinator().request(payload);
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== this.notifications.REQUEST) {
      return;
    }

    const safePayload = payload || {};
    const action = safePayload.action;

    // CONFIGURE is the only action the frontend sends.
    if (action === "CONFIGURE") {
      this.handleConfigNotification({
        ...(safePayload?.data?.config || {}),
        instanceId: safePayload.instanceId || safePayload.identifier || "default",
      });
    }
  },

  broadcastToAllClients(notification, payload) {
    globalSession.clientInstances.forEach((instanceId) => {
      // Keep payload shape intact (arrays must remain arrays for DEVICES_UPDATE).
      this.sendEventToInstance(instanceId, notification, payload);
    });
  },

  broadcastDevices() {
    if (!this.deviceService) return;
    this.deviceService.broadcastDevices(this.broadcastToAllClients.bind(this));
  },

  async fetchActiveProgramForDevice(haId, deviceName) {
    if (!this.programService) return { haId, success: false, error: "ProgramService not available" };
    return this.programService.fetchActiveProgramForDevice(haId, deviceName);
  },

  fetchActiveProgramsForDevices(deviceArray, requestingInstanceId, requestMeta = {}) {
    return this.programFetchCoordinator().fetchDevices(deviceArray, requestingInstanceId, requestMeta);
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
      this.broadcastToAllClients.bind(this),
    );
  },

  updateActiveProgramInterval() {
    const minInterval =
      this.config && typeof this.config.minActiveProgramIntervalMs === "number"
        ? Math.max(0, this.config.minActiveProgramIntervalMs)
        : 10 * 60 * 1000;
    globalSession.MIN_ACTIVE_PROGRAM_INTERVAL = minInterval;
  },
});
