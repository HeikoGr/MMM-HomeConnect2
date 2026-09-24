"use strict";

/*
 * Authentication and HomeConnect client initialisation for the shared
 * session: saved token -> init, OAuth device flow (QR code), init retries with
 * backoff, invalid_grant -> re-authentication, token rotation and rate-limit
 * reporting from the API client.
 *
 * A mixin: node_helper.js spreads these methods into its definition. They work
 * on the helper's session state (hc, sessionAuthenticated, authFlowInProgress,
 * retry timers, globalSession) and stay reachable as helper methods, which is
 * what the session tests drive.
 */
const { log } = require("./logger");
const { deleteRefreshTokenFile, persistRefreshToken } = require("./token-store");

let HomeConnect = null;

// Transient init errors (e.g. network/DNS not ready yet right after a device reboot)
// must not strand the session forever - retry with capped exponential backoff.
const HC_INIT_RETRY_BASE_DELAY_MS = 5000; // 5s
const HC_INIT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000; // 5min cap

module.exports = {
  checkRateLimit(targetInstanceId = null) {
    const now = Date.now();
    if (now - this.globalSession.lastAuthAttempt < this.globalSession.MIN_AUTH_INTERVAL) {
      // Never shorten a longer block, e.g. an API 429 with Retry-After.
      this.globalSession.rateLimitUntil = Math.max(
        this.globalSession.rateLimitUntil || 0,
        this.globalSession.lastAuthAttempt + this.globalSession.MIN_AUTH_INTERVAL,
      );
      log.warn("Rate limit: waiting before next auth attempt");
      this.emitInitStatus(
        "rate_limited",
        targetInstanceId
          ? {
              instanceId: targetInstanceId,
            }
          : {},
        targetInstanceId ? { broadcast: false, targetInstanceId } : {},
      );
      return false;
    }
    // rateLimitUntil is left alone: it may hold an API 429 block (Retry-After),
    // which the auth throttle must not lift.
    return true;
  },

  initiateAuthFlow() {
    this.authService.initiateAuthFlow();
    if (!this.globalSession.refreshToken) {
      this.initWithHeadlessAuth();
    }
  },

  checkTokenAndInitialize(targetInstanceId = null) {
    const token = this.authService.readRefreshTokenFromFile();

    if (token) {
      log.info("Using saved refresh token - initializing HomeConnect");
      this.globalSession.refreshToken = token;
      this.refreshToken = token;

      this.emitInitStatus(
        "token_found",
        targetInstanceId
          ? {
              instanceId: targetInstanceId,
            }
          : {},
        targetInstanceId ? { broadcast: false, targetInstanceId } : {},
      );

      this.initializeHomeConnect(token).catch(() => {
        // Handled by handleHomeConnectInitError, which schedules the retry.
      });
      return;
    }

    if (!this.checkRateLimit(targetInstanceId)) {
      return;
    }

    this.initiateAuthFlow();
  },

  handleHeadlessAuthSuccess(tokens) {
    persistRefreshToken(tokens.refresh_token);

    this.globalSession.refreshToken = tokens.refresh_token;
    this.globalSession.accessToken = tokens.access_token;

    this.emitInitStatus("initializing_hc");

    return this.initializeHomeConnect(tokens.refresh_token);
  },

  handleHeadlessAuthError(error) {
    this.authFlowInProgress = false;
    log.error("Headless authentication failed:", error.message);

    this.emitAuthStatus("error", {
      message: `Authentication failed: ${error.message}`,
    });

    if (error.message.includes("polling too quickly")) {
      log.info("Rate limiting detected - will not retry automatically");
      this.emitInitStatus("rate_limited", {
        message: "Rate limit reached - please restart in 2 minutes",
      });
      return;
    }

    if (this.initializationAttempts < this.maxInitAttempts) {
      log.info(
        `Retrying headless authentication in 30 seconds (${this.initializationAttempts}/${this.maxInitAttempts})`,
      );
      this.headlessAuthRetryTimer = setTimeout(() => {
        this.headlessAuthRetryTimer = null;
        if (!this.hc) {
          this.initWithHeadlessAuth();
        }
      }, 30 * 1000);
      return;
    }

    log.error("Max initialization attempts reached - aborting headless authentication");
    this.emitInitStatus("auth_failed");
  },

  async initWithHeadlessAuth() {
    if (this.authFlowInProgress) {
      log.warn("Authentication already in progress, skipping...");
      return;
    }

    this.authFlowInProgress = true;
    this.initializationAttempts++;

    log.info(`Starting headless authentication (attempt ${this.initializationAttempts}/${this.maxInitAttempts})`);

    let tokens;
    try {
      tokens = await this.authService.headlessAuth((notification, payload) => {
        if (notification === "AUTH_STATUS") {
          const status = payload?.status ? payload.status : "error";
          this.emitAuthStatus(status, payload || {});
          return;
        }

        this.broadcastToAllClients(notification, payload);
      });
    } catch (error) {
      this.handleHeadlessAuthError(error);
      return;
    }

    // The device flow succeeded, so an init failure from here on is not an auth
    // failure: handleHomeConnectInitError owns it and schedules its own retry.
    await this.handleHeadlessAuthSuccess(tokens).catch(() => {});
  },

  handleHomeConnectInitSuccess() {
    log.info("HomeConnect initialized successfully");

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
        forcePrograms: false,
      });
    }
  },

  handleHomeConnectInitError(error) {
    log.error("HomeConnect initialization failed:", error);
    this.authFlowInProgress = false;
    this.sessionAuthenticated = false;

    const errorMessage = error?.message ? error.message : String(error || "");
    const normalizedMsg = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
    const invalidGrantDetected = normalizedMsg.includes("invalid_grant");

    if (invalidGrantDetected) {
      log.warn("HomeConnect init got invalid_grant; starting re-authentication");

      this.emitInitStatus("reauth_required");

      this.emitAuthStatus("token_invalid");

      deleteRefreshTokenFile();

      this.globalSession.refreshToken = null;
      this.globalSession.accessToken = null;
      this.refreshToken = null;
      this.hc = null;

      // Reset attempts so a fresh authentication cycle can proceed without hitting attempt limits.
      this.initializationAttempts = 0;
      this.clearHomeConnectInitRetry();
      this.globalSession.lastAuthAttempt = 0;
      this.setRateLimitUntil(0);

      // Start a fresh headless authentication flow (shows QR code on clients)
      this.invalidGrantRetryTimer = setTimeout(() => {
        this.invalidGrantRetryTimer = null;
        if (!this.authFlowInProgress) {
          this.initWithHeadlessAuth();
        }
      }, 1500);

      return;
    }

    // Not an invalid_grant - most likely a transient failure (e.g. network/DNS not
    // ready yet right after a device reboot). The refresh token itself is probably
    // still fine, so retry the same init with backoff instead of stranding the
    // session in ERROR forever.
    const retryDelayMs = this.scheduleHomeConnectInitRetry();

    // The retry delay lets the frontend say "retrying in ..." instead of spinning
    // on "Loading appliances" through a multi-minute backoff.
    this.emitInitStatus("hc_error", {
      message: `HomeConnect error: ${errorMessage}`,
      retryInSeconds: retryDelayMs === null ? null : Math.round(retryDelayMs / 1000),
    });
  },

  // Returns the delay of the scheduled retry in ms, or null when none is pending.
  scheduleHomeConnectInitRetry() {
    const token = this.globalSession.refreshToken || this.refreshToken;
    if (!token) {
      log.debug("No refresh token available - skipping automatic HomeConnect init retry");
      return null;
    }

    if (this.hcInitRetryTimer) {
      return null;
    }

    const attempt = this.hcInitRetryAttempts;
    const delay = Math.min(HC_INIT_RETRY_BASE_DELAY_MS * 2 ** attempt, HC_INIT_RETRY_MAX_DELAY_MS);
    this.hcInitRetryAttempts = attempt + 1;

    log.info(
      `Scheduling HomeConnect init retry in ${Math.round(delay / 1000)}s (attempt ${this.hcInitRetryAttempts}) after transient error`,
    );

    this.hcInitRetryTimer = setTimeout(() => {
      this.hcInitRetryTimer = null;

      if (this.sessionAuthenticated) {
        return;
      }

      this.initializeHomeConnect(token).catch(() => {
        // Failure is already handled inside initializeHomeConnect via
        // handleHomeConnectInitError, which schedules the next retry.
      });
    }, delay);

    return delay;
  },

  clearHomeConnectInitRetry() {
    if (this.hcInitRetryTimer) {
      clearTimeout(this.hcInitRetryTimer);
      this.hcInitRetryTimer = null;
    }
    this.hcInitRetryAttempts = 0;
  },

  // The API client reports 429s it hits on its own (token endpoint, SSE
  // channels) - those never pass through the REST wrappers, so without this the
  // REST side would keep spending quota during a penalty window it cannot see.
  setupHomeConnectRateLimitReporting() {
    this.hc.on("rateLimit", ({ source, retryAfterSeconds } = {}) => {
      const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) : 300;
      const until = Date.now() + seconds * 1000;
      if (until <= this.getRateLimitUntil()) {
        return;
      }
      this.setRateLimitUntil(until);
      log.warn(`Rate limit reported by ${source || "api client"} - backing off ${seconds}s`);
      this.emitInitStatus("device_error", {
        message: `Rate limit detected - wait ${seconds}s`,
        rateLimitSeconds: seconds,
        statusCode: 429,
        isRateLimit: true,
      });
    });
  },

  setupHomeConnectRefreshToken() {
    this.hc.on("newRefreshToken", (refreshToken) => {
      persistRefreshToken(refreshToken);
      this.globalSession.refreshToken = refreshToken;
      if (this.deviceService && typeof this.deviceService.noteTokenRefreshed === "function") {
        this.deviceService.noteTokenRefreshed();
      }
      if (this.deviceService?.subscribed) {
        log.info("Token updated post-init - SSE session remains authoritative");
      } else {
        log.info("Token updated during initialization");
      }
    });
  },

  async initializeHomeConnect(refreshToken) {
    return new Promise((resolve, reject) => {
      log.info("Initializing HomeConnect with token...");
      this.authFlowInProgress = true;
      if (!HomeConnect) {
        HomeConnect = require("./homeconnect-api.js");
      }
      const hc = new HomeConnect(this.config.clientId, this.config.clientSecret, refreshToken, {
        acceptLanguage: this.config.apiLanguage,
        requestTimeoutMs: this.config.apiRequestTimeoutMs,
        logger: log,
      });
      this.hc = hc;

      // attach client to services
      if (this.deviceService) {
        this.deviceService.attachClient(hc);
      }
      if (this.programService) {
        this.programService.attachClient(hc);
      }

      // Exactly one of timeout, success and failure decides this attempt.
      let decided = false;
      const decide = () => {
        if (decided) {
          return false;
        }
        decided = true;
        clearTimeout(initTimeout);
        return true;
      };

      const timeoutMs = this.hcInitTimeoutMs;
      const initTimeout = setTimeout(() => {
        if (!decide()) {
          return;
        }
        const error = new Error(`HomeConnect initialization timeout after ${Math.round(timeoutMs / 1000)}s`);
        // The same path as any failed init: the displays get hc_error with the
        // retry delay, and a retry with backoff is scheduled. Before, a timeout
        // only rejected - no status, no retry.
        this.handleHomeConnectInitError(error);
        reject(error);
      }, timeoutMs);

      hc.init({
        isSimulated: false,
      })
        .then(() => {
          if (decide()) {
            this.handleHomeConnectInitSuccess();
            resolve();
            return;
          }
          // Finished after its timeout. Still useful while no retry replaced it;
          // otherwise it is an orphan and must not keep timers or streams.
          if (this.hc === hc && !this.sessionAuthenticated) {
            log.info("HomeConnect initialization finished after its timeout");
            this.handleHomeConnectInitSuccess();
          } else if (this.hc !== hc) {
            hc.destroy?.();
          }
        })
        .catch((error) => {
          if (decide()) {
            this.handleHomeConnectInitError(error);
            reject(error);
            return;
          }
          // Already reported by the timeout.
          if (this.hc !== hc) {
            hc.destroy?.();
          }
        });

      this.setupHomeConnectRefreshToken();
      this.setupHomeConnectRateLimitReporting();
    });
  },
};
