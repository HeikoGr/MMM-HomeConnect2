let config = {
  address: "0.0.0.0",
  port: 8080,
  basePath: "/",
  ipWhitelist: [],
  useHttps: false,
  language: "en",
  timeFormat: 24,
  units: "metric",
  modules: [
    { module: "alert" },
    {
      module: "MMM-Cursor",
      config: {
        timeout: 1500
      }
    },
    { module: "clock", position: "top_left" },

    {
      module: "MMM-APOD",
      position: "top_center",
      config: {
        appid: "YOUR_NASA_API_KEY", // NASA API key (api.nasa.gov)
        maxMediaWidth: 1900,
        maxMediaHeight: 1020
      }
    },

    {
      module: "MMM-HomeConnect2",
      header: "Home Connect Appliances",
      position: "top_right",
      config: {
        clientId: "YOUR_CLIENT_ID",
        apiLanguage: "en",
        showDeviceIcon: true,
        showDeviceIfInfoIsAvailable: true,
        progressRefreshIntervalMs: 30 * 1000,
        minActiveProgramIntervalMs: 10 * 60 * 1000
      }
    }
  ]
};

if (typeof module !== "undefined") {
  module.exports = config;
}
