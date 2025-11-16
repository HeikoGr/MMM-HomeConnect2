let HomeConnect = null;
const fs = require("fs");
const NodeHelper = require("node_helper"),
  // Use built-in fetch when available
  fetch =
    typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : null;
const QRCode = require("qrcode"),
  globalSession = {
    isAuthenticated: false,
    isAuthenticating: false,
    accessToken: null,
    refreshToken: null,
    clientInstances: new Set(),
    lastAuthAttempt: 0,
    MIN_AUTH_INTERVAL: 60000,
    // Rate limiting for active program requests
    rateLimitUntil: 0,
    lastActiveProgramFetch: 0,
    MIN_ACTIVE_PROGRAM_INTERVAL: 10000 // 10 seconds between fetches
  };

// Active-program request dedupe window (ms)
const ACTIVE_PROGRAM_REQUEST_TTL = 10000; // 10s
let lastActiveProgramsRequest = { instanceId: null, timestamp: 0 };
const ACTIVE_PROGRAM_RETRY_DELAY_MS = 5000;
const ACTIVE_PROGRAM_MAX_RETRIES = 3;
const LONG_ACTIVE_PROGRAM_REQUEST_MS = 4000;

function getNumericValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "number") {
    return optionValue;
  }
  if (typeof optionValue === "object") {
    if (typeof optionValue.value === "number") {
      return optionValue.value;
    }
    if (typeof optionValue.displayValue === "number") {
      return optionValue.displayValue;
    }
  }
  const parsed = Number(optionValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringValue(optionValue) {
  if (optionValue === null || optionValue === undefined) {
    return null;
  }
  if (typeof optionValue === "string") {
    return optionValue;
  }
  if (typeof optionValue === "object") {
    if (typeof optionValue.value === "string") {
      return optionValue.value;
    }
    if (typeof optionValue.displayValue === "string") {
      return optionValue.displayValue;
    }
  }
  return null;
}

function deviceAppearsActive(device) {
  if (!device) return false;
  const remainingSeconds = getNumericValue(device.RemainingProgramTime);
  if (typeof remainingSeconds === "number" && remainingSeconds > 0) {
    return true;
  }
  const progressValue = getNumericValue(device.ProgramProgress);
  if (typeof progressValue === "number" && progressValue > 0 && progressValue < 100) {
    return true;
  }
  const operationState = getStringValue(device.OperationState);
  if (operationState && /(Run|Active|DelayedStart)/i.test(operationState)) {
    return true;
  }
  return false;
}

function isDeviceConnected(device) {
  if (!device) return false;
  const v = device.connected;
  // Accept boolean true
  if (v === true) return true;
  // Accept common string/enum shapes
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "true" || s === "connected" || s === "online" || s === "available") return true;
  }
  // Accept numeric truthy values (1, non-zero)
  if (typeof v === "number") {
    return v !== 0;
  }
  // Fallback: treat any truthy value as connected
  return !!v;
}

// Module-level log level (updated when config is received)
let moduleLogLevel = "none";

function setModuleLogLevel(level) {
  if (!level) return;
  moduleLogLevel = String(level).toLowerCase();
}

function moduleLog(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
  const cfg = moduleLogLevel in levels ? moduleLogLevel : "none";
  const lvl = level in levels ? level : "info";
  if (levels[lvl] < levels[cfg]) return; // skip if below configured level
  const prefix = "[MMM-HomeConnect]";
  try {
    if (lvl === "debug") {
      if (typeof console.debug === "function") console.debug(prefix, ...args);
      else console.log(prefix, ...args);
    } else if (lvl === "info") {
      console.log(prefix, ...args);
    } else if (lvl === "warn") {
      console.warn(prefix, ...args);
    } else {
      console.error(prefix, ...args);
    }
  } catch (error) {
    console.log("Error in moduleLog:", error);
  }
}

async function initiateDeviceFlow(clientId) {
  try {
    const response = await fetch(
      "https://api.home-connect.com/security/oauth/device_authorization",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `client_id=${clientId}`
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Device authorization failed: ${response.status} - ${errorText}`
      );
    }

    const data = await response.json();
    moduleLog("debug", "Device authorization response:", data);
    return data;
  } catch (error) {
    moduleLog("error", "Device flow initiation failed:", error);
    throw error;
  }
}

function handleTokenSuccess(tokens, sendNotification) {
  moduleLog("info", "Token received successfully");
  if (sendNotification) {
    sendNotification("AUTH_STATUS", {
      status: "success",
      message: "Authentication successful"
    });
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function handleTokenError(error, sendNotification) {
  moduleLog("warn", "Token response error:", error);

  if (error.error === "authorization_pending") {
    moduleLog("info", "Waiting for user authorization...");
    return { action: "retry" };
  }

  if (error.error === "slow_down") {
    moduleLog("info", "Server requested slower polling");
    return { action: "slow_down" };
  }

  if (error.error === "access_denied") {
    if (sendNotification) {
      sendNotification("AUTH_STATUS", {
        status: "error",
        message: "User denied authorization"
      });
    }
    return {
      action: "error",
      message: "❌ User denied authorization"
    };
  }

  if (error.error === "expired_token") {
    if (sendNotification) {
      sendNotification("AUTH_STATUS", {
        status: "error",
        message: "Device code expired - please restart"
      });
    }
    return {
      action: "error",
      message: "❌ Device code expired - please restart"
    };
  }

  return { action: "error", message: `Token request failed: ${error.error_description || error.error}` };
}

async function requestToken(clientId, clientSecret, deviceCode) {
  return fetch("https://api.home-connect.com/security/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=device_code&device_code=${deviceCode}&client_id=${clientId}&client_secret=${clientSecret}`
  });
}

async function pollForToken(
  clientId,
  clientSecret,
  deviceCode,
  interval = 5,
  maxAttempts = 60,
  sendNotification
) {
  return new Promise((resolve, reject) => {
    let attempts = 0,
      currentInterval = Math.max(interval, 5);

    moduleLog("info", `Starting token polling with ${currentInterval}s interval...`);
    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        reject(
          new Error(`Token polling timeout after ${maxAttempts} attempts`)
        );
        return;
      }
      try {
        moduleLog("debug", `Token polling attempt ${attempts}/${maxAttempts} (interval: ${currentInterval}s)`);
        if (sendNotification) {
          sendNotification("AUTH_STATUS", {
            status: "polling",
            attempt: attempts,
            maxAttempts,
            interval: currentInterval,
            message: `Waiting for authorization... (attempt ${attempts}/${maxAttempts})`
          });
        }

        const response = await requestToken(clientId, clientSecret, deviceCode);

        if (response.ok) {
          const tokens = await response.json();
          resolve(handleTokenSuccess(tokens, sendNotification));
          return;
        }

        const error = await response.json(),
          result = handleTokenError(error, sendNotification);

        if (result.action === "retry") {
          setTimeout(poll, currentInterval * 1000);
        } else if (result.action === "slow_down") {
          currentInterval = Math.max(currentInterval + 5, 10);
          moduleLog("info", `Polling interval increased to ${currentInterval}s`);
          setTimeout(poll, currentInterval * 1000);
        } else if (result.action === "error") {
          reject(new Error(result.message));
        }
      } catch (fetchError) {
        moduleLog("error", "Network error during token polling:", fetchError);
        setTimeout(poll, currentInterval * 1000);
      }
    };
    setTimeout(poll, currentInterval * 1000);
  });
}

async function headlessAuth(clientId, clientSecret, sendNotification) {
  try {
    moduleLog("info", "Starting headless authentication (Device Flow)");
    const deviceAuth = await initiateDeviceFlow(clientId);

    moduleLog("info", "HOME CONNECT AUTHENTICATION");
    moduleLog("info", "Open the following URL on any device:", deviceAuth.verification_uri);
    moduleLog("info", "User code:", deviceAuth.user_code);

    /*
     * generate an SVG QR code
     */
    const completeLink =
      deviceAuth.verification_uri_complete ||
      `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`;
    moduleLog("info", "Scan the QR code with your phone to open the verification link");
    let verificationQrSvg = null;
    try {
      verificationQrSvg = await QRCode.toString(completeLink, {
        type: "svg",
        errorCorrectionLevel: "H",
        margin: 1
      });

      moduleLog("debug", "QR SVG generated");
    } catch (qrErr) {
      moduleLog("error", "QR code generation failed:", qrErr.message);
      // Fallback: print the direct link
      moduleLog("info", "Direct link:", completeLink);
    }
    moduleLog("info", `Code expires in: ${Math.floor(deviceAuth.expires_in / 60)} minutes`);
    moduleLog("info", `Polling interval: ${deviceAuth.interval || 5} seconds`);

    if (sendNotification) {
      sendNotification("AUTH_INFO", {
        status: "waiting",
        verification_uri: deviceAuth.verification_uri,
        user_code: deviceAuth.user_code,
        // Provide the SVG directly so the frontend can render it.
        verification_qr_svg: verificationQrSvg,
        // Also include the complete link as fallback for older frontends.
        verification_uri_complete: completeLink,
        // Keep expires/interval for the frontend to show timers.
        expires_in: deviceAuth.expires_in,
        interval: deviceAuth.interval || 5,
        expires_in_minutes: Math.floor(deviceAuth.expires_in / 60)
      });
    }

    const tokens = await pollForToken(
      clientId,
      clientSecret,
      deviceAuth.device_code,
      deviceAuth.interval || 5,
      Math.floor(deviceAuth.expires_in / (deviceAuth.interval || 5)),
      sendNotification
    );

    moduleLog("info", "Authentication completed successfully");
    return tokens;
  } catch (error) {
    moduleLog("error", "Headless authentication failed:", error.message);
    throw error;
  }
}

module.exports = NodeHelper.create({
  refreshToken: null,
  hc: null,
  devices: new Map(),
  authInProgress: false,
  configReceived: false,
  initializationAttempts: 0,
  maxInitAttempts: 3,
  instanceId: null,
  subscribed: false,
  activeProgramRetryTimers: new Map(),

  init() {
    moduleLog("info", "init module helper: MMM-HomeConnect (session-based)");
  },

  start() {
    moduleLog("info", `Starting module helper: ${this.name}`);
  },

  stop() {
    moduleLog("info", `Stopping module helper: ${this.name}`);
    this.activeProgramRetryTimers.forEach((state) => {
      if (state && state.timeoutId) {
        clearTimeout(state.timeoutId);
      }
    });
    this.activeProgramRetryTimers.clear();
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

    if (this.hc) {
      setTimeout(() => {
        this.getDevices();
      }, 1000);
    }
  },

  notifyAuthInProgress() {
    moduleLog("info", "Authentication already in progress for another client instance");
    this.sendSocketNotification("INIT_STATUS", {
      status: "auth_in_progress",
      message: "Authentication in progress",
      instanceId: this.instanceId
    });
  },

  handleConfigNotificationSubsequent() {
    if (globalSession.isAuthenticated && this.hc) {
      this.sendSocketNotification("INIT_STATUS", {
        status: "complete",
        message: "Already initialized",
        instanceId: this.instanceId
      });

      setTimeout(() => {
        this.broadcastDevices();
      }, 500);
    } else if (globalSession.isAuthenticating) {
      this.notifyAuthInProgress();
    }
  },

  handleConfigNotification(payload) {
    this.instanceId = payload.instanceId || "default";
    globalSession.clientInstances.add(this.instanceId);

    moduleLog("debug", `Processing CONFIG notification for instance: ${this.instanceId}`);
    moduleLog("debug", `Registered clients: ${globalSession.clientInstances.size}`);

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
      // apply configured log level for module-level logging
      setModuleLogLevel(this.config?.logLevel || this.config?.loglevel || "none");
      this.handleConfigNotificationFirstTime();
    } else {
      this.handleConfigNotificationSubsequent();
    }
  },

  handleUpdateRequest() {
    if (this.hc && !globalSession.isAuthenticating) {
      moduleLog("info", "Update request received - fetching devices");
      this.getDevices();
    } else {
      moduleLog("warn", "Update request ignored - HomeConnect not ready or auth in progress");
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
    moduleLog("info", "📊 GET_ACTIVE_PROGRAMS request received", payload.instanceId || "(no instance)");

    if (!this.hc) {
      moduleLog("warn", "HomeConnect not initialized - cannot fetch active programs");
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
      const remainingSeconds = Math.ceil((globalSession.rateLimitUntil - now) / 1000);
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
      moduleLog(
        "warn",
        "Throttling active program requests",
        {
          requester: requester || "unknown",
          sinceLastFetchMs: sinceLastFetch,
          minIntervalMs: globalSession.MIN_ACTIVE_PROGRAM_INTERVAL,
          waitMs
        }
      );
      return;
    }

    moduleLog("debug", "Active program request accepted", {
      requester: requester || "unknown",
      deviceCount: this.devices.size
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
    if (!fs.existsSync("./modules/MMM-HomeConnect2/refresh_token.json")) {
      moduleLog("debug", "No refresh token file found");
      return null;
    }

    try {
      const token = fs
        .readFileSync("./modules/MMM-HomeConnect2/refresh_token.json", "utf8")
        .trim();

      if (token && token.length > 0) {
        moduleLog("info", "Existing refresh token found - length:", token.length);
        return token;
      }
      moduleLog("warn", "Refresh token file is empty");
      return null;
    } catch (error) {
      moduleLog("error", "Could not read refresh token file:", error.message);
      return null;
    }
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
    const now = Date.now();
    globalSession.lastAuthAttempt = now;

    /*
     * Only headless/device flow is supported. Always use headless if there is
     * no refresh token available.
     */
    if (!globalSession.isAuthenticating && !globalSession.refreshToken) {
      moduleLog("info", "No refresh token available - using headless authentication");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "need_auth",
        message: "Authentication required"
      });
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
    fs.writeFileSync("./modules/MMM-HomeConnect2/refresh_token.json", tokens.refresh_token);
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
      moduleLog("info", "Rate limiting detected - will not retry automatically");
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

    moduleLog("error", "Max initialization attempts reached - aborting headless authentication");
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
      const _self = this,
        tokens = await headlessAuth(
          this.config.clientId,
          this.config.clientSecret,
          (notification, payload) =>
            _self.broadcastToAllClients(notification, payload)
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

    setTimeout(() => {
      this.getDevices();
    }, 2000);
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
      fs.writeFileSync("./modules/MMM-HomeConnect2/refresh_token.json", refreshToken);
      moduleLog("info", "Refresh token updated");
      globalSession.refreshToken = refreshToken;
      // After init has completed (subscriptions established), refresh devices on token update.
      // During initial init (subscribed === false), skip to avoid double fetching.
      if (this.subscribed) {
        moduleLog("info", "Token updated post-init - refreshing device list");
        this.getDevices();
      } else {
        moduleLog("info", "Token updated during initialization - device fetch will run after init");
      }
    });
  },

  async initializeHomeConnect(refreshToken) {
    return new Promise((resolve, reject) => {
      moduleLog("info", "Initializing HomeConnect with token...");
      if (!HomeConnect) {
        HomeConnect = require("./home-connect-js.js");
      }
      this.hc = new HomeConnect(
        this.config.clientId,
        this.config.clientSecret,
        refreshToken
      );

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

  fetchDeviceStatus(device) {
    // Use client helper only; fallback raw command removed.
    if (this.hc && typeof this.hc.getStatus === 'function') {
      this.hc
        .getStatus(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.status)) {
            res.data.status.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === 'function') {
                this.hc.applyEventToDevice(device, event);
              }
            });
          }
          this.broadcastDevices();
        })
        .catch((err) => moduleLog("error", `Status error for ${device.name}:`, err));
      return;
    }

    // If the client wrapper is not available, report and skip.
    moduleLog("error", `HomeConnect client missing getStatus wrapper - cannot fetch status for ${device.name}`);
  },

  fetchDeviceSettings(device) {
    if (this.hc && typeof this.hc.getSettings === 'function') {
      this.hc
        .getSettings(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.settings)) {
            res.data.settings.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === 'function') {
                this.hc.applyEventToDevice(device, event);
              }
            });
          }
          this.broadcastDevices();
        })
        .catch((err) => moduleLog("error", `Settings error for ${device.name}:`, err));
      return;
    }

    moduleLog("error", `HomeConnect client missing getSettings wrapper - cannot fetch settings for ${device.name}`);
  },

  processDevice(device, index) {
    moduleLog("debug", `Processing device ${index + 1}: ${device.name} (${device.haId})`);
    moduleLog("debug", `Raw connected flag for ${device.name}:`, device.connected);
    this.devices.set(device.haId, device);

    const connected = isDeviceConnected(device);
    const appearsActive = deviceAppearsActive(device);

    if (connected) {
      moduleLog("info", `Device ${device.name} is connected - fetching status`);
      this.fetchDeviceStatus(device);
      this.fetchDeviceSettings(device);
    } else if (appearsActive) {
      // Fallback: device reports activity (remaining time/progress/operation state)
      // even though the top-level connected flag is false. Fetch status/settings
      // to refresh the device object and attempt to get runtime information.
      moduleLog("info", `Device ${device.name} not marked connected but appears active - fetching status/settings as fallback`, { rawConnected: device.connected });
      this.fetchDeviceStatus(device);
      this.fetchDeviceSettings(device);
    } else {
      moduleLog("warn", `Device ${device.name} is not connected`);
    }
  },

  subscribeToDeviceEvents() {
    if (!this.subscribed) {
      moduleLog("info", "Subscribing to device events...");
      this.hc.subscribe("NOTIFY", (e) => {
        this.deviceEvent(e);
      });
      this.hc.subscribe("STATUS", (e) => {
        this.deviceEvent(e);
      });
      this.hc.subscribe("EVENT", (e) => {
        this.deviceEvent(e);
      });
      this.subscribed = true;
      moduleLog("info", "Event subscriptions established");
    } else {
      moduleLog("debug", "Already subscribed to device events - skipping duplicate subscription");
    }
  },

  sortDevices() {
    const array = [...this.devices.entries()],
      sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1 : -1));
    this.devices = new Map(sortedArray);
  },

  handleGetDevicesSuccess(result) {
    moduleLog(
      "info",
      `API response received - Found ${result.body.data.homeappliances.length} appliances`
    );

    if (result.body.data.homeappliances.length === 0) {
      moduleLog("warn", "No appliances found - check Home Connect app");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "no_devices",
        message: "No devices found - check Home Connect app"
      });
    }

    result.body.data.homeappliances.forEach((device, index) => {
      this.processDevice(device, index);
    });

    this.subscribeToDeviceEvents();
    this.sortDevices();

    moduleLog("info", "Device processing complete - broadcasting to frontend");
    this.broadcastDevices();

    this.broadcastToAllClients("INIT_STATUS", {
      status: "complete",
      message: `${result.body.data.homeappliances.length} device(s) loaded`
    });
  },

  handleGetDevicesError(error) {
    moduleLog("error", "Failed to get devices:", error && error.stack ? error.stack : error);

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Device error: ${error.message}`
    });

    if (error.message.includes("fetch") || error.message.includes("network")) {
      moduleLog("info", "Network error detected - retrying in 30 seconds");
      setTimeout(() => {
        this.getDevices();
      }, 30000);
    }
  },

  getDevices() {
    if (!this.hc) {
      console.error("❌ HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready"
      });
      return;
    }

    moduleLog("info", "Fetching devices from Home Connect API...");

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Fetching devices..."
    });

    // Require client wrapper; raw command fallback removed.
    if (this.hc && typeof this.hc.getHomeAppliances === 'function') {
      this.hc
        .getHomeAppliances()
        .then((res) => {
          if (res && res.success && res.data) {
            // shape into previous swagger-like result for compatibility
            const fakeResult = { body: { data: res.data } };
            this.handleGetDevicesSuccess(fakeResult);
          } else {
            const err = new Error(res && res.error ? res.error : 'Failed to fetch appliances');
            err.statusCode = res && res.statusCode ? res.statusCode : null;
            this.handleGetDevicesError(err);
          }
        })
        .catch((err) => this.handleGetDevicesError(err));
      return;
    }

    const err = new Error('HomeConnect client missing getHomeAppliances wrapper - cannot fetch devices');
    moduleLog('error', err.message);
    this.handleGetDevicesError(err);
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
    this.devices.clear();
    this.subscribed = false;
    this.activeProgramRetryTimers.forEach((state) => {
      if (state && state.timeoutId) {
        clearTimeout(state.timeoutId);
      }
    });
    this.activeProgramRetryTimers.clear();

    if (fs.existsSync("./modules/MMM-HomeConnect2/refresh_token.json")) {
      fs.unlinkSync("./modules/MMM-HomeConnect2/refresh_token.json");
      moduleLog("info", "Old token file deleted");
    }

    this.refreshToken = null;

    this.checkTokenAndInitialize();
  },

  deviceEvent(data) {
    const _self = this;
    try {
      const eventObj = JSON.parse(data.data);
      eventObj.items.forEach((item) => {
        if (item.uri) {
          const haId = item.uri.split("/")[3];
          if (_self.hc && typeof _self.hc.applyEventToDevice === 'function') {
            _self.hc.applyEventToDevice(_self.devices.get(haId), item);
          } else {
            moduleLog('warn', 'No event parser available for device events; update home-connect-js client');
          }
        }
      });
      _self.broadcastDevices();
    } catch (error) {
      moduleLog("error", "Error processing device event:", error);
    }
  },

  broadcastDevices() {
    moduleLog("debug", `Broadcasting ${this.devices.size} devices to ${globalSession.clientInstances.size} clients`);
    globalSession.clientInstances.forEach(() => {
      this.sendSocketNotification(
        "MMM-HomeConnect_Update",
        Array.from(this.devices.values())
      );
    });
  },

  async fetchActiveProgramForDevice(haId, deviceName) {
    const started = Date.now();
    try {
      moduleLog("debug", `Fetching active program for ${deviceName} (${haId})`);
      // Prefer client wrapper if available
      if (this.hc && typeof this.hc.getActiveProgram === 'function') {
        const res = await this.hc.getActiveProgram(haId);
        if (res.success) {
          const durationMs = Date.now() - started;
          moduleLog("debug", `Active program data received for ${deviceName} in ${durationMs}ms`);
          if (durationMs > LONG_ACTIVE_PROGRAM_REQUEST_MS) {
            moduleLog("warn", `Slow active program response for ${deviceName}: ${durationMs}ms`);
          }
          return { haId, success: true, data: res.data };
        }
        // No active program or non-fatal response
        if (res.statusCode === 404) {
          const durationMs = Date.now() - started;
          moduleLog("debug", `No active program payload for ${deviceName} (status 404, ${durationMs}ms)`);
          return { haId, success: false, error: "No active program" };
        }
        // propagate rate limit / other errors upwards where necessary
        if (res.statusCode === 429) {
          moduleLog("warn", `Rate limit hit for ${deviceName}`);
          const err = new Error(res.error || 'rate limit');
          err.statusCode = 429;
          throw err;
        }
        const durationMs = Date.now() - started;
        moduleLog("debug", `Active program request for ${deviceName} failed (${res.statusCode || 'n/a'}) in ${durationMs}ms`);
        return { haId, success: false, error: res.error || 'Unknown error' };
      }

      // No raw command fallback: client wrapper required.
      const err = new Error('HomeConnect client missing getActiveProgram wrapper');
      moduleLog('error', err.message);
      return { haId, success: false, error: err.message };
    } catch (error) {
      // Handle 404 - no active program running
      if (error.statusCode === 404 || error.status === 404 || (error.message && error.message.includes("404"))) {
        moduleLog("debug", `No active program for ${deviceName}`);
        return { haId, success: false, error: "No active program" };
      }

      // Handle rate limiting (429)
      if (error.statusCode === 429 || error.status === 429 || (error.message && (error.message.includes("429") || error.message.includes("rate limit")))) {
        moduleLog("warn", `Rate limit hit for ${deviceName}`);
        throw error; // Propagate to trigger backoff
      }

      const durationMs = Date.now() - started;
      moduleLog("error", `Error fetching active program for ${deviceName} after ${durationMs}ms:`, error.message || error);
      return { haId, success: false, error: error.message || "Unknown error" };
    }
  },

  async fetchActiveProgramsForAllDevices(requestingInstanceId) {
    const deviceArray = Array.from(this.devices.values());

    if (deviceArray.length === 0) {
      moduleLog("debug", "No devices to fetch active programs for");
      return;
    }

    moduleLog("info", `Fetching active programs for ${deviceArray.length} device(s)`);

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
            moduleLog("info", `Device ${device.name} not marked connected but appears active - using fallback to fetch program`, { rawConnected: device.connected });
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
          results.push(result);

          // Small delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          moduleLog("debug", `Skipping ${device.name} - not connected`, { rawConnected: device.connected });
        }
      }

      // Process successful results
      const programData = {};
      results.forEach(result => {
        if (result.success && result.data) {
          const payload = this.applyProgramResult(result);
          if (payload) {
            programData[result.haId] = payload;
            this.clearActiveProgramRetry(result.haId);
          }
        } else if (result.error === "No active program") {
          const device = this.devices.get(result.haId);
          if (device) {
            const appearsActive = deviceAppearsActive(device);
            moduleLog("debug", `Device ${device.name} reported no active program (appearsActive=${appearsActive})`);
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
        this.queueActiveProgramRetries(retryCandidates, requestingInstanceId);
      } else {
        moduleLog("debug", "No retry candidates detected for active programs");
      }

    } catch (error) {
      this.handleActiveProgramFetchError(error);
    }
  },

  handleActiveProgramFetchError(error) {
    moduleLog("error", "Failed to fetch active programs:", error.message);

    // Check if it's a rate limit error
    if (error.statusCode === 429 || error.message?.includes("429") || error.message?.includes("rate limit")) {
      // Implement exponential backoff: 2 minutes on first hit, doubles up to 10 minutes
      const backoffMinutes = Math.min(2 * Math.pow(2, Math.floor(Math.random() * 3)), 10);
      const backoffMs = backoffMinutes * 60 * 1000;

      globalSession.rateLimitUntil = Date.now() + backoffMs;

      moduleLog("warn", `Rate limit detected - backing off for ${backoffMinutes} minutes`);

      this.broadcastToAllClients("INIT_STATUS", {
        status: "device_error",
        message: `Rate limit detected - wait ${backoffMinutes} minutes`,
        rateLimitSeconds: backoffMinutes * 60
      });

      return;
    }

    // Generic error
    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Error loading programs: ${error.message}`
    });
  },

  clearActiveProgramRetry(haId) {
    const retryState = this.activeProgramRetryTimers.get(haId);
    if (retryState && retryState.timeoutId) {
      clearTimeout(retryState.timeoutId);
    }
    this.activeProgramRetryTimers.delete(haId);
  },

  queueActiveProgramRetries(devices, requestingInstanceId) {
    devices.forEach((device) => {
      if (!device || !device.haId) {
        return;
      }
      const currentState = this.activeProgramRetryTimers.get(device.haId);
      const nextAttempt = (currentState?.attempt || 0) + 1;
      if (nextAttempt > ACTIVE_PROGRAM_MAX_RETRIES) {
        moduleLog("debug", `Max retry attempts reached for ${device.name}`);
        this.activeProgramRetryTimers.delete(device.haId);
        return;
      }
      if (currentState && currentState.timeoutId) {
        moduleLog("debug", `Retry already scheduled for ${device.name} (attempt ${currentState.attempt})`);
        return;
      }
      moduleLog(
        "info",
        `Retrying active program for ${device.name} in ${ACTIVE_PROGRAM_RETRY_DELAY_MS}ms (attempt ${nextAttempt}/${ACTIVE_PROGRAM_MAX_RETRIES})`
      );
      const timeoutId = setTimeout(() => {
        this.executeActiveProgramRetry(device, requestingInstanceId, nextAttempt);
      }, ACTIVE_PROGRAM_RETRY_DELAY_MS);
      this.activeProgramRetryTimers.set(device.haId, {
        attempt: nextAttempt,
        timeoutId,
        instanceId: requestingInstanceId
      });
    });
  },

  async executeActiveProgramRetry(device, requestingInstanceId, attempt) {
    if (!device) {
      return;
    }
    this.activeProgramRetryTimers.set(device.haId, {
      attempt,
      timeoutId: null,
      instanceId: requestingInstanceId
    });

    try {
      moduleLog(
        "debug",
        `Executing active program retry for ${device.name} (attempt ${attempt}/${ACTIVE_PROGRAM_MAX_RETRIES})`
      );
      const result = await this.fetchActiveProgramForDevice(device.haId, device.name);
      moduleLog("debug", `Retry response for ${device.name}:`, {
        success: result.success,
        error: result.error || null
      });

      if (result.success && result.data) {
        this.clearActiveProgramRetry(device.haId);
        const payload = this.applyProgramResult(result);
        if (payload) {
          this.broadcastProgramData({ [result.haId]: payload }, requestingInstanceId);
        }
        return;
      }

      if (attempt < ACTIVE_PROGRAM_MAX_RETRIES && deviceAppearsActive(device)) {
        this.queueActiveProgramRetries([device], requestingInstanceId);
        return;
      }

      this.clearActiveProgramRetry(device.haId);
    } catch (error) {
      moduleLog("error", `Retry fetch failed for ${device.name}:`, error.message || error);
      this.clearActiveProgramRetry(device.haId);
    }
  },

  applyProgramResult(result) {
    const device = this.devices.get(result.haId);
    if (!device || !result.data) {
      return null;
    }

    if (result.data.options) {
      moduleLog(
        "debug",
        `Applying ${result.data.options.length} option update(s) for ${device.name}`
      );
      result.data.options.forEach(option => {
        if (this.hc && typeof this.hc.applyEventToDevice === 'function') {
          this.hc.applyEventToDevice(device, option);
        }
      });
    }

    return {
      name: device.name,
      program: result.data
    };
  },

  broadcastProgramData(programData, requestingInstanceId) {
    const deviceNames = Object.values(programData).map((item) => item.name);
    moduleLog("info", `Active programs fetched: ${deviceNames.length} with data`);
    moduleLog("debug", "Active program payload", {
      devicesWithProgram: deviceNames
    });

    // Broadcast updated device data so RemainingProgramTime/Progress changes are reflected everywhere
    this.broadcastDevices();

    this.broadcastToAllClients("ACTIVE_PROGRAMS_DATA", {
      programs: programData,
      timestamp: Date.now(),
      instanceId: requestingInstanceId
    });
  }

});