// ... (unverändert bis zum module.exports)

// ab hier alle hc-Zugriffe auf this.hc geändert
module.exports = NodeHelper.create({
  refreshToken: null,
  hc: null,
  devices: new Map(),
  authInProgress: false,
  configReceived: false,
  initializationAttempts: 0,
  maxInitAttempts: 3,
  instanceId: null,

  // ... (init, start, stop unverändert)

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "CONFIG":
        // ... (bis zu dieser Stelle unverändert)

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
            if (this.hc) {
              setTimeout(() => {
                this.getDevices();
              }, 1000);
            }
            return;
          }

          // ... (Rest unverändert)

        } else {
          // Bereits konfiguriert - Status an neuen Client senden
          if (globalSession.isAuthenticated && this.hc) {
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
        if (this.hc && !globalSession.isAuthenticating) {
          console.log("📡 Update request received - fetching devices");
          this.getDevices();
        } else {
          console.log("⚠️ Update request ignored - HC not ready or auth in progress");
        }
        break;

      // ... (Rest unverändert)
    }
  },

  // ... (broadcastToAllClients unverändert)

  checkTokenAndInitialize () {
    // ... (unverändert bis zum Auth-Teil)
    if (this.config.use_headless_auth && !globalSession.isAuthenticating && !globalSession.refreshToken) {
      // ...
      this.initWithHeadlessAuth();
    } else if (!globalSession.isAuthenticating && !globalSession.refreshToken) {
      // ...
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
          if (!this.hc) { // Only retry if still not initialized
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

      this.hc = new HomeConnect(this.config.client_ID, this.config.client_Secret, refreshToken);

      // Set timeout for initialization
      const initTimeout = setTimeout(() => {
        console.error("⏰ HomeConnect initialization timeout");
        globalSession.isAuthenticating = false;
        reject(new Error("HomeConnect initialization timeout"));
      }, 30000); // 30 second timeout

      this.hc.init({
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

      this.hc.on("newRefreshToken", (refresh_token) => {
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

    this.hc = new HomeConnect(this.config.client_ID, this.config.client_Secret, this.refreshToken);

    // Set timeout for OAuth initialization
    const oauthTimeout = setTimeout(() => {
      console.error("⏰ OAuth initialization timeout");
      globalSession.isAuthenticating = false;
      _self.broadcastToAllClients("INIT_STATUS", {
        status: "oauth_timeout",
        message: "OAuth Timeout - bitte Browser prüfen"
      });
    }, 60000); // 60 second timeout

    this.hc.init({
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

    this.hc.on("newRefreshToken", (refresh_token) => {
      fs.writeFileSync("./modules/MMM-HomeConnect/refresh_token.json", refresh_token);
      console.log("🔄 OAuth refresh token updated and saved");

      // Session-Token aktualisieren
      globalSession.refreshToken = refresh_token;

      _self.getDevices();
    });
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
    const _self = this;

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Geräte werden geladen..."
    });

    this.hc.command("appliances", "get_home_appliances")
      .then((result) => {
        // ... (unverändert, außer unten: hc zu this.hc)
        result.body.data.homeappliances.forEach((device, index) => {
          console.log(`📱 Processing device ${index + 1}: ${device.name} (${device.haId})`);
          _self.devices.set(device.haId, device);

          if (device.connected == true) {
            console.log(`🔗 Device ${device.name} is connected - fetching status`);

            _self.hc.command("status", "get_status", device.haId).then((status_result) => {
              console.log(`📊 Status received for ${device.name}`);
              status_result.body.data.status.forEach((event) => {
                _self.parseEvent(event, device);
              });
              _self.broadcastDevices();
            })
              .catch((error) => console.error(`❌ Status error for ${device.name}:`, error));

            _self.hc.command("settings", "get_settings", device.haId).then((settings_result) => {
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
        _self.hc.subscribe("NOTIFY", (e) => {
          _self.deviceEvent(e);
        });
        _self.hc.subscribe("STATUS", (e) => {
          _self.deviceEvent(e);
        });
        _self.hc.subscribe("EVENT", (e) => {
          _self.deviceEvent(e);
        });

        const array = [..._self.devices.entries()];
        sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1 : -1));
        _self.devices = new Map(sortedArray);

        console.log("✅ Device processing complete - broadcasting to frontend");
        _self.broadcastDevices();

        _self.broadcastToAllClients("INIT_STATUS", {
          status: "complete",
          message: `${result.body.data.homeappliances.length} Gerät(e) geladen`
        });
      })
      .catch((error) => {
        // ... (unverändert)
        _self.broadcastToAllClients("INIT_STATUS", {
          status: "device_error",
          message: `Geräte-Fehler: ${error.message}`
        });

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
    this.hc = null;
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

  // ... (Rest unverändert, keine hc-Zugriffe mehr)
});
