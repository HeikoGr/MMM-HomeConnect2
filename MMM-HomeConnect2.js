Module.register("MMM-HomeConnect2", {
  devices: [],
  config: null,
  authInfo: null,
  authStatus: null,
  instanceId: null,
  deviceRuntimeHints: {},
  debugStats: null,
  lifecycle: null,

  defaults: {
    header: "Home Connect Appliances",
    clientId: "",
    clientSecret: "",

    showDeviceIcon: true,
    showAlwaysAllDevices: false,
    showDeviceIfDoorIsOpen: true,
    showDeviceIfFailure: true,
    showDeviceIfInfoIsAvailable: true,
    enableSSEHeartbeat: true, // Enable SSE heartbeat checks by default
    sseHeartbeatCheckIntervalMs: 10 * 1000, // 10 seconds
    sseHeartbeatStaleThresholdMs: 70 * 1000, // 70 seconds
    sseRecoveryCooldownMs: 70 * 1000, // minimum time between SSE stale-recovery attempts
    apiRequestTimeoutMs: 15 * 1000,
    progressRefreshIntervalMs: 30 * 1000,
    minActiveProgramIntervalMs: 10 * 60 * 1000, // 10 minutes between active program fetches (backend throttle)
    // Optional: none | error | warn | info | debug. Output goes through MagicMirror's
    // Log, so the global logLevel decides; this can only narrow it. "debug" also
    // shows the debug panel.
    logLevel: "",
  },

  start() {
    // The core-assigned identifier is unique per instance and stable across
    // reloads. The backend tracks displays by their socket connection, so a
    // browser-local id is no longer needed to keep its registry bounded.
    this.instanceId = this.identifier;
    this.shared = globalThis.MMModuleShared;
    this.transport = this.shared.createTransport({
      moduleName: "MMM-HomeConnect2",
      identifier: this.identifier,
      instanceId: this.instanceId,
      sendSocketNotification: this.sendSocketNotification.bind(this),
    });
    this.notifications = this.transport.notifications;

    // The backend owns the data cadence here (SSE + snapshot timer), so the
    // lifecycle has no onFetch: it only keeps visual work and DOM updates from
    // running against a hidden module.
    this.lifecycle = this.shared.createLifecycle({
      module: this,
      logger: this.shared.createLogger({
        moduleName: "MMM-HomeConnect2",
        identifier: this.identifier,
        getLevel: () => this.config.logLevel,
        structured: false,
        redact: true,
      }),
      updateInterval: 0,
      visibleTickInterval:
        typeof this.config?.progressRefreshIntervalMs === "number"
          ? Math.max(5000, this.config.progressRefreshIntervalMs)
          : this.defaults.progressRefreshIntervalMs,
      onVisibleTick: () => {
        if (Array.isArray(this.devices) && this.devices.length > 0) {
          this.updateDom(0);
        }
      },
    });
    this.lifecycle.start();
  },

  getScripts() {
    // The loader treats any name containing "/" as a path from the MagicMirror
    // root, so subdirectory scripts need the module prefix this.file() adds.
    return [
      this.file("lib/mmm-shared/mmm-shared.js"),
      this.file("lib/device-utils.js"),
      this.file("lib/display-state.js"),
      this.file("lib/dom-builder.js"),
      this.file("lib/device-card-renderer.js"),
      this.file("lib/status-views.js"),
    ];
  },

  getStyles() {
    return ["MMM-HomeConnect2.css"];
  },

  getTranslations() {
    return {
      en: "translations/en.json",
      de: "translations/de.json",
      da: "translations/da.json",
    };
  },

  // MagicMirror's config is a global `let` in the browser, not a window property -
  // globalThis.config is undefined there, which silently dropped the language
  // (the browser's own was used instead) and the 12/24 h setting.
  getMagicMirrorConfig() {
    return typeof config === "object" && config ? config : {};
  },

  // MagicMirror's language - the same one the translations and the Home Connect
  // texts (set on the server) use, so the display never mixes two.
  getLanguage() {
    const language = this.getMagicMirrorConfig().language;
    return typeof language === "string" ? language.trim() : "";
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      this.sendConfigure();
    }
  },

  sendConfigure() {
    this.configurePendingSince = Date.now();
    this.transport.sendRequest("CONFIGURE", {
      config: {
        ...this.config,
        instanceId: this.instanceId,
        // Lets the backend spot a tab that still runs the language from before a
        // config change (it then reloads); the session language itself comes
        // from the server's MagicMirror config.
        language: this.getLanguage(),
      },
    });
  },

  /**
   * The backend greets every new socket connection with INIT_REQUIRED - after a
   * server restart or a long network drop this display is unknown there and
   * must register again. Right after page load the greeting only crosses the
   * first CONFIGURE, so it is ignored while that one is unanswered.
   */
  handleInitRequired() {
    const pendingMs = Date.now() - (this.configurePendingSince || 0);
    if (this.configurePendingSince && pendingMs < 30 * 1000) {
      return;
    }
    this.sendConfigure();
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== this.notifications.EVENT) {
      return;
    }

    if (payload?.action === "INIT_REQUIRED") {
      if (payload.instanceId === "*" || payload.instanceId === this.instanceId) {
        this.handleInitRequired();
      }
      return;
    }

    // Only respond to events for this instance
    if (payload?.instanceId && payload.instanceId !== this.instanceId) {
      return;
    }

    const safePayload = payload?.data ?? {};
    const action = payload?.action || "";
    // Any answer means the backend knows this display.
    this.configurePendingSince = null;

    switch (action) {
      case "DEVICES_UPDATE":
        this.devices = Array.isArray(safePayload)
          ? safePayload
          : safePayload && typeof safePayload === "object"
            ? Object.values(safePayload)
            : [];
        this.lifecycle.render();
        break;
      case "AUTH_INFO":
        this.authInfo = safePayload;
        this.lifecycle.render();
        break;
      case "AUTH_STATUS":
        this.authStatus = safePayload;
        this.lifecycle.render();
        break;
      case "INIT_STATUS": {
        Log.log(`${this.name} Init Status: ${safePayload.status} - ${safePayload.message}`);
        this.lastInitStatus = safePayload;
        this.lastInitStatusReceivedAt = Date.now();

        if (["session_active", "complete", "success"].includes(safePayload.status)) {
          // Session active - normal display; "success" ends a login this tab showed the QR code for
          this.authInfo = null;
          this.authStatus = null;
        } else if (
          safePayload.status === "config_outdated" &&
          this.reloadForOutdatedConfig(safePayload.serverStartedAt)
        ) {
          return;
        } else if (safePayload.status === "auth_in_progress") {
          // Authentication already in progress (special auth UI)
          this.authStatus = {
            status: "polling",
            message: safePayload.message,
          };
        }
        this.lifecycle.render();
        break;
      }
      case "DEBUG_STATS":
        this.debugStats = safePayload || {};
        // The stats arrive on every API call and SSE keep-alive; only the debug
        // panel shows them, so without it there is nothing to re-render.
        if (this.isDebugPanelEnabled()) {
          this.lifecycle.render();
        }
        break;
      default:
        break;
    }
  },

  /**
   * This tab still runs the config it loaded before the last server restart
   * (MagicMirror does not reload open pages by default). A reload fetches the
   * current one - at most once per server start, so configs that never match
   * cannot loop, while every further restart (the next config edit) may reload
   * again. When the guard holds, the display shows a hint to reload by hand.
   * @param {number} [serverStartedAt] - Start time of the backend that asked
   * @returns {boolean} Whether a reload was started
   */
  reloadForOutdatedConfig(serverStartedAt) {
    const storageKey = `${this.name}:outdatedConfigReloadFor`;
    const serverStart = String(serverStartedAt ?? "unknown");
    try {
      if (window.sessionStorage.getItem(storageKey) === serverStart) {
        return false;
      }
      window.sessionStorage.setItem(storageKey, serverStart);
    } catch {
      // Without storage there is no loop guard - leave it to the hint.
      return false;
    }
    Log.info(`${this.name}: config changed on the server - reloading the page`);
    window.location.reload();
    return true;
  },

  suspend() {
    this.lifecycle.suspend();
  },

  resume() {
    this.lifecycle.resume();
  },

  getDisplayState() {
    return window.HomeConnectDisplayState;
  },

  getDeviceUtils() {
    const browserUtils =
      typeof window !== "undefined" && window.HomeConnectDeviceUtils ? window.HomeConnectDeviceUtils : {};
    return this.getDisplayState().withDeviceUtilsFallbacks(browserUtils);
  },

  formatClockTime(timestamp) {
    if (!Number.isFinite(timestamp)) {
      return "";
    }

    const locale = this.getLanguage() || undefined;
    const timeFormat = this.getMagicMirrorConfig().timeFormat;
    const hour12 = timeFormat === 12 ? true : timeFormat === 24 ? false : undefined;

    try {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12,
      }).format(timestamp);
    } catch {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  },

  buildDeviceDisplayState(device, runtimeHints, deviceUtils) {
    return this.getDisplayState().buildDeviceDisplayState(device, runtimeHints, deviceUtils, {
      translate: (key) => this.translate(key),
      formatClockTime: (timestamp) => this.formatClockTime(timestamp),
      debug: (this.config?.logLevel || "").toLowerCase() === "debug",
      now: Date.now(),
    });
  },

  renderDeviceCard(device, runtimeHints, deviceUtils) {
    if (!deviceUtils.shouldDisplayDevice(device, this.config)) {
      return null;
    }

    return window.HomeConnectDeviceCardRenderer.renderDeviceCard({
      device,
      displayState: this.buildDeviceDisplayState(device, runtimeHints, deviceUtils),
      showDeviceIcon: Boolean(this.config.showDeviceIcon),
      translate: (key) => this.translate(key),
      iconUrl: (imageName) => this.file(`icons/${imageName}`),
    });
  },

  getDom() {
    // Cards: lib/device-card-renderer.js; everything else: lib/status-views.js.
    const views = window.HomeConnectStatusViews;
    const ctx = { translate: (key) => this.translate(key), now: Date.now() };
    const div = document.createElement("div");
    const append = (...nodes) => {
      for (const node of nodes.flat()) {
        if (node) {
          div.appendChild(node);
        }
      }
    };

    if (this.authInfo && this.authInfo.status === "waiting") {
      append(views.renderAuthInfo(this.authInfo, ctx));
      return div;
    }
    if (this.authStatus && this.authStatus.status === "polling") {
      append(views.renderAuthStatus(this.authStatus, ctx));
      return div;
    }
    if (this.authStatus && this.authStatus.status === "error") {
      append(views.renderAuthError(this.authStatus, ctx));
      return div;
    }

    const notices = views.renderNotices(
      {
        lastInitStatus: this.lastInitStatus,
        lastInitStatusReceivedAt: this.lastInitStatusReceivedAt,
        authStatus: this.authStatus,
      },
      ctx,
    );

    if (!this.devices || this.devices.length === 0) {
      append(notices, views.isConfigRejected(this.lastInitStatus) ? null : views.renderLoading(ctx));
      return div;
    }

    if (!this.deviceRuntimeHints) {
      this.deviceRuntimeHints = {};
    }
    const deviceUtils = this.getDeviceUtils();
    const cards = this.devices
      .map((device) => this.renderDeviceCard(device, this.deviceRuntimeHints, deviceUtils))
      .filter(Boolean);
    const debugPanel = this.isDebugPanelEnabled()
      ? views.renderDebugPanel({ debugStats: this.debugStats, lastInitStatus: this.lastInitStatus })
      : null;

    append(notices, cards.length > 0 ? cards : views.renderNoActiveAppliances(ctx), debugPanel);
    return div;
  },

  isDebugPanelEnabled() {
    return (this.config?.logLevel || this.defaults.logLevel || "none").toLowerCase() === "debug";
  },
}); // End Module
