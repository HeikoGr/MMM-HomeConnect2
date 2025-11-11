let HomeConnect;
const fs = require("fs");
const NodeHelper = require("node_helper");
// use built-in fetch when available
const fetch = typeof globalThis.fetch === "function"
  ? globalThis.fetch.bind(globalThis)
  : null;
const QRCode = require("qrcode");

const globalSession = {
  isAuthenticated: false,
  isAuthenticating: false,
  accessToken: null,
  refreshToken: null,
  clientInstances: new Set(),
  lastAuthAttempt: 0,
  MIN_AUTH_INTERVAL: 60000
};

async function initiateDeviceFlow (clientId) {
  try {
    const response = await fetch(
      "https://api.home-connect.com/security/oauth/device_authorization",
      {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: `client_id=${clientId}`
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Device authorization failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log("Device authorization response:", data);
    return data;
  } catch (error) {
    console.error("Device flow initiation failed:", error);
    throw error;
  }
}

function handleTokenSuccess (tokens, sendNotification) {
  console.log("✅ Token received successfully!");
  if (sendNotification) {
    sendNotification("AUTH_STATUS", {
      status: "success",
      message: "Authentifizierung erfolgreich!"
    });
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function handleTokenError (error, sendNotification) {
  console.log("Token response error:", error);

  if (error.error === "authorization_pending") {
    console.log("⏳ Waiting for user authorization...");
    return {action: "retry"};
  }

  if (error.error === "slow_down") {
    console.log("⚠️ Slowing down polling interval");
    return {action: "slow_down"};
  }

  if (error.error === "access_denied") {
    if (sendNotification) {
      sendNotification("AUTH_STATUS", {
        status: "error",
        message: "Benutzer hat Autorisierung verweigert"
      });
    }
    return {action: "error", message: "❌ User denied authorization"};
  }

  if (error.error === "expired_token") {
    if (sendNotification) {
      sendNotification("AUTH_STATUS", {
        status: "error",
        message: "Autorisierungscode abgelaufen - bitte neu starten"
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

async function requestToken (clientId, clientSecret, deviceCode) {
  return fetch("https://api.home-connect.com/security/oauth/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: `grant_type=device_code&device_code=${deviceCode}&client_id=${clientId}&client_secret=${clientSecret}`
  });
}

async function pollForToken (
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

    console.log(`Starting token polling with ${currentInterval}s interval...`);
    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        reject(new Error(`Token polling timeout after ${maxAttempts} attempts`));
        return;
      }
      try {
        console.log(`Token polling attempt ${attempts}/${maxAttempts} (interval: ${currentInterval}s)`);
        if (sendNotification) {
          sendNotification("AUTH_STATUS", {
            status: "polling",
            attempt: attempts,
            maxAttempts,
            interval: currentInterval,
            message: `Warten auf Autorisierung... (Versuch ${attempts}/${maxAttempts})`
          });
        }

        const response = await requestToken(clientId, clientSecret, deviceCode);

        if (response.ok) {
          const tokens = await response.json();
          resolve(handleTokenSuccess(tokens, sendNotification));
          return;
        }

        const error = await response.json();
        const result = handleTokenError(error, sendNotification);

        if (result.action === "retry") {
          setTimeout(poll, currentInterval * 1000);
        } else if (result.action === "slow_down") {
          currentInterval = Math.max(currentInterval + 5, 10);
          console.log(`Polling interval increased to ${currentInterval}s`);
          setTimeout(poll, currentInterval * 1000);
        } else if (result.action === "error") {
          reject(new Error(result.message));
        }
      } catch (fetchError) {
        console.error("Network error during token polling:", fetchError);
        setTimeout(poll, currentInterval * 1000);
      }
    };
    setTimeout(poll, currentInterval * 1000);
  });
}

async function headlessAuth (clientId, clientSecret, sendNotification) {
  try {
    console.log("🚀 Starting headless authentication using Device Flow...");
    const deviceAuth = await initiateDeviceFlow(clientId);

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║ HOME CONNECT AUTHENTICATION ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");
    console.log("📱 Bitte öffnen Sie in einem Browser auf einem beliebigen Gerät:");
    console.log(`🌐 URL: ${deviceAuth.verification_uri}`);
    console.log("");
    console.log("🔑 Geben Sie dort folgenden Code ein:");
    console.log(`📋 CODE: ${deviceAuth.user_code}`);
    console.log("");

    /*
     * Instead of printing the direct link, generate an SVG QR code for the
     * verification link so users can scan it with their phone.
     */
    const completeLink =
      deviceAuth.verification_uri_complete ||
      `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`;
    console.log("🔗 Scan diesen QR-Code mit deinem Handy, um die Seite zu öffnen:");
    let verificationQrSvg = null;
    try {
      verificationQrSvg = await QRCode.toString(completeLink, {
        type: "svg",
        errorCorrectionLevel: "H",
        margin: 1
      });

      /*
       * print the raw SVG to the console so headless setups (with a UI) can
       * capture or display it if needed.
       */
      console.log(verificationQrSvg);
    } catch (qrErr) {
      console.error("❌ QR-Code Generierung fehlgeschlagen:", qrErr.message);
      // Fallback: print the direct link
      console.log("Direct link:", completeLink);
    }
    console.log("");
    console.log(`⏱️ Code läuft ab in: ${Math.floor(deviceAuth.expires_in / 60)} Minuten`);
    console.log(`🔄 Polling-Intervall: ${deviceAuth.interval || 5} Sekunden`);
    console.log("");

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

    console.log("✅ Authentifizierung erfolgreich abgeschlossen!");
    return tokens;
  } catch (error) {
    console.error("❌ Headless authentication failed:", error.message);
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

  init () {
    console.log("init module helper: MMM-HomeConnect (Session-Based Version)");
  },

  start () {
    console.log(`Starting module helper: ${this.name}`);
  },

  stop () {
    console.log(`Stopping module helper: ${this.name}`);
  },

  handleConfigNotificationFirstTime () {
    this.configReceived = true;
    console.log("🔧 use_headless_auth:", this.config.use_headless_auth);

    if (globalSession.isAuthenticated) {
      return this.handleSessionAlreadyActive();
    }

    if (globalSession.isAuthenticating) {
      return this.notifyAuthInProgress();
    }

    this.sendSocketNotification("INIT_STATUS", {
      status: "initializing",
      message: "Initialisierung gestartet...",
      instanceId: this.instanceId
    });

    this.checkTokenAndInitialize();
  },

  handleSessionAlreadyActive () {
    console.log("✅ Session bereits authentifiziert - verwende bestehende Token");
    this.sendSocketNotification("INIT_STATUS", {
      status: "session_active",
      message: "Session aktiv - verwende bestehende Authentifizierung",
      instanceId: this.instanceId
    });

    if (this.hc) {
      setTimeout(() => {
        this.getDevices();
      }, 1000);
    }
  },

  notifyAuthInProgress () {
    console.log("⏳ Authentifizierung bereits im Gange für andere Client-Instanz");
    this.sendSocketNotification("INIT_STATUS", {
      status: "auth_in_progress",
      message: "Authentifizierung läuft bereits...",
      instanceId: this.instanceId
    });
  },

  handleConfigNotificationSubsequent () {
    if (globalSession.isAuthenticated && this.hc) {
      this.sendSocketNotification("INIT_STATUS", {
        status: "complete",
        message: "Bereits initialisiert",
        instanceId: this.instanceId
      });

      setTimeout(() => {
        this.broadcastDevices();
      }, 500);
    } else if (globalSession.isAuthenticating) {
      this.notifyAuthInProgress();
    }
  },

  handleConfigNotification (payload) {
    this.instanceId = payload.instanceId || "default";
    globalSession.clientInstances.add(this.instanceId);

    console.log(`📋 Processing CONFIG notification for instance: ${this.instanceId}`);
    console.log(`🔧 Registered clients: ${globalSession.clientInstances.size}`);

    if (!this.configReceived) {
      this.config = payload;
      this.handleConfigNotificationFirstTime();
    } else {
      this.handleConfigNotificationSubsequent();
    }
  },

  handleUpdateRequest () {
    if (this.hc && !globalSession.isAuthenticating) {
      console.log("📡 Update request received - fetching devices");
      this.getDevices();
    } else {
      console.log("⚠️ Update request ignored - HC not ready or auth in progress");
    }
  },

  handleRetryAuth () {
    console.log("🔄 Manual retry requested...");
    this.retryAuthentication();
  },

  socketNotificationReceived (notification, payload) {
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
    }
  },

  broadcastToAllClients (notification, payload) {
    globalSession.clientInstances.forEach((instanceId) => {
      this.sendSocketNotification(notification, {
        ...payload,
        instanceId
      });
    });
  },

  readRefreshTokenFromFile () {
    if (!fs.existsSync("./modules/MMM-HomeConnect/refresh_token.json")) {
      console.log("📄 No refresh token file found");
      return null;
    }

    try {
      const token = fs
        .readFileSync("./modules/MMM-HomeConnect/refresh_token.json", "utf8")
        .trim();

      if (token && token.length > 0) {
        console.log("📄 Existing refresh token found - length:", token.length);
        return token;
      }
      console.log("⚠️ Refresh token file is empty");
      return null;
    } catch (error) {
      console.log("⚠️ Could not read refresh token file:", error.message);
      return null;
    }
  },

  checkRateLimit () {
    const now = Date.now();
    if (now - globalSession.lastAuthAttempt < globalSession.MIN_AUTH_INTERVAL) {
      console.log("⚠️ Rate limit: Warten vor nächstem Auth-Versuch");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate Limit - bitte warten..."
      });
      return false;
    }
    return true;
  },

  initiateAuthFlow () {
    const now = Date.now();
    globalSession.lastAuthAttempt = now;

    /*
     * Only headless/device flow is supported. Always use headless if there is
     * no refresh token available.
     */
    if (!globalSession.isAuthenticating && !globalSession.refreshToken) {
      console.log("🔧 No refresh token available - using headless authentication");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "need_auth",
        message: "Authentifizierung erforderlich"
      });
      this.initWithHeadlessAuth();
    }
  },

  checkTokenAndInitialize () {
    console.log("🔍 Checking for existing refresh token...");

    const token = this.readRefreshTokenFromFile();

    if (token) {
      console.log("🔧 Using saved refresh token - initializing HomeConnect");
      globalSession.refreshToken = token;
      this.refreshToken = token;

      this.broadcastToAllClients("INIT_STATUS", {
        status: "token_found",
        message: "Token gefunden - initialisiere HomeConnect"
      });

      this.initializeHomeConnect(token);
      return;
    }

    if (!this.checkRateLimit()) {
      return;
    }

    this.initiateAuthFlow();
  },

  handleHeadlessAuthSuccess (tokens) {
    fs.writeFileSync(
      "./modules/MMM-HomeConnect/refresh_token.json",
      tokens.refresh_token
    );
    console.log("💾 Refresh token saved successfully");

    globalSession.refreshToken = tokens.refresh_token;
    globalSession.accessToken = tokens.access_token;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "initializing_hc",
      message: "HomeConnect wird initialisiert..."
    });

    return this.initializeHomeConnect(tokens.refresh_token);
  },

  handleHeadlessAuthError (error) {
    globalSession.isAuthenticating = false;
    console.error("❌ Headless authentication failed:", error.message);

    this.broadcastToAllClients("AUTH_STATUS", {
      status: "error",
      message: `Authentifizierung fehlgeschlagen: ${error.message}`
    });

    if (error.message.includes("polling too quickly")) {
      console.log("💡 Rate limiting detected - will not retry automatically");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate Limit erreicht - bitte in 2 Minuten neu starten"
      });
      return;
    }

    if (this.initializationAttempts < this.maxInitAttempts) {
      console.log(`🔄 Will retry in 30 seconds (${this.initializationAttempts}/${this.maxInitAttempts})`);
      setTimeout(() => {
        if (!this.hc) {
          this.initWithHeadlessAuth();
        }
      }, 30000);
      return;
    }

    console.log("❌ Max initialization attempts reached - aborting headless authentication");
    this.broadcastToAllClients("INIT_STATUS", {
      status: "auth_failed",
      message: "Authentifizierung fehlgeschlagen - bitte manuell überprüfen"
    });
  },

  async initWithHeadlessAuth () {
    if (globalSession.isAuthenticating) {
      console.log("⚠️ Authentication already in progress, skipping...");
      return;
    }

    globalSession.isAuthenticating = true;
    this.initializationAttempts++;

    console.log(`🚀 Starting headless authentication (attempt ${this.initializationAttempts}/${this.maxInitAttempts})`);

    try {
      const _self = this;

      const tokens = await headlessAuth(
        this.config.client_ID,
        this.config.client_Secret,
        (notification, payload) => _self.broadcastToAllClients(notification, payload)
      );

      await this.handleHeadlessAuthSuccess(tokens);
    } catch (error) {
      this.handleHeadlessAuthError(error);
    }
  },

  handleHomeConnectInitSuccess () {
    console.log("✅ HomeConnect initialized successfully");

    globalSession.isAuthenticated = true;
    globalSession.isAuthenticating = false;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "success",
      message: "Erfolgreich initialisiert"
    });

    setTimeout(() => {
      this.getDevices();
    }, 2000);
  },

  handleHomeConnectInitError (error) {
    console.error("❌ HomeConnect initialization failed:", error);
    globalSession.isAuthenticating = false;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "hc_error",
      message: `HomeConnect Fehler: ${error.message}`
    });
  },

  setupHomeConnectRefreshToken () {
    this.hc.on("newRefreshToken", (refreshToken) => {
      fs.writeFileSync(
        "./modules/MMM-HomeConnect/refresh_token.json",
        refreshToken
      );
      console.log("🔄 Refresh token updated");
      globalSession.refreshToken = refreshToken;
      // Only fetch devices if not yet subscribed (initial setup)
      if (!this.subscribed) {
        this.getDevices();
      } else {
        console.log("ℹ️ Token updated - devices already loaded, skipping getDevices()");
      }
    });
  },

  async initializeHomeConnect (refreshToken) {
    return new Promise((resolve, reject) => {
      console.log("🏠 Initializing HomeConnect with token...");
      if (!HomeConnect) {
        HomeConnect = require("./home-connect-js.js");
      }
      this.hc = new HomeConnect(
        this.config.client_ID,
        this.config.client_Secret,
        refreshToken
      );

      const initTimeout = setTimeout(() => {
        console.error("⏰ HomeConnect initialization timeout");
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


  fetchDeviceStatus (device) {
    this.hc
      .command("status", "get_status", device.haId)
      .then((statusResult) => {
        console.log(`📊 Status received for ${device.name}`);
        statusResult.body.data.status.forEach((event) => {
          this.parseEvent(event, device);
        });
        this.broadcastDevices();
      })
      .catch((error) => console.error(`❌ Status error for ${device.name}:`, error));
  },

  fetchDeviceSettings (device) {
    this.hc
      .command("settings", "get_settings", device.haId)
      .then((settingsResult) => {
        console.log(`⚙️ Settings received for ${device.name}`);
        settingsResult.body.data.settings.forEach((event) => {
          this.parseEvent(event, device);
        });
        this.broadcastDevices();
      })
      .catch((error) => console.error(`❌ Settings error for ${device.name}:`, error));
  },

  processDevice (device, index) {
    console.log(`📱 Processing device ${index + 1}: ${device.name} (${device.haId})`);
    this.devices.set(device.haId, device);

    if (device.connected === true) {
      console.log(`🔗 Device ${device.name} is connected - fetching status`);
      this.fetchDeviceStatus(device);
      this.fetchDeviceSettings(device);
    } else {
      console.log(`⚠️ Device ${device.name} is not connected`);
    }
  },

  subscribeToDeviceEvents () {
    if (!this.subscribed) {
      console.log("📡 Subscribing to device events...");
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
      console.log("✅ Event subscriptions established");
    } else {
      console.log("ℹ️ Already subscribed to device events - skipping duplicate subscription");
    }
  },

  sortDevices () {
    const array = [...this.devices.entries()];
    const sortedArray = array.sort((a, b) => a[1].name > b[1].name ? 1 : -1);
    this.devices = new Map(sortedArray);
  },

  handleGetDevicesSuccess (result) {
    console.log(`✅ API Response received - Found ${result.body.data.homeappliances.length} appliances`);

    if (result.body.data.homeappliances.length === 0) {
      console.log("⚠️ No appliances found - check Home Connect app");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "no_devices",
        message: "Keine Geräte gefunden - Home Connect App prüfen"
      });
    }

    result.body.data.homeappliances.forEach((device, index) => {
      this.processDevice(device, index);
    });

    this.subscribeToDeviceEvents();
    this.sortDevices();

    console.log("✅ Device processing complete - broadcasting to frontend");
    this.broadcastDevices();

    this.broadcastToAllClients("INIT_STATUS", {
      status: "complete",
      message: `${result.body.data.homeappliances.length} Gerät(e) geladen`
    });
  },

  handleGetDevicesError (error) {
    console.error("❌ Failed to get devices:", error && error.stack
      ? error.stack
      : error);

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Geräte-Fehler: ${error.message}`
    });

    if (error.message.includes("fetch") || error.message.includes("network")) {
      console.log("🔄 Network error detected - retrying in 30 seconds");
      setTimeout(() => {
        this.getDevices();
      }, 30000);
    }
  },

  getDevices () {
    if (!this.hc) {
      console.error("❌ HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect nicht bereit"
      });
      return;
    }

    console.log("📱 Fetching devices from Home Connect API...");

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Geräte werden geladen..."
    });

    this.hc
      .command("appliances", "get_home_appliances")
      .then((result) => this.handleGetDevicesSuccess(result))
      .catch((error) => this.handleGetDevicesError(error));
  },

  retryAuthentication () {
    console.log("🔄 Manual authentication retry...");
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

    if (fs.existsSync("./modules/MMM-HomeConnect/refresh_token.json")) {
      fs.unlinkSync("./modules/MMM-HomeConnect/refresh_token.json");
      console.log("🗑️ Old token file deleted");
    }

    this.refreshToken = null;

    this.checkTokenAndInitialize();
  },

  deviceEvent (data) {
    const _self = this;
    try {
      const eventObj = JSON.parse(data.data);
      eventObj.items.forEach((item) => {
        if (item.uri) {
          const haId = item.uri.split("/")[3];
          _self.parseEvent(item, _self.devices.get(haId));
        }
      });
      _self.broadcastDevices();
    } catch (error) {
      console.error("Error processing device event:", error);
    }
  },

  parseRemainingProgramTime (device, value) {
    device.RemainingProgramTime = value;
  },

  parseProgramProgress (device, value) {
    device.ProgramProgress = value;
  },

  parseOperationState (device, value) {
    if (value === "BSH.Common.EnumType.OperationState.Finished") {
      device.RemainingProgramTime = 0;
    }
  },

  parseLighting (device, value) {
    device.Lighting = value;
  },

  parsePowerState (device, value) {
    const powerStateMap = {
      "BSH.Common.EnumType.PowerState.On": "On",
      "BSH.Common.EnumType.PowerState.Standby": "Standby",
      "BSH.Common.EnumType.PowerState.Off": "Off"
    };
    device.PowerState = powerStateMap[value];
  },

  parseDoorState (device, value) {
    const doorStateMap = {
      "BSH.Common.EnumType.DoorState.Open": "Open",
      "BSH.Common.EnumType.DoorState.Closed": "Closed",
      "BSH.Common.EnumType.DoorState.Locked": "Locked"
    };
    device.DoorState = doorStateMap[value];
  },

  parseEvent (event, device) {
    if (!device) {
      return;
    }

    const eventHandlers = {
      "BSH.Common.Option.RemainingProgramTime": () => this.parseRemainingProgramTime(device, event.value),
      "BSH.Common.Option.ProgramProgress": () => this.parseProgramProgress(device, event.value),
      "BSH.Common.Status.OperationState": () => this.parseOperationState(device, event.value),
      "Cooking.Common.Setting.Lighting": () => this.parseLighting(device, event.value),
      "BSH.Common.Setting.PowerState": () => this.parsePowerState(device, event.value),
      "BSH.Common.Status.DoorState": () => this.parseDoorState(device, event.value)
    };

    const handler = eventHandlers[event.key];
    if (handler) {
      handler();
    }
  },

  broadcastDevices () {
    console.log(`📡 Broadcasting ${this.devices.size} devices to ${globalSession.clientInstances.size} clients`);
    globalSession.clientInstances.forEach(() => {
      this.sendSocketNotification(
        "MMM-HomeConnect_Update",
        Array.from(this.devices.values())
      );
    });
  }
});
