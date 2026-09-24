# Configuration

## Core Options

| Option | Description |
| --- | --- |
| `clientId` | Required Home Connect application client ID. |
| `clientSecret` | Optional client secret when your developer app requires one. |
| `logLevel` | Optional: `none`, `error`, `warn`, `info`, `debug`. All output (browser console, `pm2 logs`, including the Home Connect client's SSE and token messages) goes through MagicMirror's `Log`, so the global `logLevel` in `config.js` decides; this option can only narrow it for this module (`none` silences it). Default: empty, the global level alone. `debug` also shows the debug panel. |

## Rendering Options

| Option | Description |
| --- | --- |
| `header` | Module header text. |
| `showDeviceIcon` | Show appliance icons. |
| `showDeviceIfInfoIsAvailable` | Keep devices visible when useful status data exists, even if they are idle. |
| `showDeviceIfDoorIsOpen` | Keep a device visible while its door is open, even if otherwise idle. |
| `showDeviceIfFailure` | Keep a device visible while it reports a failure/error state. |
| `showAlwaysAllDevices` | Always render all appliances regardless of current state. |

## Optional Tuning

Both have sensible defaults and are rarely needed.

| Option | Description |
| --- | --- |
| `apiRequestTimeoutMs` | Timeout for one Home Connect request. Default: 15 s. |
| `progressRefreshIntervalMs` | How often the display redraws countdowns and progress. Default: 30 s, minimum 5 s. |

The watch on the live event stream needs no settings: Home Connect sends a keep-alive
about every 55 seconds, so a stream that stays silent for 70 seconds is rebuilt
automatically. Older options for it (`enableSSEHeartbeat`, `sseHeartbeatCheckIntervalMs`,
`sseHeartbeatStaleThresholdMs`, `sseRecoveryCooldownMs`) and `minActiveProgramIntervalMs`
are no longer used and can be removed from `config.js`.

## Multiple Displays

All browsers that open the same MagicMirror share one Home Connect session: one API
session, one SSE stream, one refresh token. A second display (phone, tablet, second
kiosk) therefore causes no additional API load.

Config options fall into two groups:

- **Session options** (`clientId`, `clientSecret`, `logLevel`, `apiRequestTimeoutMs`)
  exist once per server. The first display that connects establishes them; if a later display
  asks for different values, the session values still apply and the backend logs a
  warning naming the differing keys. The later display itself shows nothing.
- **Rendering options** (`showDeviceIcon`, `showDeviceIf*`, `showAlwaysAllDevices`,
  `header`, `progressRefreshIntervalMs`) are evaluated in the browser and may differ
  per display without any warning.

A display stays registered as long as its browser is connected. When a browser closes,
the backend stops addressing it after 10 minutes; after a server restart the open displays
register again on their own, without a page reload.

Only different credentials (`clientId` / `clientSecret`) are a hard conflict, because
they point at a different Home Connect account. Such a display is rejected and shows
the configuration-mismatch banner.

## Language

The module follows MagicMirror's `language` setting everywhere: its own texts and the
texts Home Connect sends (program names, phases, options). There is no separate
language option; `apiLanguage` from older versions is ignored (the log says so once).

After a change to `config.js` and a restart of MagicMirror, a browser tab that was
open before still runs the old configuration. It is recognised and reloads itself
once, so no display keeps showing the previous language or settings.

## Status Icons

The status icon follows the appliance's reported `OperationState` and nothing else:

| Operation state | Icon |
| --- | --- |
| `Run` | play |
| `Pause` | pause |
| `DelayedStart` | clock |
| `Inactive`, `Ready`, `Finished`, `ActionRequired`, `Aborting`, `Error` | power state only |
| missing or unrecognised | power state only |

Remaining times and progress values are deliberately not used to infer that a program
is running: they routinely survive a finished program and are also reported for a
merely selected one. If the appliance does not tell us it is running, no play icon is
shown - the progress bar and remaining time still render.

The same rule applies to the selected program: `Selected program: Synthetics` only
appears while that program is running or scheduled via delayed start. On an idle
appliance the selected program is just the current dial position and says nothing
about what the machine is doing, so it stays hidden.

## Display Behavior

- By default the module focuses on appliances with meaningful state.
- Set `showAlwaysAllDevices` if you prefer a static appliance list.
- Use `logLevel: "debug"` if you want the frontend debug panel and extra diagnostics.