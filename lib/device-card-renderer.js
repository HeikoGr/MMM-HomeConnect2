"use strict";

// Builds the DOM for one appliance card from the display state the module
// computes (buildDeviceDisplayState). Pure presentation: no API access, no
// module state. All API-derived values are inserted as text via the DOM builder.
//
// Loaded in the browser via getScripts() after dom-builder.js (exposed as
// window.HomeConnectDeviceCardRenderer) and required directly in Node tests.
(() => {
  const { h } =
    typeof module !== "undefined" && module.exports ? require("./dom-builder") : window.HomeConnectDomBuilder;

  function statusIcon(iconClass, title, extraClass) {
    const classes = ["fa", iconClass, "deviceStatusIcon"];
    if (extraClass) {
      classes.push(extraClass);
    }
    return h("i", { class: classes.join(" "), title });
  }

  function renderStatusIcons(device, runtime) {
    const poweredOn = device.PowerState !== "Off";
    let programIcon = null;
    if (runtime.explicitlyDisconnected) {
      programIcon = statusIcon("fa-chain-broken", "Device not connected", "deviceStatusIconOffline");
    } else if (poweredOn && runtime.operationStateDelayedStart) {
      programIcon = statusIcon("fa-clock-o", "Delayed start");
    } else if (poweredOn && runtime.operationStatePaused) {
      programIcon = statusIcon("fa-pause", "Program paused");
    } else if (poweredOn && runtime.programRunning) {
      programIcon = statusIcon("fa-play", "Program running");
    }

    const icons = [];
    if (programIcon) {
      icons.push(programIcon);
    } else if (device.PowerState === "On" || device.PowerState === "Standby") {
      icons.push(statusIcon("fa-toggle-on", device.PowerState));
    } else if (device.PowerState === "Off") {
      icons.push(statusIcon("fa-toggle-off", "Power off"));
    }

    if (device.DoorState === "Open") {
      icons.push(statusIcon("fa-door-open", "Door Open"));
    }
    if (device.Lighting === true) {
      icons.push(statusIcon("fa-lightbulb-o", "Light On"));
    }

    return h("div", { class: "deviceStatusIcons" }, icons);
  }

  function renderProgress(displayState, translate) {
    const { presentation, runtime } = displayState;

    if (presentation.delayedStartText) {
      return h("div", { class: "hc-finished" }, presentation.delayedStartText);
    }
    if (runtime.wrinkleProtectionActive) {
      return h("div", { class: "hc-finished" }, translate("WRINKLE_PROTECTION_ACTIVE"));
    }
    if (runtime.isFinished) {
      return h("div", { class: "hc-finished" }, translate("PROGRAM_FINISHED"));
    }
    if (runtime.isIndeterminate) {
      return [
        h("progress", { max: 100, width: "95%" }),
        h("span", { class: "hc-progress-label" }, translate("IN_PROGRESS")),
      ];
    }
    if (runtime.percent !== undefined) {
      return [
        h("progress", { value: runtime.percent, max: 100, width: "95%" }),
        h("span", { class: "hc-progress-label" }, `${runtime.percent}%`),
      ];
    }
    return null;
  }

  function renderDeviceIcon(displayState, iconUrl) {
    if (displayState.imageName) {
      return h("img", { src: iconUrl(displayState.imageName), class: "device_img" });
    }
    return h("div", { class: "device_img deviceIconFallback" }, [
      h("i", { class: `fa ${displayState.fallbackIconClass}` }),
    ]);
  }

  // options: { device, displayState, showDeviceIcon, translate, iconUrl }
  function renderDeviceCard({ device, displayState, showDeviceIcon, translate, iconUrl }) {
    const { runtime, presentation } = displayState;
    const containerClasses = ["deviceContainer"];
    if (!showDeviceIcon) {
      containerClasses.push("deviceContainerWithoutDeviceIcon");
    }
    if (runtime.explicitlyDisconnected) {
      containerClasses.push("deviceOffline");
    }

    const optionalLine = (className, text) => (text ? h("div", { class: className }, text) : null);

    return h("div", { class: containerClasses.join(" ") }, [
      showDeviceIcon ? renderDeviceIcon(displayState, iconUrl) : null,
      renderStatusIcons(device, runtime),
      h("div", { class: "deviceName bright small" }, [
        h("span", { class: "deviceNameLabel" }, displayState.deviceName),
        optionalLine("deviceProgram dimmed xsmall", presentation.programMeta),
        optionalLine("deviceProgramDetails dimmed xsmall", presentation.programSupplement),
        optionalLine("deviceProgramDetails dimmed xsmall", presentation.detailText),
        optionalLine("deviceAlert xsmall", presentation.alertText),
      ]),
      h("div", { class: "deviceStatus dimmed xsmall" }, presentation.statusText),
      h("div", { class: "deviceProgressBar" }, renderProgress(displayState, translate)),
      presentation.showProgressDebug ? h("div", { class: "hc-device-debug" }, presentation.progressDebug) : null,
    ]);
  }

  const exportsObj = { renderDeviceCard };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportsObj;
  }

  if (typeof window !== "undefined") {
    window.HomeConnectDeviceCardRenderer = exportsObj;
  }
})();
