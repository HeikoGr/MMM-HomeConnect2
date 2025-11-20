let HomeConnect = null;
const fs = require("fs");
const ActiveProgramManager = require("./lib/active-program-manager");
const AuthService = require("./lib/auth-service");
const DeviceService = require("./lib/device-service");
const ProgramService = require("./lib/program-service");
const {
  deviceAppearsActive,
  isDeviceConnected
} = require("./lib/device-utils");
/* eslint-disable n/no-missing-require */
const NodeHelper = require("node_helper"),
  globalSession = {
    isAuthenticated: false,
    isAuthenticating: false,
    accessToken: null, // Access token for API requests
    refreshToken: null, // Refresh token for obtaining new access tokens
    clientInstances: new Set(), // Set of client instance IDs using this helper
    lastAuthAttempt: 0, // Timestamp of the last authentication attempt
    MIN_AUTH_INTERVAL: 60000, // 1 minute between auth attempts
    rateLimitUntil: 0, // Timestamp until which rate limiting is active
    lastActiveProgramFetch: 0, // Timestamp of last active program fetch
    MIN_ACTIVE_PROGRAM_INTERVAL: 10000 // 10 seconds between fetches
  };

// Active-program request dedupe window (ms)
const ACTIVE_PROGRAM_REQUEST_TTL = 10000; // 10s
let lastActiveProgramsRequest = { instanceId: null, timestamp: 0 }; // Track last request
const ACTIVE_PROGRAM_RETRY_DELAY_MS = 5000; // 5s
const ACTIVE_PROGRAM_MAX_RETRIES = 3; // Maximum number of retries for active program requests

const { moduleLog, setModuleLogLevel } = require("./lib/logger");

module.exports = NodeHelper.create({
  refreshToken: null,
  hc: null,
  authInProgress: false,
  configReceived: false,
  initializationAttempts: 0,
  maxInitAttempts: 3,
  instanceId: null,
  subscribed: false,
  activeProgramManager: null,
  authService: null,
  deviceService: null,
  programService: null,

  init() {
    moduleLog("info", "init module helper: MMM-HomeConnect (session-based)");

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
      globalSession
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
      devices: this.deviceService.devices
    });
  },

  start() {
    moduleLog("info", `Starting module helper: ${this.name}`);
  },

  stop() {
    moduleLog("info", `Stopping module helper: ${this.name}`);
    if (
      this.activeProgramManager &&
      typeof this.activeProgramManager.clearAll === "function"
    ) {
      this.activeProgramManager.clearAll();
    }
  },

  handleConfigNotificationFirstTime() {
    this.configReceived = true;
    moduleLog("debug", "useHeadlessAuth:", this.config.useHeadlessAuth);

    if (globalSession.isAuthenticated) {
      return this.handleSessionAlreadyActive();
    }

    if (globalSession.isAuthenticating) {
      return this.notifyAuthInProgress();
    }

    this.sendSocketNotification("INIT_STATUS", {
      status: "initializing",
      message: "Initialization started",
      instanceId: this.instanceId
    });

    this.checkTokenAndInitialize();
  },

  handleSessionAlreadyActive() {
    moduleLog("info", "Session already authenticated - using existing tokens");
    this.sendSocketNotification("INIT_STATUS", {
      status: "session_active",
      message: "Session active - using existing authentication",
      instanceId: this.instanceId
    });

    if (this.hc && this.deviceService) {
      setTimeout(() => {
        this.deviceService.getDevices(this.sendSocketNotification.bind(this));
      }, 1000);
    }
  },

  notifyAuthInProgress() {
    moduleLog(
      "info",
      "Authentication already in progress for another client instance"
    );
    this.sendSocketNotification("INIT_STATUS", {
      status: "auth_in_progress",
      message: "Authentication in progress",
      instanceId: this.instanceId
    });
  },

  handleConfigNotificationSubsequent() {
    if (globalSession.isAuthenticated && this.hc && this.deviceService) {
      this.sendSocketNotification("INIT_STATUS", {
        status: "complete",
        message: "Already initialized",
        instanceId: this.instanceId
      });

      setTimeout(() => {
        this.deviceService.broadcastDevices(
          this.sendSocketNotification.bind(this)
        );
      }, 500);
    } else if (globalSession.isAuthenticating) {
      this.notifyAuthInProgress();
    }
  },

  handleConfigNotification(payload) {
    this.instanceId = payload.instanceId || "default";
    globalSession.clientInstances.add(this.instanceId);

    moduleLog(
      "debug",
      `Processing CONFIG notification for instance: ${this.instanceId}`
    );
    moduleLog(
      "debug",
      `Registered clients: ${globalSession.clientInstances.size}`
    );

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
        if (
          !("useHeadlessAuth" in this.config) &&
          "use_headless_auth" in this.config
        ) {
          this.config.useHeadlessAuth = this.config.use_headless_auth;
        }
        if (!this.config.baseUrl && this.config.BaseURL) {
          this.config.baseUrl = this.config.BaseURL;
        }
      }
      // apply configured log level for module-level logging via auth service
      this.authService.setConfig(this.config);
      this.handleConfigNotificationFirstTime();
    } else {
      this.handleConfigNotificationSubsequent();
    }
  },

  handleUpdateRequest() {
    if (this.hc && this.deviceService && !globalSession.isAuthenticating) {
      moduleLog("info", "Update request received - fetching devices");
      this.deviceService.getDevices(this.sendSocketNotification.bind(this));
    } else {
      moduleLog(
        "warn",
        "Update request ignored - HomeConnect not ready or auth in progress"
      );
    }
  },

  handleRetryAuth() {
    moduleLog("info", "Manual retry requested");
    this.retryAuthentication();
  },

  handleGetActivePrograms() {
    // No payload previously accepted; ensure function signature backwards compatible
    // If called with an argument (from socketNotificationReceived), use it.
    // Note: socketNotificationReceived will be updated to forward payload.
    const args = Array.from(arguments);
    const payload = args[0] || {};
    moduleLog(
      "info",
      "📊 GET_ACTIVE_PROGRAMS request received",
      payload.instanceId || "(no instance)"
    );

    if (!this.hc) {
      moduleLog(
        "warn",
        "HomeConnect not initialized - cannot fetch active programs"
      );
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready"
      });
      return;
    }

    const now = Date.now();
    const requester = payload.instanceId || null;

    // Dedupe: if another instance recently requested active programs, ignore
    if (
      requester &&
      lastActiveProgramsRequest.timestamp + ACTIVE_PROGRAM_REQUEST_TTL > now &&
      lastActiveProgramsRequest.instanceId &&
      lastActiveProgramsRequest.instanceId !== requester
    ) {
      moduleLog(
        "info",
        `Ignoring GET_ACTIVE_PROGRAMS from ${requester} - recently served ${lastActiveProgramsRequest.instanceId}`,
        {
          lastRequestAgeMs: now - lastActiveProgramsRequest.timestamp,
          dedupeWindowMs: ACTIVE_PROGRAM_REQUEST_TTL
        }
      );
      return;
    }

    // Record this request as the most-recent
    if (requester) {
      lastActiveProgramsRequest = { instanceId: requester, timestamp: now };
      moduleLog("debug", `Recorded active program request for ${requester}`);
    }

    // Check if we're currently rate limited
    if (now < globalSession.rateLimitUntil) {
      const remainingSeconds = Math.ceil(
        (globalSession.rateLimitUntil - now) / 1000
      );
      moduleLog("info", `Rate limited - ${remainingSeconds}s remaining`);
      this.broadcastToAllClients("INIT_STATUS", {
        status: "device_error",
        message: `Rate limit active - please wait ${remainingSeconds}s`,
        rateLimitSeconds: remainingSeconds,
        instanceId: requester
      });
      return;
    }

    // Check minimum interval between requests
    const sinceLastFetch = now - globalSession.lastActiveProgramFetch;
    if (sinceLastFetch < globalSession.MIN_ACTIVE_PROGRAM_INTERVAL) {
      const waitMs = globalSession.MIN_ACTIVE_PROGRAM_INTERVAL - sinceLastFetch;
      moduleLog("warn", "Throttling active program requests", {
        requester: requester || "unknown",
        sinceLastFetchMs: sinceLastFetch,
        minIntervalMs: globalSession.MIN_ACTIVE_PROGRAM_INTERVAL,
        waitMs
      });
      return;
    }

    const deviceCount =
      this.deviceService && this.deviceService.devices
        ? this.deviceService.devices.size
        : 0;

    moduleLog("debug", "Active program request accepted", {
      requester: requester || "unknown",
      deviceCount
    });

    globalSession.lastActiveProgramFetch = now;
    // Pass requester instanceId so we can scope the response
    this.fetchActiveProgramsForAllDevices(requester);
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "CONFIG":
        this.handleConfigNotification(payload);
        break;

      case "UPDATEREQUEST":
        this.handleUpdateRequest();
        break;

      case "RETRY_AUTH":
        this.handleRetryAuth();
        break;

      case "GET_ACTIVE_PROGRAMS":
        this.handleGetActivePrograms(payload);
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

  readRefreshTokenFromFile() {
    return this.authService.readRefreshTokenFromFile();
  },

  checkRateLimit() {
    const now = Date.now();
    if (now - globalSession.lastAuthAttempt < globalSession.MIN_AUTH_INTERVAL) {
      moduleLog("warn", "Rate limit: waiting before next auth attempt");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate limit - please wait..."
      });
      return false;
    }
    return true;
  },

  initiateAuthFlow() {
    this.authService.initiateAuthFlow();
    if (!globalSession.isAuthenticating && !globalSession.refreshToken) {
      this.initWithHeadlessAuth();
    }
  },

  checkTokenAndInitialize() {
    moduleLog("debug", "Checking for existing refresh token...");

    const token = this.readRefreshTokenFromFile();

    if (token) {
      moduleLog("info", "Using saved refresh token - initializing HomeConnect");
      globalSession.refreshToken = token;
      this.refreshToken = token;

      this.broadcastToAllClients("INIT_STATUS", {
        status: "token_found",
        message: "Token found - initializing HomeConnect"
      });

      this.initializeHomeConnect(token);
      return;
    }

    if (!this.checkRateLimit()) {
      return;
    }

    this.initiateAuthFlow();
  },

  handleHeadlessAuthSuccess(tokens) {
    fs.writeFileSync(
      "./modules/MMM-HomeConnect2/refresh_token.json",
      tokens.refresh_token
    );
    moduleLog("info", "Refresh token saved successfully");

    globalSession.refreshToken = tokens.refresh_token;
    globalSession.accessToken = tokens.access_token;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "initializing_hc",
      message: "Initializing HomeConnect..."
    });

    return this.initializeHomeConnect(tokens.refresh_token);
  },

  handleHeadlessAuthError(error) {
    globalSession.isAuthenticating = false;
    moduleLog("error", "Headless authentication failed:", error.message);

    this.broadcastToAllClients("AUTH_STATUS", {
      status: "error",
      message: `Authentication failed: ${error.message}`
    });

    if (error.message.includes("polling too quickly")) {
      moduleLog(
        "info",
        "Rate limiting detected - will not retry automatically"
      );
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate limit reached - please restart in 2 minutes"
      });
      return;
    }

    if (this.initializationAttempts < this.maxInitAttempts) {
      console.log(
        `🔄 Will retry in 30 seconds (${this.initializationAttempts}/${this.maxInitAttempts})`
      );
      setTimeout(() => {
        if (!this.hc) {
          this.initWithHeadlessAuth();
        }
      }, 30 * 1000);
      return;
    }

    moduleLog(
      "error",
      "Max initialization attempts reached - aborting headless authentication"
    );
    this.broadcastToAllClients("INIT_STATUS", {
      status: "auth_failed",
      message: "Authentication failed - please check manually"
    });
  },

  async initWithHeadlessAuth() {
    if (globalSession.isAuthenticating) {
      moduleLog("warn", "Authentication already in progress, skipping...");
      return;
    }

    globalSession.isAuthenticating = true;
    this.initializationAttempts++;

    moduleLog(
      "info",
      `Starting headless authentication (attempt ${this.initializationAttempts}/${this.maxInitAttempts})`
    );

    try {
      const tokens = await this.authService.headlessAuth(
        (notification, payload) =>
          this.broadcastToAllClients(notification, payload)
      );

      await this.handleHeadlessAuthSuccess(tokens);
    } catch (error) {
      this.handleHeadlessAuthError(error);
    }
  },

  handleHomeConnectInitSuccess() {
    moduleLog("info", "HomeConnect initialized successfully");

    globalSession.isAuthenticated = true;
    globalSession.isAuthenticating = false;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "success",
      message: "Successfully initialized"
    });

    if (this.deviceService) {
      setTimeout(() => {
        this.deviceService.getDevices(this.sendSocketNotification.bind(this));
      }, 2000);
    }
  },

  handleHomeConnectInitError(error) {
    moduleLog("error", "HomeConnect initialization failed:", error);
    globalSession.isAuthenticating = false;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "hc_error",
      message: `HomeConnect error: ${error.message}`
    });
  },

  setupHomeConnectRefreshToken() {
    this.hc.on("newRefreshToken", (refreshToken) => {
      fs.writeFileSync(
        "./modules/MMM-HomeConnect2/refresh_token.json",
        refreshToken
      );
      moduleLog("info", "Refresh token updated");
      globalSession.refreshToken = refreshToken;
      // After init has completed (subscriptions established), refresh devices on token update.
      // During initial init (subscribed === false), skip to avoid double fetching.
      if (this.subscribed && this.deviceService) {
        moduleLog("info", "Token updated post-init - refreshing device list");
        this.deviceService.getDevices(this.sendSocketNotification.bind(this));
      } else {
        moduleLog(
          "info",
          "Token updated during initialization - device fetch will run after init"
        );
      }
    });
  },

  async initializeHomeConnect(refreshToken) {
    return new Promise((resolve, reject) => {
      moduleLog("info", "Initializing HomeConnect with token...");
      if (!HomeConnect) {
        HomeConnect = require("./lib/homeconnect-api.js");
      }
      this.hc = new HomeConnect(
        this.config.clientId,
        this.config.clientSecret,
        refreshToken
      );

      // attach client to services
      if (this.deviceService) {
        this.deviceService.attachClient(this.hc);
      }
      if (this.programService) {
        this.programService.attachClient(this.hc);
      }

      const initTimeout = setTimeout(() => {
        moduleLog("error", "HomeConnect initialization timeout");
        globalSession.isAuthenticating = false;
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
    globalSession.isAuthenticated = false;
    globalSession.isAuthenticating = false;
    globalSession.accessToken = null;
    globalSession.refreshToken = null;
    globalSession.clientInstances.clear();

    this.configReceived = false;
    this.initializationAttempts = 0;
    this.hc = null;
    if (this.deviceService) {
      this.deviceService.devices.clear();
    }
    this.subscribed = false;
    if (
      this.activeProgramManager &&
      typeof this.activeProgramManager.clearAll === "function"
    ) {
      this.activeProgramManager.clearAll();
    }

    if (fs.existsSync("./modules/MMM-HomeConnect2/refresh_token.json")) {
      fs.unlinkSync("./modules/MMM-HomeConnect2/refresh_token.json");
      moduleLog("info", "Old token file deleted");
    }

    this.refreshToken = null;

    this.checkTokenAndInitialize();
  },

  deviceEvent(data) {
    if (!this.deviceService) return;
    this.deviceService.deviceEvent(
      data,
      this.sendSocketNotification.bind(this)
    );
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

  async fetchActiveProgramsForAllDevices(requestingInstanceId) {
    if (!this.deviceService) {
      moduleLog("debug", "DeviceService not available - cannot fetch programs");
      return;
    }

    const deviceArray = Array.from(this.deviceService.devices.values());

    if (deviceArray.length === 0) {
      moduleLog("debug", "No devices to fetch active programs for");
      return;
    }

    moduleLog(
      "info",
      `Fetching active programs for ${deviceArray.length} device(s)`
    );

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_programs",
      message: "Fetching active programs...",
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
          const result = await this.fetchActiveProgramForDevice(
            device.haId,
            device.name
          );
          moduleLog("debug", `Active program response for ${device.name}:`, {
            success: result.success,
            hasData: !!(result.data && Object.keys(result.data).length),
            error: result.error || null
          });
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
        if (
          this.activeProgramManager &&
          typeof this.activeProgramManager.schedule === "function"
        ) {
          this.activeProgramManager.schedule(
            retryCandidates,
            requestingInstanceId
          );
        } else {
          moduleLog(
            "error",
            "ActiveProgramManager not available - cannot schedule retries"
          );
        }
      } else {
        moduleLog("debug", "No retry candidates detected for active programs");
      }
    } catch (error) {
      this.handleActiveProgramFetchError(error);
    }
  },

  handleActiveProgramFetchError(error) {
    if (!this.programService) return;
    this.programService.handleActiveProgramFetchError(
      error,
      this.broadcastToAllClients.bind(this)
    );
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
  }
});
