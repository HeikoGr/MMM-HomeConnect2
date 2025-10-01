const HomeConnect = require("home-connect-js");
const fs = require("fs");
const NodeHelper = require("node_helper");
// Alternative approach using Device Flow with proper rate limiting
const fetch = require("node-fetch");

// Session-basiertes Management für globale Token-Verwaltung
const globalSession = {
  isAuthenticated: false,
  isAuthenticating: false,
  accessToken: null,
  refreshToken: null,
  clientInstances: new Set(),
  lastAuthAttempt: 0,
  MIN_AUTH_INTERVAL: 60000 // 1 Minute zwischen Auth-Versuchen
};

async function initiateDeviceFlow (clientId) {
  try {
    const response = await fetch("https://api.home-connect.com/security/oauth/device_authorization", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `client_id=${clientId}`
    });

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

async function pollForToken (clientId, clientSecret, deviceCode, interval = 5, maxAttempts = 60, sendNotification) {
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

        const response = await fetch("https://api.home-connect.com/security/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: `grant_type=device_code&device_code=${deviceCode}&client_id=${clientId}&client_secret=${clientSecret}`
        });

        if (response.ok) {
          const tokens = await response.json();
          console.log("✅ Token received successfully!");

          if (sendNotification) {
            sendNotification("AUTH_STATUS", {
              status: "success",
              message: "Authentifizierung erfolgreich!"
            });
          }

          resolve({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            timestamp: Math.floor(Date.now() / 1000)
          });
          return;
        }

        const error = await response.json();
        console.log("Token response error:", error);

        if (error.error === "authorization_pending") {
          console.log("⏳ Waiting for user authorization...");
          setTimeout(poll, currentInterval * 1000);
        } else if (error.error === "slow_down") {
          currentInterval = Math.max(currentInterval + 5, 10);
          console.log(`⚠️ Slowing down polling to ${currentInterval}s interval`);
          setTimeout(poll, currentInterval * 1000);
        } else if (error.error === "access_denied") {
          if (sendNotification) {
            sendNotification("AUTH_STATUS", {
              status: "error",
              message: "Benutzer hat Autorisierung verweigert"
            });
          }
          reject(new Error("❌ User denied authorization"));
        } else if (error.error === "expired_token") {
          if (sendNotification) {
            sendNotification("AUTH_STATUS", {
              status: "error",
              message: "Autorisierungscode abgelaufen - bitte neu starten"
            });
          }
          reject(new Error("❌ Device code expired - please restart"));
        } else {
          reject(new Error(`Token request failed: ${error.error_description || error.error}`));
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
    console.log("🔗 Oder verwenden Sie diesen direkten Link:");
    console.log(`${deviceAuth.verification_uri_complete || `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`}`);
    console.log("");
    console.log(`⏱️ Code läuft ab in: ${Math.floor(deviceAuth.expires_in / 60)} Minuten`);
    console.log(`🔄 Polling-Intervall: ${deviceAuth.interval || 5} Sekunden`);
    console.log("");

    if (sendNotification) {
      sendNotification("AUTH_INFO", {
        status: "waiting",
        verification_uri: deviceAuth.verification_uri,
        user_code: deviceAuth.user_code,
        verification_uri_complete: deviceAuth.verification_uri_complete || `${deviceAuth.verification_uri}?user_code=${deviceAuth.user_code}`,
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

  init () {
    console.log("init module helper: MMM-HomeConnect (Session-Based Version)");
  },

  start () {
    console.log(`Starting module helper: ${this.name}`);
  },

  stop () {
    console.log(`Stopping module helper: ${this.name}`);
  },

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "CONFIG":
        // Client-Instanz registrieren
        this.instanceId = payload.instanceId || "default";
        globalSession.clientInstances.add(this.instanceId);

        console.log(`📋 Processing CONFIG notification for instance: ${this.instanceId}`);
        console.log(`🔧 Registered clients: ${globalSession.clientInstances.size}`);

        // Nur bei der ersten Client-Instanz oder wenn nicht authentifiziert
        if (!this.configReceived) {
          this.configReceived = true;
          this.config = payload;
          setConfig(payload);

          console.log("🔧 use_headless_auth:", this.config.use_headless_auth);

          // Session-Status prüfen
          if (globalSession.isAuthenticated) {
            console.log("✅ Session bereits authentifiziert - verwende bestehende Token");
            this.sendSocketNotification("INIT_STATUS", {
              status: "session_active",
              message: "Session aktiv - verwende bestehende Authentifizierung",
              instanceId: this.instanceId
            });

            // Geräte sofort laden wenn HomeConnect bereits initialisiert
            if (hc) {
              setTimeout(() => {
                this.getDevices();
              }, 1000);
            }
            return;
          }

          if (globalSession.isAuthenticating) {
            console.log("⏳ Authentifizierung bereits im Gange für andere Client-Instanz");
            this.sendSocketNotification("INIT_STATUS", {
              status: "auth_in_progress",
              message: "Authentifizierung läuft bereits...",
              instanceId: this.instanceId
            });
            return;
          }

          // Send initial status to frontend
          this.sendSocketNotification("INIT_STATUS", {
            status: "initializing",
            message: "Initialisierung gestartet...",
            instanceId: this.instanceId
          });

          this.checkTokenAndInitialize();
        } else {
          // Bereits konfiguriert - Status an neuen Client senden
          if (globalSession.isAuthenticated && hc) {
            this.sendSocketNotification("INIT_STATUS", {
              status: "complete",
              message: "Bereits initialisiert",
              instanceId: this.instanceId
            });

            // Geräte an neuen Client senden
            setTimeout(() => {
              this.broadcastDevices();
            }, 500);
          } else if (globalSession.isAuthenticating) {
            this.sendSocketNotification("INIT_STATUS", {
              status: "auth_in_progress",
              message: "Authentifizierung läuft...",
              instanceId: this.instanceId
            });
          }
        }
        break;

      case "UPDATEREQUEST":
        if (hc && !globalSession.isAuthenticating) {
          console.log("📡 Update request received - fetching devices");
          this.getDevices();
        } else {
          console.log("⚠️ Update request ignored - HC not ready or auth in progress");
        }
        break;

      case "RETRY_AUTH":
        console.log("🔄 Manual retry requested...");
        this.retryAuthentication();
        break;
    }
  },

  // Broadcast-Funktion für alle registrierten Clients
  broadcastToAllClients (notification, payload) {
    globalSession.clientInstances.forEach((instanceId) => {
      this.sendSocketNotification(notification, {
        ...payload,
        instanceId
      });
    });
  },

  checkTokenAndInitialize () {
    console.log("🔍 Checking for existing refresh token...");

    if (fs.existsSync("./modules/MMM-HomeConnect/refresh_token.json")) {
      try {
        this.refreshToken = fs.readFileSync("./modules/MMM-HomeConnect/refresh_token.json", "utf8").trim();

        if (this.refreshToken && this.refreshToken.length > 0) {
          console.log("📄 Existing refresh token found - length:", this.refreshToken.length);
          console.log("🔧 Using standard OAuth initialization");

          globalSession.refreshToken = this.refreshToken;

          this.broadcastToAllClients("INIT_STATUS", {
            status: "token_found",
            message: "Token gefunden - OAuth wird verwendet"
          });

          this.initWithOAuth();
          return;
        }
        console.log("⚠️ Refresh token file is empty");
        this.refreshToken = null;
      } catch (error) {
        console.log("⚠️ Could not read refresh token file:", error.message);
        this.refreshToken = null;
      }
    } else {
      console.log("📄 No refresh token file found");
    }

    // Rate Limiting prüfen
    const now = Date.now();
    if (now - globalSession.lastAuthAttempt < globalSession.MIN_AUTH_INTERVAL) {
      console.log("⚠️ Rate limit: Warten vor nächstem Auth-Versuch");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "rate_limited",
        message: "Rate Limit - bitte warten..."
      });
      return;
    }

    // No valid token found - need authentication
    if (this.config.use_headless_auth && !globalSession.isAuthenticating && !globalSession.refreshToken) {
      console.log("🔧 No refresh token available - using headless authentication");

      globalSession.lastAuthAttempt = now;

      this.broadcastToAllClients("INIT_STATUS", {
        status: "need_auth",
        message: "Authentifizierung erforderlich"
      });

      this.initWithHeadlessAuth();
    } else if (!globalSession.isAuthenticating && !globalSession.refreshToken) {
      console.log("🔧 No refresh token available - using standard OAuth flow");

      this.broadcastToAllClients("INIT_STATUS", {
        status: "oauth_needed",
        message: "OAuth Browser-Anmeldung erforderlich"
      });

      this.initWithOAuth();
    }
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

      fs.writeFileSync("./modules/MMM-HomeConnect/refresh_token.json", tokens.refresh_token);
      console.log("💾 Refresh token saved successfully");

      // Session-Status aktualisieren
      globalSession.refreshToken = tokens.refresh_token;
      globalSession.accessToken = tokens.access_token;

      this.broadcastToAllClients("INIT_STATUS", {
        status: "initializing_hc",
        message: "HomeConnect wird initialisiert..."
      });

      await this.initializeHomeConnect(tokens.refresh_token);
    } catch (error) {
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
      } else if (this.initializationAttempts < this.maxInitAttempts) {
        console.log(`🔄 Will retry in 30 seconds (${this.initializationAttempts}/${this.maxInitAttempts})`);
        setTimeout(() => {
          if (!hc) { // Only retry if still not initialized
            this.initWithHeadlessAuth();
          }
        }, 30000);
      } else {
        console.log("❌ Max initialization attempts reached - falling back to OAuth");
        this.broadcastToAllClients("INIT_STATUS", {
          status: "fallback_oauth",
          message: "Fallback zu OAuth Browser-Anmeldung"
        });
        this.initWithOAuth();
      }
    }
  },

  async initializeHomeConnect (refreshToken) {
    return new Promise((resolve, reject) => {
      const _self = this;

      console.log("🏠 Initializing HomeConnect with token...");

      hc = new HomeConnect(this.config.client_ID, this.config.client_Secret, refreshToken);

      // Set timeout for initialization
      const initTimeout = setTimeout(() => {
        console.error("⏰ HomeConnect initialization timeout");
        globalSession.isAuthenticating = false;
        reject(new Error("HomeConnect initialization timeout"));
      }, 30000); // 30 second timeout

      hc.init({
        isSimulated: false
      }).then(() => {
        clearTimeout(initTimeout);
        console.log("✅ HomeConnect initialized successfully");

        // Session-Status aktualisieren
        globalSession.isAuthenticated = true;
        globalSession.isAuthenticating = false;

        _self.broadcastToAllClients("INIT_STATUS", {
          status: "success",
          message: "Erfolgreich initialisiert"
        });

        // Immediately try to get devices
        setTimeout(() => {
          _self.getDevices();
        }, 2000);

        resolve();
      })
        .catch((error) => {
          clearTimeout(initTimeout);
          console.error("❌ HomeConnect initialization failed:", error);
          globalSession.isAuthenticating = false;

          _self.broadcastToAllClients("INIT_STATUS", {
            status: "hc_error",
            message: `HomeConnect Fehler: ${error.message}`
          });

          reject(error);
        });

      hc.on("newRefreshToken", (refresh_token) => {
        fs.writeFileSync("./modules/MMM-HomeConnect/refresh_token.json", refresh_token);
        console.log("🔄 Refresh token updated");

        // Session-Token aktualisieren
        globalSession.refreshToken = refresh_token;

        _self.getDevices();
      });
    });
  },

  initWithOAuth () {
    if (globalSession.isAuthenticating) {
      return;
    }

    const _self = this;

    console.log("🔧 Initializing with OAuth...");
    if (this.refreshToken) {
      console.log("🔑 Using existing refresh token");
    } else {
      console.log("🔑 No refresh token - will trigger browser OAuth flow");
    }

    globalSession.isAuthenticating = true;

    hc = new HomeConnect(this.config.client_ID, this.config.client_Secret, this.refreshToken);

    // Set timeout for OAuth initialization
    const oauthTimeout = setTimeout(() => {
      console.error("⏰ OAuth initialization timeout");
      globalSession.isAuthenticating = false;
      _self.broadcastToAllClients("INIT_STATUS", {
        status: "oauth_timeout",
        message: "OAuth Timeout - bitte Browser prüfen"
      });
    }, 60000); // 60 second timeout

    hc.init({
      isSimulated: false
    }).then(() => {
      clearTimeout(oauthTimeout);
      console.log("✅ OAuth initialization successful");

      // Session-Status aktualisieren
      globalSession.isAuthenticated = true;
      globalSession.isAuthenticating = false;

      _self.broadcastToAllClients("INIT_STATUS", {
        status: "success",
        message: "OAuth erfolgreich"
      });

      // Immediately try to get devices
      setTimeout(() => {
        _self.getDevices();
      }, 2000);
    })
      .catch((error) => {
        clearTimeout(oauthTimeout);
        console.error("❌ OAuth initialization failed:", error);
        globalSession.isAuthenticating = false;

        _self.broadcastToAllClients("INIT_STATUS", {
          status: "oauth_error",
          message: `OAuth Fehler: ${error.message}`
        });

        console.log("💡 Please check your configuration and try restarting MagicMirror");
      });

    hc.on("newRefreshToken", (refresh_token) => {
      fs.writeFileSync("./modules/MMM-HomeConnect/refresh_token.json", refresh_token);
      console.log("🔄 OAuth refresh token updated and saved");

      // Session-Token aktualisieren
      globalSession.refreshToken = refresh_token;

      _self.getDevices();
    });
  },

  getDevices () {
    if (!hc) {
      console.error("❌ HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect nicht bereit"
      });
      return;
    }

    console.log("📱 Fetching devices from Home Connect API...");
    _self = this;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Geräte werden geladen..."
    });

    hc.command("appliances", "get_home_appliances")
      .then((result) => {
        console.log(`✅ API Response received - Found ${result.body.data.homeappliances.length} appliances`);

        if (result.body.data.homeappliances.length === 0) {
          console.log("⚠️ No appliances found - check Home Connect app");
          _self.broadcastToAllClients("INIT_STATUS", {
            status: "no_devices",
            message: "Keine Geräte gefunden - Home Connect App prüfen"
          });
        }

        result.body.data.homeappliances.forEach((device, index) => {
          console.log(`📱 Processing device ${index + 1}: ${device.name} (${device.haId})`);
          _self.devices.set(device.haId, device);

          if (device.connected == true) {
            console.log(`🔗 Device ${device.name} is connected - fetching status`);

            hc.command("status", "get_status", device.haId).then((status_result) => {
              console.log(`📊 Status received for ${device.name}`);
              status_result.body.data.status.forEach((event) => {
                _self.parseEvent(event, device);
              });
              _self.broadcastDevices();
            })
              .catch((error) => console.error(`❌ Status error for ${device.name}:`, error));

            hc.command("settings", "get_settings", device.haId).then((settings_result) => {
              console.log(`⚙️ Settings received for ${device.name}`);
              settings_result.body.data.settings.forEach((event) => {
                _self.parseEvent(event, device);
              });
              _self.broadcastDevices();
            })
              .catch((error) => console.error(`❌ Settings error for ${device.name}:`, error));
          } else {
            console.log(`⚠️ Device ${device.name} is not connected`);
          }
        });

        // Subscribe to events
        console.log("📡 Subscribing to device events...");
        hc.subscribe("NOTIFY", (e) => {
          _self.deviceEvent(e);
        });
        hc.subscribe("STATUS", (e) => {
          _self.deviceEvent(e);
        });
        hc.subscribe("EVENT", (e) => {
          _self.deviceEvent(e);
        });

        const array = [..._self.devices.entries()];
        sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1
: -1));
        _self.devices = new Map(sortedArray);

        console.log("✅ Device processing complete - broadcasting to frontend");
        _self.broadcastDevices();

        _self.broadcastToAllClients("INIT_STATUS", {
          status: "complete",
          message: `${result.body.data.homeappliances.length} Gerät(e) geladen`
        });
      })
      .catch((error) => {
        console.error("❌ Failed to get devices:", error);

        _self.broadcastToAllClients("INIT_STATUS", {
          status: "device_error",
          message: `Geräte-Fehler: ${error.message}`
        });

        // Retry after delay if this was a network error
        if (error.message.includes("fetch") || error.message.includes("network")) {
          console.log("🔄 Network error detected - retrying in 30 seconds");
          setTimeout(() => {
            _self.getDevices();
          }, 30000);
        }
      });
  },

  retryAuthentication () {
    console.log("🔄 Manual authentication retry...");

    // Reset session state
    globalSession.isAuthenticated = false;
    globalSession.isAuthenticating = false;
    globalSession.accessToken = null;
    globalSession.refreshToken = null;
    globalSession.clientInstances.clear();

    // Reset local state
    this.configReceived = false;
    this.initializationAttempts = 0;
    hc = null;
    this.devices.clear();

    // Delete token file
    if (fs.existsSync("./modules/MMM-HomeConnect/refresh_token.json")) {
      fs.unlinkSync("./modules/MMM-HomeConnect/refresh_token.json");
      console.log("🗑️ Old token file deleted");
    }

    this.refreshToken = null;

    // Restart initialization
    this.checkTokenAndInitialize();
  },

  deviceEvent (data) {
    _self = this;
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

  parseEvent (event, device) {
    if (!device) {
      return;
    }

    if (event.key == "BSH.Common.Option.RemainingProgramTime") {
      device.RemainingProgramTime = event.value;
    } else if (event.key === "BSH.Common.Option.ProgramProgress") {
      device.ProgramProgress = event.value;
    } else if (event.key === "BSH.Common.Status.OperationState") {
      if (event.value == "BSH.Common.EnumType.OperationState.Finished") {
        device.RemainingProgramTime = 0;
      }
    } else if (event.key === "Cooking.Common.Setting.Lighting") {
      device.Lighting = event.value;
    } else if (event.key == "BSH.Common.Setting.PowerState") {
      if (event.value === "BSH.Common.EnumType.PowerState.On") {
        device.PowerState = "On";
      } else if (event.value === "BSH.Common.EnumType.PowerState.Standby") {
        device.PowerState = "Standby";
      } else if (event.value === "BSH.Common.EnumType.PowerState.Off") {
        device.PowerState = "Off";
      }
    } else if (event.key == "BSH.Common.Status.DoorState") {
      if (event.value === "BSH.Common.EnumType.DoorState.Open") {
        device.DoorState = "Open";
      } else if (event.value === "BSH.Common.EnumType.DoorState.Closed") {
        device.DoorState = "Closed";
      } else if (event.value === "BSH.Common.EnumType.DoorState.Locked") {
        device.DoorState = "Locked";
      }
    }
  },

  broadcastDevices () {
    console.log(`📡 Broadcasting ${this.devices.size} devices to ${globalSession.clientInstances.size} clients`);
    globalSession.clientInstances.forEach(() => {
      this.sendSocketNotification("MMM-HomeConnect_Update", Array.from(this.devices.values()));
    });
  }
});
