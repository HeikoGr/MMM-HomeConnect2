"use strict";

const { deviceAppearsActive, isDeviceConnected } = require("./device-utils");

class DeviceService {
  constructor(options) {
    this.logger = options.logger;
    this.broadcastToAllClients = options.broadcastToAllClients;
    this.hc = null;
    this.devices = new Map();
    this.subscribed = false;
    this.globalSession = options.globalSession;
  }

  attachClient(hc) {
    this.hc = hc;
  }

  broadcastDevices(sendSocketNotification) {
    this.logger(
      "debug",
      `Broadcasting ${this.devices.size} devices to ${this.globalSession.clientInstances.size} clients`
    );
    this.globalSession.clientInstances.forEach(() => {
      sendSocketNotification(
        "MMM-HomeConnect_Update",
        Array.from(this.devices.values())
      );
    });
  }

  fetchDeviceStatus(device, sendSocketNotification) {
    if (this.hc && typeof this.hc.getStatus === "function") {
      this.hc
        .getStatus(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.status)) {
            res.data.status.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(device, event);
              }
            });
          }
          this.broadcastDevices(sendSocketNotification);
        })
        .catch((err) =>
          this.logger("error", `Status error for ${device.name}:`, err)
        );
      return;
    }
    this.logger(
      "error",
      `HomeConnect client missing getStatus wrapper - cannot fetch status for ${device.name}`
    );
  }

  fetchDeviceSettings(device, sendSocketNotification) {
    if (this.hc && typeof this.hc.getSettings === "function") {
      this.hc
        .getSettings(device.haId)
        .then((res) => {
          if (res.success && res.data && Array.isArray(res.data.settings)) {
            res.data.settings.forEach((event) => {
              if (this.hc && typeof this.hc.applyEventToDevice === "function") {
                this.hc.applyEventToDevice(device, event);
              }
            });
          }
          this.broadcastDevices(sendSocketNotification);
        })
        .catch((err) =>
          this.logger("error", `Settings error for ${device.name}:`, err)
        );
      return;
    }
    this.logger(
      "error",
      `HomeConnect client missing getSettings wrapper - cannot fetch settings for ${device.name}`
    );
  }

  processDevice(device, index, sendSocketNotification) {
    this.logger(
      "debug",
      `Processing device ${index + 1}: ${device.name} (${device.haId})`
    );
    this.logger(
      "debug",
      `Raw connected flag for ${device.name}:`,
      device.connected
    );
    this.devices.set(device.haId, device);

    const connected = isDeviceConnected(device);
    const appearsActive = deviceAppearsActive(device);

    if (connected) {
      this.logger(
        "info",
        `Device ${device.name} is connected - fetching status`
      );
      this.fetchDeviceStatus(device, sendSocketNotification);
      this.fetchDeviceSettings(device, sendSocketNotification);
    } else if (appearsActive) {
      this.logger(
        "info",
        `Device ${device.name} not marked connected but appears active - fetching status/settings as fallback`,
        { rawConnected: device.connected }
      );
      this.fetchDeviceStatus(device, sendSocketNotification);
      this.fetchDeviceSettings(device, sendSocketNotification);
    } else {
      this.logger("warn", `Device ${device.name} is not connected`);
    }
  }

  subscribeToDeviceEvents(deviceEventHandler) {
    if (!this.hc) {
      this.logger(
        "error",
        "HomeConnect client not attached - cannot subscribe"
      );
      return;
    }
    if (!this.subscribed) {
      this.logger("info", "Subscribing to device events...");
      this.hc.subscribe("NOTIFY", (e) => {
        deviceEventHandler(e);
      });
      this.hc.subscribe("STATUS", (e) => {
        deviceEventHandler(e);
      });
      this.hc.subscribe("EVENT", (e) => {
        deviceEventHandler(e);
      });
      this.subscribed = true;
      this.logger("info", "Event subscriptions established");
    } else {
      this.logger(
        "debug",
        "Already subscribed to device events - skipping duplicate subscription"
      );
    }
  }

  sortDevices() {
    const array = [...this.devices.entries()];
    const sortedArray = array.sort((a, b) => (a[1].name > b[1].name ? 1 : -1));
    this.devices = new Map(sortedArray);
  }

  handleGetDevicesSuccess(result, sendSocketNotification) {
    let appliances = [];
    if (Array.isArray(result?.body?.data?.homeappliances)) {
      appliances = result.body.data.homeappliances;
    } else if (Array.isArray(result?.data?.homeappliances)) {
      appliances = result.data.homeappliances;
    } else if (Array.isArray(result?.data)) {
      appliances = result.data;
    }

    this.logger(
      "info",
      `API response received - Found ${appliances.length} appliances`
    );

    if (appliances.length === 0) {
      this.logger("warn", "No appliances found - check Home Connect app");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "no_devices",
        message: "No devices found - check Home Connect app"
      });
    }

    appliances.forEach((device, index) => {
      this.processDevice(device, index, sendSocketNotification);
    });

    this.subscribeToDeviceEvents((e) =>
      this.deviceEvent(e, sendSocketNotification)
    );
    this.sortDevices();

    this.logger(
      "info",
      "Device processing complete - broadcasting to frontend"
    );
    this.broadcastDevices(sendSocketNotification);

    this.broadcastToAllClients("INIT_STATUS", {
      status: "complete",
      message: `${appliances.length} device(s) loaded`
    });
  }

  handleGetDevicesError(error) {
    this.logger(
      "error",
      "Failed to get devices:",
      error && error.stack ? error.stack : error
    );

    this.broadcastToAllClients("INIT_STATUS", {
      status: "device_error",
      message: `Device error: ${error.message}`
    });
  }

  getDevices(sendSocketNotification) {
    if (!this.hc) {
      this.logger("error", "HomeConnect not initialized - cannot get devices");
      this.broadcastToAllClients("INIT_STATUS", {
        status: "hc_not_ready",
        message: "HomeConnect not ready"
      });
      return;
    }

    this.logger("info", "Fetching devices from Home Connect API...");

    this.broadcastToAllClients("INIT_STATUS", {
      status: "fetching_devices",
      message: "Fetching devices..."
    });

    if (this.hc && typeof this.hc.getHomeAppliances === "function") {
      this.hc
        .getHomeAppliances()
        .then((res) => {
          if (res && res.success && res.data) {
            this.handleGetDevicesSuccess(res, sendSocketNotification);
          } else {
            const err = new Error(
              res && res.error ? res.error : "Failed to fetch appliances"
            );
            err.statusCode = res && res.statusCode ? res.statusCode : null;
            this.handleGetDevicesError(err);
          }
        })
        .catch((err) => this.handleGetDevicesError(err));
      return;
    }

    const err = new Error(
      "HomeConnect client missing getHomeAppliances wrapper - cannot fetch devices"
    );
    this.logger("error", err.message);
    this.handleGetDevicesError(err);
  }

  deviceEvent(data, sendSocketNotification) {
    try {
      const eventObj = JSON.parse(data.data);
      eventObj.items.forEach((item) => {
        if (item.uri) {
          const haId = item.uri.split("/")[3];
          if (this.hc && typeof this.hc.applyEventToDevice === "function") {
            this.hc.applyEventToDevice(this.devices.get(haId), item);
          } else {
            this.logger(
              "warn",
              "No event parser available for device events; update homeconnect-api client"
            );
          }
        }
      });
      this.broadcastDevices(sendSocketNotification);
    } catch (error) {
      this.logger("error", "Error processing device event:", error);
    }
  }
}

module.exports = DeviceService;
