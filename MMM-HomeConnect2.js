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
  debugStats: null,

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
    sseHeartbeatCheckIntervalMs: 60 * 1000, // 1 minute
    sseHeartbeatStaleThresholdMs: 3 * 60 * 1000, // 3 minutes
    minActiveProgramIntervalMs: 10 * 60 * 1000, // 10 minutes between active program fetches (backend throttle)
    // Module logging level: none | error | warn | info | debug
    logLevel: ""
  },

  start() {
    // Generate a unique instance ID
    this.instanceId = `hc_${Math.random().toString(36).substr(2, 9)}`;
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

    const safePayload = payload || {};

    switch (notification) {
      case "MMM-HomeConnect_Update":
        this.devices = safePayload || [];
        this.updateDom();
        // After initial device list arrives, request a snapshot of active programs
        // so RemainingProgramTime / ProgramProgress are populated even before SSE events come in.
        this.scheduleActiveProgramSnapshot();
        break;
      case "AUTH_INFO":
        this.authInfo = safePayload;
        this.updateDom();
        break;
      case "AUTH_STATUS":
        this.authStatus = safePayload;
        this.updateDom();
        break;
      case "INIT_STATUS": {
        Log.log(`${this.name} Init Status: ${safePayload.status} - ${safePayload.message}`);
        this.lastInitStatus = safePayload;

        if (safePayload.status === "session_active" || safePayload.status === "complete") {
          // Session active - normal display
          this.authInfo = null;
          this.authStatus = null;
        } else if (safePayload.status === "auth_in_progress") {
          // Authentication already in progress (special auth UI)
          this.authStatus = {
            status: "polling",
            message: safePayload.message
          };
        }
        this.updateDom();
        break;
      }
      case "DEBUG_STATS":
        this.debugStats = safePayload || {};
        this.updateDom();
        break;
      default:
        break;
    }
  },

  suspend() {
    this.suspended = true;
  },

  resume() {
    this.suspended = false;
    // On resume, trigger a revalidation: request a fresh device update and
    // explicitly request active program snapshots so UI resumes reflecting
    // currently running programs immediately.
    try {
      this.lastActiveProgramRequestTs = 0;
      this.requestStateRefresh({ forceRefresh: true, bypassActiveProgramThrottle: true });

      const haIds = this.devices
        .map((d) => d.haId || d.haid || d.id)
        .filter((id) => typeof id === "string" && id.length);

      setTimeout(() => {
        try {
          this.sendSocketNotification("GET_ACTIVE_PROGRAMS", {
            instanceId: this.instanceId,
            haIds,
            force: true
          });
        } catch (err) {
          Log.error(`${this.name} resume fallback active program request failed: ${err}`);
        }
      }, 1500);
    } catch (e) {
      Log.error(`${this.name} resume actions failed: ${e}`);
    }
  },

  stop() {
    // No periodic frontend polling timers needed; state is driven by SSE and
    // rare backend polling when SSE is unhealthy.
  },

  scheduleActiveProgramSnapshot() {
    try {
      const haIds = this.devices.map((d) => d.haId || d.haid || d.id).filter((id) => !!id);
      if (!haIds.length) {
        return;
      }

      const now = Date.now();
      const elapsed = now - (this.lastActiveProgramRequestTs || 0);
      const minInterval =
        typeof this.config.minActiveProgramIntervalMs === "number"
          ? Math.max(0, this.config.minActiveProgramIntervalMs)
          : this.defaults.minActiveProgramIntervalMs;

      if (!this.lastActiveProgramRequestTs || elapsed >= minInterval) {
        this.lastActiveProgramRequestTs = now;
        this.requestStateRefresh({ haIds });
      }
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
      const loadingHtml =
        "<div class='small'>" +
        `<i class='fa fa-cog fa-spin'></i> ${_self.translate("SESSION_BASED_AUTH")}<br>` +
        `<span class='dimmed'>${_self.translate("LOADING_APPLIANCES")}...</span>` +
        "</div>";
      div.innerHTML = loadingHtml;
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
        const opStatePaused = /Pause/i.test(opStateLabel || "");

        // If the device is powered off, treat it as not active and clear any previous activity hint
        if (device.PowerState === "Off") {
          hint.hadActive = false;
        }

        if (opStateActive && device.PowerState !== "Off") {
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

        // Program state icon has priority over power icon, but never when device is off
        let programIcon = "";
        if (device.PowerState !== "Off" && opStatePaused) {
          programIcon =
            "<i class='fa fa-pause deviceStatusIcon' title='Program paused'></i>";
        } else if (device.PowerState !== "Off" && opStateActive && !opStateFinished) {
          programIcon =
            "<i class='fa fa-play deviceStatusIcon' title='Program running'></i>";
        }

        const statusIcons = [];

        if (programIcon) {
          statusIcons.push(programIcon);
        } else if (device.PowerState === "On" || device.PowerState === "Standby") {
          statusIcons.push(
            `<i class='fa fa-toggle-on deviceStatusIcon' title='${device.PowerState}'></i>`
          );
        } else if (device.PowerState === "Off") {
          statusIcons.push(
            "<i class='fa fa-toggle-off deviceStatusIcon' title='Power off'></i>"
          );
        }

        if (device.DoorState === "Open") {
          statusIcons.push(
            "<i class='fa fa-door-open deviceStatusIcon' title='Door Open'></i>"
          );
        }

        if (device.Lighting === true) {
          statusIcons.push(
            "<i class='fa fa-lightbulb-o deviceStatusIcon' title='Light On'></i>"
          );
        }

        statusIcons.forEach((icon) => {
          container += icon;
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

    const debugPanel = this.getDebugPanel();
    if (debugPanel) {
      wrapper += debugPanel;
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

  getDebugPanel() {
    const logLevel = (this.config?.logLevel || this.defaults.logLevel || "none").toLowerCase();
    if (logLevel !== "debug" || !this.debugStats) {
      return "";
    }
    const formatTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "n/a");
    const rows = [];

    // Status from INIT_STATUS gets rendered only in debug mode
    if (this.lastInitStatus && this.lastInitStatus.message) {
      rows.push(
        `<div class='hc-debug-row'><span class='hc-debug-label'>last init status:</span> ${this.lastInitStatus.message
        }</div>`
      );
    }

    rows.push(
      `<div class='hc-debug-row'><span class='hc-debug-label'>SSE:</span> ${formatTime(
        this.debugStats.lastSseEventTs
      )}</div>`
    );
    rows.push(
      `<div class='hc-debug-row'><span class='hc-debug-label'>API:</span> ${formatTime(
        this.debugStats.lastApiCallTs
      )}</div>`
    );
    const counters = this.debugStats.apiCounters || {};
    const counterEntries = Object.entries(counters);
    if (counterEntries.length) {
      rows.push("<div class='hc-debug-subtitle'>API counts</div>");
      counterEntries.sort(([a], [b]) => a.localeCompare(b));
      counterEntries.forEach(([name, value]) => {
        rows.push(
          `<div class='hc-debug-row'><span class='hc-debug-label'>${name}</span> ${value}</div>`
        );
      });
    }
    return `<div class='hc-debug-panel'>${rows.join("")}</div>`;
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
