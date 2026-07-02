# MMM-HomeConnect2 (Headless Device Flow)

This module connects MagicMirror to BSH (Bosch, Siemens, Neff, Gaggenau, ...) devices. It uses the OAuth2 Device Flow so a browser is not required on the MagicMirror server.

## Overview
![Overview of appliance status](img/screenshot.png)

## Features
- Headless Device Flow authentication (no local browser needed)
- On-screen instructions and code for user authentication
- Token storage and automatic refresh
- Basic rate limiting and error handling

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/HeikoGr/MMM-HomeConnect2
cd MMM-HomeConnect2
npm install
```

## Update

```bash
cd ~/MagicMirror/modules/MMM-HomeConnect2
git pull
npm install
```

## Requirements

- You need to have a registered Home Connect account with email and password and connected Home Connect devices.
- You also need to register for a Home Connect Developer Account [Home Connect Registration](https://developer.home-connect.com/user/register).
- You also need to register an application in the developer portal to get a Client ID.
- A client secret is optional for this headless flow. If your Home Connect application provides one, you can still configure it.

## Configuration

All module options are optional unless stated otherwise. In practice, only clientId is required for normal use. New runtime protection settings such as apiRequestTimeoutMs and sseRecoveryCooldownMs have built-in defaults and do not need to be added to your MagicMirror config unless you want to override them.

Simple config example for your MagicMirror `config/config.js`:

```js
{
    module: "MMM-HomeConnect2",
    position: "top_left",
    config: {
        clientId: "YOUR_CLIENT_ID",
        apiLanguage: "en",
        showDeviceIcon: true,
        showDeviceIfInfoIsAvailable: true,
        apiRequestTimeoutMs: 15 * 1000,
        sseRecoveryCooldownMs: 60 * 1000,
        progressRefreshIntervalMs: 30 * 1000,
        minActiveProgramIntervalMs: 10 * 60 * 1000
    }
},
```

Common module options
- clientId: Required. Home Connect application client ID.
- clientSecret: Optional. Only needed if your Home Connect application uses one.
- apiLanguage: Optional. Preferred Home Connect API language. Examples: en, de, da, en-GB. Default: auto-detect from MagicMirror/browser language.
- showDeviceIcon: Optional. Default: true.
- showDeviceIfInfoIsAvailable: Optional. Also display devices when program or status information is available even if the device is otherwise idle. Default: true.
- showAlwaysAllDevices: Optional. Always render all appliances, even when they are currently idle. Default: false.
- enableSSEHeartbeat: Optional. Enable SSE health monitoring. Default: true.
- sseHeartbeatCheckIntervalMs: Optional. SSE health check interval. Default: 60000.
- sseHeartbeatStaleThresholdMs: Optional. Silence threshold before SSE is considered stale. Default: 180000.
- apiRequestTimeoutMs: Optional. Hard timeout for Home Connect HTTP requests. Helps the module recover from hanging network/API calls during startup, resume, and refresh. Default: 15000.
- sseRecoveryCooldownMs: Optional. Minimum delay between automatic watchdog recovery polls when a previously active SSE stream goes stale. Default: max(sseHeartbeatStaleThresholdMs, 2 x sseHeartbeatCheckIntervalMs, 60000).
- progressRefreshIntervalMs: Optional. Frontend-only refresh interval for countdown/progress rendering. Default: 30000.
- minActiveProgramIntervalMs: Optional. Backend throttle for non-forced active-program snapshot requests. Default: 600000.
- logLevel: Optional. Module log verbosity: none, error, warn, info, debug.

Display behavior
- By default the module focuses on appliances with meaningful state such as active programs, failures, open doors, lighting, or other available program/status data.
- Set showAlwaysAllDevices to true if you prefer a static list of all appliances.
- Set logLevel to debug to show the built-in debug panel and progress-source diagnostics in the frontend.

Typical frontend states
- Running appliances show their current program, remaining time, and a progress indicator.
- Appliances with a selected program can still be shown when showDeviceIfInfoIsAvailable is enabled.
- Authentication, loading, empty-state, and debug-panel views are covered by the frontend render tests.

### Authentication / Device Flow
![Authentication Workflow visualisation](img/pic01_auth.png)

How authentication works:
- First time: module shows a URL and a short code on the MagicMirror screen.
- Open that URL on any device, enter the code and grant access.
- The module saves tokens locally and uses them to call the API.

If the token expires, the module will automatically refresh it when possible.

Troubleshooting
- If you see "polling too quickly" errors, wait a minute and try again.
- Check logs with `pm2 logs mm` or in your terminal.
- Token file: `MMM-HomeConnect2/refresh_token.json` in the module directory (do not commit this file).

Network protection and request rate limits
- The module does not poll the Home Connect API continuously in the background.
- Regular device updates are expected to come from SSE after the initial device fetch.
- Non-forced active-program snapshot requests are throttled by minActiveProgramIntervalMs, which defaults to 10 minutes.
- Automatic active-program retries are capped at 3 attempts per device with a 5 second delay between attempts.
- SSE watchdog recovery only starts after the module has received at least one SSE event, and is then rate-limited by sseRecoveryCooldownMs.
- In debug logLevel, the frontend debug panel now shows observed SSE gap statistics so you can compare real event spacing with your stale threshold.
- Concurrent overlapping active-program fetches are deduplicated so resume and recovery paths do not fan out into parallel program requests.
- If the Home Connect API responds with HTTP 429, the module enters a backoff window before allowing more non-forced program fetches.
- EventSource reconnects after SSE transport errors back off to 5 seconds for generic transport errors and 30 seconds for auth-related or 429-like SSE failures.

Testing
- `npm test` runs the deterministic unit test suite.
- The unit test suite includes backend helpers and frontend render coverage for typical device and auth states.
- The optional live smoke test is disabled by default.
- To enable it, run `HC_RUN_LIVE_SMOKE_TEST=1 npm test`.
- For the live smoke test you can optionally provide `HC_CLIENT_ID` and `HC_CLIENT_SECRET`. If `HC_CLIENT_ID` is missing, the runner tries to read the MagicMirror config.

Security
- Keep `clientSecret` and `refresh_token.json` private. Do not commit them to git.

Developer notes
- API endpoints used: device_authorization, token, and homeappliances endpoints of Home Connect.
- Minimum polling interval: 5 seconds. Module adapts if server returns slow_down.

## Architecture Contract (API Truth vs. Session FSM)

This module follows a strict separation of responsibilities:

- API truth is authoritative: Device/program fields from Home Connect API and SSE always win and overwrite local values.
- Session FSM is orchestration only: The state machine controls auth/init/rate-limit/retry/error flow, not appliance truth.
- No reverse coupling: FSM transitions must never modify device/program domain values.
- One-way data flow for appliance truth: API/SSE -> service mapping -> shared device store -> frontend rendering.
- Frontend does not infer alternate truth: UI renders API-backed device data plus optional FSM/debug metadata.

Scope boundaries
- FSM scope includes: boot, authenticating, initializing, ready, rate_limited, error, plus technical refresh states.
- FSM scope excludes: PowerState, ActiveProgramName, RemainingProgramTime, ProgramProgress, and other appliance fields.

Review checklist for changes
- Does this change alter appliance data without an API/SSE payload? If yes, reject.
- Does this change add FSM logic that writes device/program fields? If yes, reject.
- Does this change keep orchestration decisions (when to fetch/auth/retry) inside the helper/session FSM? If no, refactor.
- Do tests still cover both dimensions: FSM transitions and API-data overwrite behavior? If no, add tests.

## Documentation

Additional development and devcontainer documentation is collected in [docs/README.md](docs/README.md).

## Comparison to the original

This fork is based on djerik's [MMM-HomeConnect](https://github.com/djerik/MMM-HomeConnect).

**Main differences:**
- **Device Flow only** — no built-in Express server or browser-based OAuth fallback; optimized for headless environments
- **QR code authentication** — scan the URL directly with your phone
- **Reduced dependencies** — removed `express` and `open` packages
- **Improved error handling** — better logging and token refresh logic

**When to use the original:** If you prefer automatic browser-based OAuth or need the exact original implementation.

**Credits:** Many thanks to djerik for the original module.