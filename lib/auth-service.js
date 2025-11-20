"use strict";

const fs = require("fs");
const QRCode = require("qrcode");

class AuthService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.setModuleLogLevel = options.setModuleLogLevel;
    this.globalSession = options.globalSession;
    this.config = null;
    this.hc = null;
    this.refreshToken = null;
    this.initializationAttempts = 0;
    this.maxInitAttempts = options.maxInitAttempts || 3;
  }

  setConfig(config) {
    this.config = config;
    if (this.setModuleLogLevel) {
      this.setModuleLogLevel(
        this.config?.logLevel || this.config?.loglevel || "none"
      );
    }
  }

  async initiateDeviceFlow(clientId) {
    const { fetch } = require("undici");
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
      this.logger("debug", "Device authorization response:", data);
      return data;
    } catch (error) {
      this.logger("error", "Device flow initiation failed:", error);
      throw error;
    }
  }

  handleTokenSuccess(tokens, sendNotification) {
    this.logger("info", "Token received successfully");
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

  handleTokenError(error, sendNotification) {
    this.logger("warn", "Token response error:", error);

    if (error.error === "authorization_pending") {
      this.logger("info", "Waiting for user authorization...");
      return { action: "retry" };
    }

    if (error.error === "slow_down") {
      this.logger("info", "Server requested slower polling");
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

    return {
      action: "error",
      message: `Token request failed: ${error.error_description || error.error}`
    };
  }

  async requestToken(clientId, clientSecret, deviceCode) {
    const { fetch } = require("undici");
    // Build form body; client_secret is optional (only include if present)
    const params = [
      `grant_type=device_code`,
      `device_code=${encodeURIComponent(deviceCode)}`,
      `client_id=${encodeURIComponent(clientId)}`
    ];
    if (clientSecret) {
      params.push(`client_secret=${encodeURIComponent(clientSecret)}`);
    }
    const body = params.join("&");

    return fetch("https://api.home-connect.com/security/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  }

  async pollForToken(
    clientId,
    clientSecret,
    deviceCode,
    interval = 5,
    maxAttempts = 60,
    sendNotification
  ) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let currentInterval = Math.max(interval, 5);

      this.logger(
        "info",
        `Starting token polling with ${currentInterval}s interval...`
      );
      const poll = async () => {
        attempts++;
        if (attempts > maxAttempts) {
          reject(
            new Error(`Token polling timeout after ${maxAttempts} attempts`)
          );
          return;
        }
        try {
          this.logger(
            "debug",
            `Token polling attempt ${attempts}/${maxAttempts} (interval: ${currentInterval}s)`
          );
          if (sendNotification) {
            sendNotification("AUTH_STATUS", {
              status: "polling",
              attempt: attempts,
              maxAttempts,
              interval: currentInterval,
              message: `Waiting for authorization... (attempt ${attempts}/${maxAttempts})`
            });
          }

          const response = await this.requestToken(
            clientId,
            clientSecret,
            deviceCode
          );

          if (response.ok) {
            const tokens = await response.json();
            resolve(this.handleTokenSuccess(tokens, sendNotification));
            return;
          }

          const error = await response.json();
          const result = this.handleTokenError(error, sendNotification);

          if (result.action === "retry") {
            setTimeout(poll, currentInterval * 1000);
          } else if (result.action === "slow_down") {
            currentInterval = Math.max(currentInterval + 5, 10);
            this.logger(
              "info",
              `Polling interval increased to ${currentInterval}s`
            );
            setTimeout(poll, currentInterval * 1000);
          } else if (result.action === "error") {
            reject(new Error(result.message));
          }
        } catch (fetchError) {
          this.logger(
            "error",
            "Network error during token polling:",
            fetchError
          );
          setTimeout(poll, currentInterval * 1000);
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
    try {
      this.logger("info", "Starting headless authentication (Device Flow)");
      const deviceAuth = await this.initiateDeviceFlow(clientId);

      this.logger("info", "HOME CONNECT AUTHENTICATION");
      this.logger(
        "info",
        "Open the following URL on any device:",
        deviceAuth.verification_uri
      );
      this.logger("info", "User code:", deviceAuth.user_code);

      const completeLink =
        deviceAuth.verification_uri_complete ||
        `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`;
      this.logger(
        "info",
        "Scan the QR code with your phone to open the verification link"
      );
      let verificationQrSvg = null;
      try {
        verificationQrSvg = await QRCode.toString(completeLink, {
          type: "svg",
          errorCorrectionLevel: "H",
          margin: 1
        });

        this.logger("debug", "QR SVG generated");
      } catch (qrErr) {
        this.logger("error", "QR code generation failed:", qrErr.message);
        this.logger("info", "Direct link:", completeLink);
      }
      this.logger(
        "info",
        `Code expires in: ${Math.floor(deviceAuth.expires_in / 60)} minutes`
      );
      this.logger(
        "info",
        `Polling interval: ${deviceAuth.interval || 5} seconds`
      );

      if (sendNotification) {
        sendNotification("AUTH_INFO", {
          status: "waiting",
          verification_uri: deviceAuth.verification_uri,
          user_code: deviceAuth.user_code,
          verification_qr_svg: verificationQrSvg,
          verification_uri_complete: completeLink,
          expires_in: deviceAuth.expires_in,
          interval: deviceAuth.interval || 5,
          expires_in_minutes: Math.floor(deviceAuth.expires_in / 60)
        });
      }

      const tokens = await this.pollForToken(
        clientId,
        clientSecret,
        deviceAuth.device_code,
        deviceAuth.interval || 5,
        Math.floor(deviceAuth.expires_in / (deviceAuth.interval || 5)),
        sendNotification
      );

      this.logger("info", "Authentication completed successfully");
      return tokens;
    } catch (error) {
      this.logger("error", "Headless authentication failed:", error.message);
      throw error;
    }
  }

  readRefreshTokenFromFile() {
    if (!fs.existsSync("./modules/MMM-HomeConnect2/refresh_token.json")) {
      this.logger("debug", "No refresh token file found");
      return null;
    }

    try {
      const token = fs
        .readFileSync("./modules/MMM-HomeConnect2/refresh_token.json", "utf8")
        .trim();
      if (token && token.length > 0) {
        this.logger(
          "info",
          "Existing refresh token found - length:",
          token.length
        );
        return token;
      }
      this.logger("warn", "Refresh token file is empty");
      return null;
    } catch (error) {
      this.logger("error", "Could not read refresh token file:", error.message);
      return null;
    }
  }

  checkRateLimit() {
    const now = Date.now();
    if (
      now - this.globalSession.lastAuthAttempt <
      this.globalSession.MIN_AUTH_INTERVAL
    ) {
      this.logger("warn", "Rate limit: waiting before next auth attempt");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate limit - please wait..."
      });
      return false;
    }
    return true;
  }

  initiateAuthFlow() {
    const now = Date.now();
    this.globalSession.lastAuthAttempt = now;

    if (
      !this.globalSession.isAuthenticating &&
      !this.globalSession.refreshToken
    ) {
      this.logger(
        "info",
        "No refresh token available - using headless authentication"
      );
      this.broadcastToAllClients("INIT_STATUS", {
        status: "need_auth",
        message: "Authentication required"
      });
    }
  }
}

module.exports = AuthService;
