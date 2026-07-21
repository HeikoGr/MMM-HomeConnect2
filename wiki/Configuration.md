# Configuration

## Core Options

| Option | Description |
| --- | --- |
| `clientId` | Required Home Connect application client ID. |
| `clientSecret` | Optional client secret when your developer app requires one. |
| `apiLanguage` | Preferred Home Connect API language, for example `en`, `de`, or `da`. |
| `logLevel` | Logging verbosity: `none`, `error`, `warn`, `info`, `debug`. |

## Rendering Options

| Option | Description |
| --- | --- |
| `showDeviceIcon` | Show appliance icons. |
| `showDeviceIfInfoIsAvailable` | Keep devices visible when useful status data exists, even if they are idle. |
| `showAlwaysAllDevices` | Always render all appliances regardless of current state. |

## Timing And Recovery Options

| Option | Description |
| --- | --- |
| `apiRequestTimeoutMs` | Hard timeout for HTTP requests. |
| `sseRecoveryCooldownMs` | Minimum wait time before another automatic SSE rebuild. |
| `progressRefreshIntervalMs` | Frontend refresh interval for countdowns and progress indicators. |
| `minActiveProgramIntervalMs` | Backend throttle for non-forced active-program snapshot requests. |
| `enableSSEHeartbeat` | Enable SSE health monitoring. |
| `sseHeartbeatCheckIntervalMs` | How often the heartbeat is checked. |
| `sseHeartbeatStaleThresholdMs` | Silence threshold before SSE is considered stale. |

## Display Behavior

- By default the module focuses on appliances with meaningful state.
- Set `showAlwaysAllDevices` if you prefer a static appliance list.
- Use `logLevel: "debug"` if you want the frontend debug panel and extra diagnostics.