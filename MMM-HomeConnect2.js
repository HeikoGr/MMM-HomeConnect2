/* global Module, Log */ // eslint-disable-line no-redeclare
Module.register("MMM-HomeConnect2", {
  updated: 0,
  devices: [],
  config: null,
  authInfo: null,
  authStatus: null,
  instanceId: null,
  deviceRuntimeHints: {},
  lastActiveProgramRequestTs: 0,

  defaults: {
    header: "Home Connect Appliances",
    clientId: "",
    clientSecret: "",

    showDeviceIcon: true,
    showAlwaysAllDevices: false,
    showDeviceIfDoorIsOpen: true,
    showDeviceIfFailure: true,
    showDeviceIfInfoIsAvailable: true,
    updateFrequency: 1000 * 60 * 60, // Default hourly update (only used if polling enabled)
    enableUpdatePolling: false, // Disable periodic polling by default; rely on SSE
    enableServerPolling: false, // Disable server polling for device status by default
    enableProgramScheduler: false, // Disable program scheduler by default
    enableSSEHeartbeat: true, // Enable SSE heartbeat checks by default
    sseHeartbeatCheckIntervalMs: 60 * 1000, // 1 minute
    sseHeartbeatStaleThresholdMs: 3 * 60 * 1000, // 3 minutes
    globalEventSubscribeDelayMs: 5000, // Optional delay before registering global SSE streams
    eventSourceRetryBaseDelayMs: 15 * 1000, // Base retry delay after SSE errors
    eventSourceAuthErrorDelayMs: 30 * 1000, // Retry delay for auth-related SSE errors (401/429)
    minActiveProgramIntervalMs: 1 * 30 * 1000, // 30 seconds between active program fetches
    enableCacheRefreshPolling: true, // Frontend-only cache refresh (no Bosch calls)
    cacheRefreshIntervalMs: 30 * 1000, // 30 seconds
    frontendActiveProgramRequestIntervalMs: 60 * 1000, // Min delay between frontend GET_ACTIVE_PROGRAMS requests
    ssePreSubscribeRefreshMs: 5 * 60 * 1000, // Refresh token if older than 5 min before SSE subscribe
    // Module logging level: none | error | warn | info | debug
    logLevel: "debug"
  },

  start() {
    // Generate a unique instance ID
    this.instanceId = `hc_${Math.random().toString(36).substr(2, 9)}`;

    if (this.config.enableUpdatePolling) {
      const pollMs = this.config.updateFrequency || this.defaults.updateFrequency;
      Log.log(`${this.name} update polling enabled (interval ${pollMs}ms)`);
      this.updateTimer = setInterval(() => {
        this.requestStateRefresh({ forceRefresh: true });
      }, pollMs);
    }

    if (this.config.enableCacheRefreshPolling) {
      const cachePollMs =
        this.config.cacheRefreshIntervalMs || this.defaults.cacheRefreshIntervalMs;
      this.cacheRefreshTimer = setInterval(() => {
        this.requestStateRefresh();
      }, cachePollMs);
    }
  },

  requestStateRefresh(options = {}) {
    const payload = {
      instanceId: this.instanceId,
      ...options
    };
    this.sendSocketNotification("REQUEST_DEVICE_REFRESH", payload);
  },

  loaded(callback) {
    callback();
  },

  getScripts() {
    // Use full module-relative path so the MagicMirror loader can find the file
    return ["modules/MMM-HomeConnect2/lib/device-utils.js"];
  },

  getStyles() {
    return ["MMM-HomeConnect2.css"];
  },

  getTranslations() {
    return {
      en: "translations/en.json",
      de: "translations/de.json",
      da: "translations/da.json"
    };
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      // Send config with instanceId
      this.sendSocketNotification("CONFIG", {
        ...this.config,
        instanceId: this.instanceId
      });
    }
  },

  socketNotificationReceived(notification, payload) {
    // Only respond to messages for this instance (if instanceId present)
    if (payload && payload.instanceId && payload.instanceId !== this.instanceId) {
      return;
    }

    switch (notification) {
      case "MMM-HomeConnect_Update":
        this.devices = payload || [];
        this.updateDom();
        // After initial device list arrives, request a snapshot of active programs
        // so RemainingProgramTime / ProgramProgress are populated even before SSE events come in.
        this.scheduleActiveProgramSnapshot();
        break;
      case "AUTH_INFO":
        // Only update if for this instance or global
        if (!payload.instanceId || payload.instanceId === this.instanceId) {
          this.authInfo = payload;
          this.updateDom();
        }
        break;
      case "AUTH_STATUS":
        // Only update if for this instance or global
        if (!payload.instanceId || payload.instanceId === this.instanceId) {
          this.authStatus = payload;
          this.updateDom();
        }
        break;
      case "INIT_STATUS":
        // Process session status updates
        if (!payload.instanceId || payload.instanceId === this.instanceId) {
          Log.log(`${this.name} Init Status: ${payload.status} - ${payload.message}`);

          if (payload.status === "session_active" || payload.status === "complete") {
            // Session active - normal display
            this.authInfo = null;
            this.authStatus = null;
            this.updateDom();
          } else if (payload.status === "auth_in_progress") {
            // Authentication already in progress
            this.authStatus = {
              status: "polling",
              message: payload.message
            };
            this.updateDom();
          }
        }
        break;
      default:
        break;
    }
  },

  resume() {
    // On resume, trigger a revalidation: request a fresh device update and
    // explicitly request active program snapshots so UI resumes reflecting
    // currently running programs immediately.
    try {
      this.requestStateRefresh({ forceRefresh: true });
    } catch (e) {
      Log.error(`${this.name} resume actions failed: ${e}`);
    }
  },

  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.cacheRefreshTimer) {
      clearInterval(this.cacheRefreshTimer);
      this.cacheRefreshTimer = null;
    }
  },

  scheduleActiveProgramSnapshot() {
    try {
      const haIds = this.devices.map((d) => d.haId || d.haid || d.id).filter((id) => !!id);
      if (!haIds.length) {
        return;
      }

      const interval =
        typeof this.config.frontendActiveProgramRequestIntervalMs === "number"
          ? Math.max(0, this.config.frontendActiveProgramRequestIntervalMs)
          : this.defaults.frontendActiveProgramRequestIntervalMs;
      const now = Date.now();
      const elapsed = now - (this.lastActiveProgramRequestTs || 0);

      if (!interval || interval <= 0 || !this.lastActiveProgramRequestTs || elapsed >= interval) {
        this.lastActiveProgramRequestTs = now;
        this.requestStateRefresh({
          haIds
        });
        return;
      }

      // Wait until the throttle window expires before sending another request
      return;
    } catch (e) {
      Log.error(`${this.name} failed scheduling active programs: ${e}`);
    }
  },

  getDom() {
    const div = document.createElement("div");
    let wrapper = "";
    const _self = this;
    const runtimeHints = this.deviceRuntimeHints || (this.deviceRuntimeHints = {});

    function parseRemainingSeconds(device) {
      if (
        typeof window !== "undefined" &&
        window.HomeConnectDeviceUtils &&
        typeof window.HomeConnectDeviceUtils.parseRemainingSeconds === "function"
      ) {
        try {
          return window.HomeConnectDeviceUtils.parseRemainingSeconds(device);
        } catch {
          /* ignore */
        }
      }
      return null;
    }

    function parseProgress(device) {
      if (
        typeof window !== "undefined" &&
        window.HomeConnectDeviceUtils &&
        typeof window.HomeConnectDeviceUtils.parseProgress === "function"
      ) {
        try {
          return window.HomeConnectDeviceUtils.parseProgress(device);
        } catch {
          /* ignore */
        }
      }
      return undefined;
    }

    function formatDuration(sec) {
      if (!sec || sec <= 0) return "";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return (h > 0 ? `${h}h ` : "") + `${String(m).padStart(2, "0")}m`;
    }

    // Show authentication info if available
    if (this.authInfo && this.authInfo.status === "waiting") {
      div.innerHTML = this.getAuthHTML();
      return div;
    }

    // Show authentication status if available
    if (this.authStatus && this.authStatus.status === "polling") {
      div.innerHTML = this.getAuthStatusHTML();
      return div;
    }

    // Show error if authentication failed
    if (this.authStatus && this.authStatus.status === "error") {
      div.innerHTML = this.getAuthErrorHTML();
      return div;
    }

    // Show loading message if no devices yet
    if (!this.devices || this.devices.length === 0) {
      div.innerHTML =
        "<div class='small'>" +
        `<i class='fa fa-cog fa-spin'></i> ${_self.translate("SESSION_BASED_AUTH")}<br>` +
        `<span class='dimmed'>${_self.translate("LOADING_APPLIANCES")}...</span>` +
        "</div>";

      return div;
    }

    // Show devices
    this.devices.forEach((device) => {
      // Compact and readable device show logic
      let IsShowDevice = false;

      if (_self.config.showAlwaysAllDevices) {
        IsShowDevice = true;
      }
      if (device.PowerState === "On") {
        IsShowDevice = true;
      }
      if (device.Lighting) {
        IsShowDevice = true;
      }
      // Support different door fields: DoorState / DoorOpen
      const doorOpen =
        device.DoorOpen || device.DoorState === "Open" || device.doorState === "Open";
      if (_self.config.showDeviceIfDoorIsOpen && doorOpen) {
        IsShowDevice = true;
      }
      if (_self.config.showDeviceIfFailure && device.Failure) {
        IsShowDevice = true;
      }
      if (_self.config.showDeviceIfInfoIsAvailable && device.Failure) {
        IsShowDevice = true;
      }

      if (IsShowDevice) {
        const remainingSec = parseRemainingSeconds(device);
        const progVal = parseProgress(device);
        const deviceKey = device.haId || device.haid || device.id || device.name || "unknown";
        // Track if this appliance has recently reported an active program so we only mark it finished with real data
        const hint = runtimeHints[deviceKey] || (runtimeHints[deviceKey] = { hadActive: false });

        // Normalize program progress to a number if possible
        let progNumeric;
        if (progVal !== undefined && progVal !== null) {
          const parsed = Number(progVal);
          progNumeric = Number.isFinite(parsed)
            ? Math.max(0, Math.min(100, Math.round(parsed)))
            : undefined;
        }

        const opStateRaw = device.OperationState || device.operationState || null;
        const opStateString =
          typeof opStateRaw === "string"
            ? opStateRaw
            : opStateRaw && typeof opStateRaw.value === "string"
              ? opStateRaw.value
              : null;
        const opStateLabel = opStateString ? opStateString.split(".").pop() : "";
        const opStateFinished = /Finished/i.test(opStateLabel || "");
        const opStateActive = /(Run|Active|DelayedStart|InProgress)/i.test(opStateLabel || "");

        if (opStateActive) {
          hint.hadActive = true;
        }
        if (remainingSec !== null && remainingSec > 0) {
          hint.hadActive = true;
        }
        if (progNumeric !== undefined && progNumeric > 0 && progNumeric < 100) {
          hint.hadActive = true;
        }

        // Finished detection
        const finishedViaZero = hint.hadActive && remainingSec === 0;
        const isFinished = opStateFinished || progNumeric === 100 || finishedViaZero;
        if (isFinished && (opStateFinished || progNumeric === 100 || finishedViaZero)) {
          hint.hadActive = false;
        }

        // Determine percent: prefer explicit progress, otherwise estimate from initialRemaining if available
        let percent;
        if (progNumeric !== undefined) {
          percent = progNumeric;
        } else if (
          device._initialRemaining &&
          Number.isFinite(Number(device._initialRemaining)) &&
          Number(device._initialRemaining) > 0 &&
          remainingSec > 0
        ) {
          const init = Number(device._initialRemaining);
          percent = Math.max(0, Math.min(100, Math.round(((init - remainingSec) / init) * 100)));
        }

        // If we have remaining but no percent -> show indeterminate
        const isIndeterminate = percent === undefined && remainingSec > 0;

        let ProgessBar = "";
        if (isFinished) {
          ProgessBar = `<div class='hc-finished'>${_self.translate("PROGRAM_FINISHED")}</div>`;
        } else if (isIndeterminate) {
          ProgessBar = `<progress max='100' width='95%'></progress><span class='hc-progress-label'>${_self.translate("IN_PROGRESS")}</span>`;
        } else if (percent !== undefined) {
          ProgessBar = `<progress value='${percent}' max='100' width='95%'></progress><span class='hc-progress-label'>${percent}%</span>`;
        }

        const StatusString =
            remainingSec > 0 ? `${_self.translate("DONE_IN")} ${formatDuration(remainingSec)}` : "",
          Image = `${device.type}.png`,
          DeviceName = device.name;
        let container = "<div class='deviceContainer'>";
        if (_self.config.showDeviceIcon) {
          container += `<img src='modules/MMM-HomeConnect2/Icons/${Image}' class='device_img'>`;
        }
        container += "<div class='deviceStatusIcons'>";
        [
          device.PowerState === "On" || device.PowerState === "Standby"
            ? `<i class='fa fa-plug deviceStatusIcon' title='${device.PowerState}'></i>`
            : "",
          device.DoorState === "Open"
            ? "<i class='fa fa-door-open deviceStatusIcon' title='Door Open'></i>"
            : "",
          device.Lighting === true
            ? "<i class='fa fa-lightbulb-o deviceStatusIcon' title='Light On'></i>"
            : ""
        ].forEach((icon) => {
          if (icon) {
            container += icon;
          }
        });
        container += "</div>";
        container += `<div class='deviceName bright small'>${DeviceName}<br>`;
        container += "</div>"; // End deviceName
        container += "<div></div>"; // Empty gridcell for layout
        container += `<div class='deviceStatus dimmed xsmall'>${StatusString}</div>`;
        container += `<div class='deviceProgessBar'>${ProgessBar}</div>`;
        container += "</div>"; // End deviceContainer
        if (wrapper === "") {
          wrapper = container;
        } else {
          wrapper += container;
        }
      }
    });

    if (wrapper === "") {
      wrapper = `<div class='dimmed small'>${_self.translate("NO_ACTIVE_APPLIANCES")}</div>`;
    }
    div.innerHTML = wrapper;
    return div;
  },

  getAuthHTML() {
    let html = "";
    html += "<div class='auth-container'>";
    html += `<div class='auth-header'>🔐 ${this.translate("AUTH_TITLE")}</div>`;

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>📱 <strong>${this.translate("AUTH_STEP1")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    html += `<div class='auth-url'><a href='${this.authInfo.verification_uri}'>${this.authInfo.verification_uri}</a></div>`;
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>🔑 <strong>${this.translate("AUTH_STEP2")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    html += `<div class='auth-code'>${this.authInfo.user_code}</div>`;
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>🔗 <strong>${this.translate("AUTH_STEP_DIRECT")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    // Prefer QR SVG if provided by the helper; fallback to direct link
    if (this.authInfo.verification_qr_svg) {
      html += `<div class='auth-qr'>${this.authInfo.verification_qr_svg}</div>`;
    } else if (this.authInfo.verification_uri_complete) {
      html += `<div class='auth-url'><a href='${this.authInfo.verification_uri_complete}'>${this.authInfo.verification_uri_complete}</a></div>`;
    }
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-footer'>";
    html += `<div class='auth-timer'>⏱️ ${this.translate("AUTH_CODE_EXPIRES")} ${this.authInfo.expires_in_minutes} ${this.translate("AUTH_MINUTES")}</div>`;
    html += "</div>";

    html += `<div class='auth-waiting'>${this.translate("AUTH_WAITING")}</div>`;
    html += "</div>";

    return html;
  },

  getAuthStatusHTML() {
    let html = "";
    html += "<div class='auth-container'>";
    html += `<div class='auth-header'>⏳ ${this.translate("AUTH_STATUS_WAITING")}</div>`;

    // Progress bar
    if (this.authStatus.attempt && this.authStatus.maxAttempts) {
      const progress = Math.round((this.authStatus.attempt / this.authStatus.maxAttempts) * 100);
      html += "<div class='progress-container'>";
      html += "<div class='progress-bar'>";
      html += `<div class='progress-fill' style='width: ${progress}%'></div>`;
      html += "</div>";
      html += "</div>";
    }

    html += `<div class='auth-message'>${this.authStatus.message}</div>`;

    if (this.authStatus.interval) {
      html += `<div class='auth-info'>${this.translate("AUTH_POLL_INTERVAL")} ${this.authStatus.interval} ${this.translate("AUTH_SECONDS")}</div>`;
    }

    html += "</div>";

    return html;
  },

  getAuthErrorHTML() {
    let html = "";
    html += "<div class='auth-container error'>";
    html += `<div class='auth-header'>❌ ${this.translate("AUTH_FAILED_TITLE")}</div>`;
    html += `<div class='auth-message'>${this.authStatus.message}</div>`;
    html += `<div class='auth-info'>${this.translate("AUTH_FAILED_INFO")}</div>`;
    html += "</div>";

    return html;
  }
}); // End Module
