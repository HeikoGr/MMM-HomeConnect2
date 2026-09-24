"use strict";

const fs = require("node:fs");
const QRCode = require("qrcode");
const { refreshTokenPath } = require("./module-paths");

const AUTH_REQUEST_TIMEOUT_MS = 15000;

// The OAuth device-flow endpoints used plain fetch() with no timeout, unlike
// the rest of the API client - a hung home-connect.com auth server would
// block the flow indefinitely with no error surfaced to the user.
function fetchWithTimeout(url, options = {}, timeoutMs = AUTH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .catch((error) => {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      if (!aborted) {
        throw error;
      }
      const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    })
    .finally(() => clearTimeout(timeoutId));
}

/**
 * The OAuth endpoints usually answer with JSON, but during outages with plain
 * text ("The request ...") - response.json() would throw on that.
 * @param {Response} response
 * @returns {Promise<{json: object|null, text: string}>}
 */
async function readResponseBody(response) {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return { json: json && typeof json === "object" ? json : null, text };
  } catch {
    return { json: null, text };
  }
}

/**
 * The OAuth server answers with a JSON body ({ error, error_description }).
 * Parsed into one readable line, with the error code kept for the caller.
 * @param {Response} response - A non-ok device authorization response
 * @returns {Promise<Error>} Error with statusCode and oauthError
 */
async function deviceAuthorizationError(response) {
  const { json: body, text } = await readResponseBody(response);
  const oauthError = typeof body?.error === "string" ? body.error : null;
  const parts = oauthError ? [oauthError, body.error_description].filter(Boolean) : [text.trim()].filter(Boolean);
  const error = new Error(
    `Device authorization failed (HTTP ${response.status})${parts.length > 0 ? `: ${parts.join(" - ")}` : ""}`,
  );
  error.statusCode = response.status;
  error.oauthError = oauthError;
  return error;
}

class AuthService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.setModuleLogLevel = options.setModuleLogLevel;
    this.globalSession = options.globalSession;
    this.refreshTokenPath = options.refreshTokenPath || refreshTokenPath;
    this.config = null;
    this.hc = null;
    this.refreshToken = null;
    this.initializationAttempts = 0;
    this.maxInitAttempts = options.maxInitAttempts || 3;
  }

  setConfig(config) {
    this.config = config;
    if (this.setModuleLogLevel) {
      // Without an explicit level, MagicMirror's global logLevel alone decides.
      this.setModuleLogLevel(this.config?.logLevel || this.config?.loglevel);
    }
  }

  // Failures are thrown, not logged: handleHeadlessAuthError reports them once.
  async initiateDeviceFlow(clientId) {
    const response = await fetchWithTimeout("https://api.home-connect.com/security/oauth/device_authorization", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${encodeURIComponent(clientId)}`,
    });

    if (!response.ok) {
      throw await deviceAuthorizationError(response);
    }

    const data = await response.json();
    this.logger.debug("Device authorization response:", data);
    return data;
  }

  handleTokenSuccess(tokens, sendNotification) {
    this.logger.info("Token received successfully");
    if (sendNotification) {
      sendNotification("AUTH_STATUS", {
        status: "success",
        message: "Authentication successful",
      });
    }
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  handleTokenError(error, sendNotification) {
    // Both are regular device-flow states while the user has not confirmed yet,
    // not errors - a warning every poll would only flood the error log.
    if (error?.error === "authorization_pending") {
      this.logger.debug("Waiting for user authorization...");
      return { action: "retry" };
    }

    if (error?.error === "slow_down") {
      this.logger.info("Server requested slower polling");
      return { action: "slow_down" };
    }

    if (error && typeof error === "object") {
      const parts = [];
      if (error.error) {
        parts.push(error.error);
      }
      if (error.error_description) {
        parts.push(error.error_description);
      }
      if (parts.length) {
        this.logger.warn(`Token response error: ${parts.join(" - ")}`);
      } else {
        this.logger.warn("Token response error:", error);
      }
    } else {
      this.logger.warn("Token response error:", error);
    }

    if (error.error === "access_denied") {
      if (sendNotification) {
        sendNotification("AUTH_STATUS", {
          status: "error",
          message: "User denied authorization",
        });
      }
      return {
        action: "error",
        message: "❌ User denied authorization",
      };
    }

    if (error.error === "expired_token") {
      if (sendNotification) {
        sendNotification("AUTH_STATUS", {
          status: "error",
          message: "Device code expired - please restart",
        });
      }
      return {
        action: "error",
        message: "❌ Device code expired - please restart",
      };
    }

    return {
      action: "error",
      message: `Token request failed: ${error.error_description || error.error}`,
    };
  }

  async requestToken(clientId, clientSecret, deviceCode) {
    // Build form body; client_secret is optional (only include if present)
    const params = [
      `grant_type=device_code`,
      `device_code=${encodeURIComponent(deviceCode)}`,
      `client_id=${encodeURIComponent(clientId)}`,
    ];
    if (clientSecret) {
      params.push(`client_secret=${encodeURIComponent(clientSecret)}`);
    }
    const body = params.join("&");

    return fetchWithTimeout("https://api.home-connect.com/security/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  async pollForToken(clientId, clientSecret, deviceCode, interval = 5, maxAttempts = 60, sendNotification) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let currentInterval = Math.max(interval, 5);

      this.logger.debug(`Starting token polling with ${currentInterval}s interval`);

      // Outages of the token endpoint (5xx, 429, plain-text answers, network
      // errors) do not invalidate the device code - the user may be entering it
      // right now. Keep polling and warn once per outage, not on every attempt.
      let transientFailures = 0;
      const retryAfterTransientFailure = (reason) => {
        transientFailures++;
        if (transientFailures === 1) {
          this.logger.warn(`Token endpoint temporarily unavailable (${reason}) - still waiting for authorization`);
        } else {
          this.logger.debug(`Token endpoint still unavailable (${reason}), attempt ${attempts}`);
        }
        setTimeout(poll, currentInterval * 1000);
      };

      const poll = async () => {
        attempts++;
        if (attempts > maxAttempts) {
          reject(new Error(`Token polling timeout after ${maxAttempts} attempts`));
          return;
        }
        try {
          this.logger.debug(`Token polling attempt ${attempts}/${maxAttempts} (interval: ${currentInterval}s)`);
          if (sendNotification) {
            sendNotification("AUTH_STATUS", {
              status: "polling",
              attempt: attempts,
              maxAttempts,
              interval: currentInterval,
              message: `Waiting for authorization... (attempt ${attempts}/${maxAttempts})`,
            });
          }

          const response = await this.requestToken(clientId, clientSecret, deviceCode);
          const { json, text } = await readResponseBody(response);

          if (response.status >= 500 || response.status === 429 || !json) {
            const detail = json?.error_description || json?.error || text.trim().slice(0, 120);
            retryAfterTransientFailure(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
            return;
          }

          if (transientFailures > 0) {
            this.logger.info("Token endpoint reachable again");
            transientFailures = 0;
          }

          if (response.ok) {
            resolve(this.handleTokenSuccess(json, sendNotification));
            return;
          }

          const result = this.handleTokenError(json, sendNotification);

          if (result.action === "retry") {
            setTimeout(poll, currentInterval * 1000);
          } else if (result.action === "slow_down") {
            currentInterval = Math.max(currentInterval + 5, 10);
            this.logger.info(`Polling interval increased to ${currentInterval}s`);
            setTimeout(poll, currentInterval * 1000);
          } else if (result.action === "error") {
            reject(new Error(result.message));
          }
        } catch (fetchError) {
          retryAfterTransientFailure(fetchError?.message || String(fetchError));
        }
      };
      setTimeout(poll, currentInterval * 1000);
    });
  }

  async headlessAuth(sendNotification) {
    if (!this.config) {
      throw new Error("AuthService: config not set");
    }
    const { clientId, clientSecret } = this.config;
    // Failures propagate to handleHeadlessAuthError, which logs them once.
    const deviceAuth = await this.initiateDeviceFlow(clientId);

    const completeLink =
      deviceAuth.verification_uri_complete || `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`;
    const expiresInMinutes = Math.floor(deviceAuth.expires_in / 60);
    // The display shows a QR code; the log gets what works without one - also
    // for a headless setup: the direct link, or the page plus code to type in.
    this.logger.info(
      `Home Connect login required - open ${completeLink} (or ${deviceAuth.verification_uri} and enter code ${deviceAuth.user_code}), valid for ${expiresInMinutes} minutes`,
    );
    let verificationQrSvg = null;
    try {
      verificationQrSvg = await QRCode.toString(completeLink, {
        type: "svg",
        errorCorrectionLevel: "H",
        margin: 1,
      });

      this.logger.debug("QR SVG generated");
    } catch (qrErr) {
      this.logger.error("QR code generation failed:", qrErr.message);
    }

    if (sendNotification) {
      sendNotification("AUTH_INFO", {
        status: "waiting",
        verification_uri: deviceAuth.verification_uri,
        user_code: deviceAuth.user_code,
        verification_qr_svg: verificationQrSvg,
        verification_uri_complete: completeLink,
        expires_in: deviceAuth.expires_in,
        interval: deviceAuth.interval || 5,
        expires_in_minutes: expiresInMinutes,
      });
    }

    const tokens = await this.pollForToken(
      clientId,
      clientSecret,
      deviceAuth.device_code,
      deviceAuth.interval || 5,
      Math.floor(deviceAuth.expires_in / (deviceAuth.interval || 5)),
      sendNotification,
    );

    this.logger.info("Authentication completed successfully");
    return tokens;
  }

  readRefreshTokenFromFile() {
    if (!fs.existsSync(this.refreshTokenPath)) {
      this.logger.debug("No refresh token file found");
      return null;
    }

    try {
      const token = fs.readFileSync(this.refreshTokenPath, "utf8").trim();
      if (token && token.length > 0) {
        this.logger.info("Existing refresh token found - length:", token.length);
        return token;
      }
      this.logger.warn("Refresh token file is empty");
      return null;
    } catch (error) {
      this.logger.error("Could not read refresh token file:", error.message);
      return null;
    }
  }

  initiateAuthFlow() {
    const now = Date.now();
    this.globalSession.lastAuthAttempt = now;

    if (!this.globalSession.refreshToken) {
      this.logger.info("No refresh token available - using headless authentication");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "need_auth",
        message: "Authentication required",
      });
    }
  }
}

module.exports = AuthService;
