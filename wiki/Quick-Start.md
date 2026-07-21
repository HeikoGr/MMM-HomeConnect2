# Quick Start

Add a minimal block like this to your MagicMirror `config/config.js`:

```js
{
  module: "MMM-HomeConnect2",
  position: "top_left",
  config: {
    clientId: "YOUR_CLIENT_ID",
    apiLanguage: "en",
    showDeviceIcon: true,
    showDeviceIfInfoIsAvailable: true,
  },
}
```

## What Happens Next

- On first start, the module shows a verification URL and code.
- You open that URL on another device and approve access.
- The module stores refresh data locally and uses it for future sessions.

If you want the full authentication walkthrough, continue with [Authentication](Authentication).