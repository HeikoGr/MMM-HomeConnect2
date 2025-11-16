/* global Module, Log */
Module.register("MMM-HomeConnect2", {
  updated: 0,
  devices: [],
  config: null,
  authInfo: null,
  authStatus: null,
  instanceId: null,

  defaults: {
    header: "Home Connect Appliances",
    clientId: "",
    clientSecret: "",
    useHeadlessAuth: false, // Enable headless Device Flow authentication
    baseUrl: "https://api.home-connect.com/api",
    showDeviceIcon: true,
    showAlwaysAllDevices: false,
    showDeviceIfDoorIsOpen: true,
    showDeviceIfFailure: true,
    showDeviceIfInfoIsAvailable: true,
    updateFrequency: 1000 * 60 * 60,
    // Module logging level: none | error | warn | info | debug
    logLevel: "none"
  },

  init() {
    Log.log(`${this.name} is in init!`);
  },

  start() {
    Log.log(`${this.name} is starting!`);

    // Generate a unique instance ID
    this.instanceId = `hc_${Math.random().toString(36).substr(2, 9)}`;
    Log.log(`${this.name} instance ID: ${this.instanceId}`);

    this.updateTimer = setInterval(() => {
      this.sendSocketNotification("UPDATEREQUEST", null);
    }, this.config.updateFrequency);
  },

  loaded(callback) {
    Log.log(`${this.name} is loaded!`);
    callback();
  },

  getScripts() {
    // Use full module-relative path so the MagicMirror loader can find the file
    return ["modules/MMM-HomeConnect2/lib/device-utils-client.js"];
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
    if (
      payload &&
      payload.instanceId &&
      payload.instanceId !== this.instanceId
    ) {
      return;
    }

    switch (notification) {
      case "MMM-HomeConnect_Update":
        this.devices = payload || [];
        this.updateDom();
        // After initial device list arrives, request a snapshot of active programs
        // so RemainingProgramTime / ProgramProgress are populated even before SSE events come in.
        try {
          const haIds = this.devices
            .map((d) => d.haId || d.haid || d.id)
            .filter((id) => !!id);
          if (haIds.length > 0) {
            this.sendSocketNotification("GET_ACTIVE_PROGRAMS", {
              instanceId: this.instanceId,
              haIds
            });
          }
        } catch (e) {
          Log.error(`${this.name} failed requesting active programs: ${e}`);
        }
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
          Log.log(
            `${this.name} Init Status: ${payload.status} - ${payload.message}`
          );

          if (
            payload.status === "session_active" ||
            payload.status === "complete"
          ) {
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

  suspend() {
    Log.log(`${this.name} suspended`);
  },

  resume() {
    Log.log(`${this.name} resumed`);
  },

  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    Log.log(`${this.name} stopped`);
  },

  getDom() {
    const div = document.createElement("div");
    let wrapper = "";
    const _self = this;

    function parseRemainingSeconds(device) {
      try {
        if (window && window.HomeConnectDeviceUtils && typeof window.HomeConnectDeviceUtils.parseRemainingSeconds === 'function') {
          return window.HomeConnectDeviceUtils.parseRemainingSeconds(device);
        }
      } catch (e) { }
      return 0;
    }

    function parseProgress(device) {
      try {
        if (window && window.HomeConnectDeviceUtils && typeof window.HomeConnectDeviceUtils.parseProgress === 'function') {
          return window.HomeConnectDeviceUtils.parseProgress(device);
        }
      } catch (e) { }
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
      if (this.config.useHeadlessAuth) {
        div.innerHTML =
          "<div class='small'>" +
          `<i class='fa fa-cog fa-spin'></i> ${_self.translate("SESSION_BASED_AUTH")}<br>` +
          `<span class='dimmed'>${_self.translate("LOADING_APPLIANCES")}...</span>` +
          "</div>";
      } else {
        div.innerHTML = `<span class='small'>${_self.translate("LOADING_APPLIANCES")}...</span>`;
      }
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
      const doorOpen = device.DoorOpen || device.DoorState === "Open" || device.doorState === "Open";
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
        // Show progressbar if we have a remaining time > 0 OR a known progress value (including 0)
        let ProgessBar = "";
        if (remainingSec > 0 || progVal !== undefined) {
          const progressDisplay = progVal === undefined ? 0 : progVal;
          ProgessBar = `<progress value='${progressDisplay}' max='100' width='95%'></progress>`;
        }

        const StatusString =
          remainingSec > 0
            ? `${_self.translate("DONE_IN")} ${formatDuration(remainingSec)}`
            : "",
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
      const progress = Math.round(
        (this.authStatus.attempt / this.authStatus.maxAttempts) * 100
      );
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
