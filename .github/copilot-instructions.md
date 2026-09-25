# GitHub Copilot repository instructions (strict)

## Scope and safety

- Only change code and files inside this repository.
- Keep changes minimal and directly related to the request/issue.
- Do not introduce new dependencies unless explicitly required; if you do, update `package.json` (and existing lockfiles).
- Never commit secrets (tokens, API keys, session cookies, personal data).

## MagicMirror module conventions

- Preserve the standard MagicMirror module structure and naming (e.g., `MMM-*.js`, `node_helper.js`, `translations/`, `*.css`).
- Keep the public module API stable (`Module.register`, notification handling, config schema) unless the request requires a breaking change.
- Prefer predictable caching and clear logging for external API calls.

## This module's architecture

- Shared infrastructure comes from the `lib/mmm-shared` submodule (`createTransport`,
  `createNodeTransport`, `createLogger`, `createLifecycle`). Do not change it here and do not
  reimplement polling or suspend/resume handling locally.
- The backend owns the data cadence (SSE plus a 30-minute snapshot). The frontend lifecycle has
  no `onFetch`: it only gates rendering while hidden and drives the visual progress tick
  (`onVisibleTick`). Render through `lifecycle.render()`, not `updateDom()`.
- One Home Connect session serves every display. The first `CONFIGURE` opens it; later clients
  with different `clientId`/`clientSecret` are rejected (`CRITICAL_CONFIG_KEYS` /
  `rejectConfigMismatch`), other session keys only cause a backend warning. The frontend sends
  `CONFIGURE` once, at `ALL_MODULES_STARTED`, with its core-assigned `identifier` as instance id,
  and again when the backend asks with `INIT_REQUIRED`.
- Which displays are registered follows their browser sockets (`createClientRegistry` in
  `lib/mmm-shared/backend-session.js`): a display whose socket is gone for 10 minutes is dropped from
  `clientInstances`; every new connection is greeted with `INIT_REQUIRED`. There is no
  time-based pruning - a display that stays connected stays registered.
  It comes from the `lib/mmm-shared` submodule (tests there); change it in the mmm-shared repo.
- `lib/device-utils.js` is loaded twice: via `require` in the backend and via `getScripts()` in
  the browser. Keep it free of Node-only and DOM-only APIs. The same holds for
  `lib/display-state.js` (what a device card shows: progress, program line, status texts).
- Backend layout: `node_helper.js` (~420 lines) keeps the fields, the status emitters, the
  snapshot timer and socket dispatch. Method groups live in their own files and are spread
  into the helper definition (they work on the helper's state, so tests keep calling them on
  the helper): `lib/auth-orchestration.js` (token, device flow, init, retries),
  `lib/client-sessions.js` (CONFIGURE handling, owner config, rejection),
  `lib/debug-stats.js` (debug panel data, SSE hooks). Real classes with their own state:
  `lib/program-fetch-coordinator.js` (active-program admission and fetch loop; the helper's
  `handleGetActivePrograms`/`fetchActiveProgramsForDevices` delegate to it). Pure helpers:
  `lib/session-config.js`, `lib/token-store.js`, `lib/status-messages.js`.
- The DOM is built with `lib/dom-builder.js` and `lib/device-card-renderer.js`; API values only
  ever become text nodes. Never assign `innerHTML` - the frontend tests use a fake DOM whose
  `innerHTML` setter throws.
- `refresh_token.json` is a credential: written with mode `0600`, gitignored, never logged.
- `rate_limit.json` (`lib/rate-limit-store.js`, gitignored) keeps an API block across restarts;
  `setRateLimitUntil()` writes it, `init()` restores it, `checkTokenAndInitialize()` waits it out.
  The block holds for every automatic path: a 429 during init sets it and the init retry waits
  (`lib/auth-orchestration.js`), forced active-program requests and their retries are skipped.
- Backend code logs through `log.debug|info|warn|error(message, ...details)` from
  `lib/logger.js`, which sits on `createLogger` from `mmm-shared` and writes through MagicMirror's
  `Log` (global `logLevel`; the session `logLevel` can only narrow it; redaction
  of token/secret/device code). The services, `ActiveProgramManager` and `lib/homeconnect-api.js`
  get the same `log` object injected as `logger`. `node_helper.js` installs the output sink
  (`setLogSink`): it calls MagicMirror's `Log` from that file, so lines are tagged
  `[MMM-HomeConnect2]`, and writes each entry as one line (`formatLogEntry`). Do not add direct
  `console.*` calls. Messages
  that repeat on every snapshot or per device belong on `debug`; `info` gets one summary per cycle.
- Frontend views: `lib/device-card-renderer.js` (appliance cards), `lib/status-views.js` (device
  flow, status banners, debug panel), `lib/display-state.js` (card state). `MMM-HomeConnect2.js`
  keeps state and composes them in `getDom()`.
- A HomeConnect init that exceeds `hcInitTimeoutMs` goes through `handleHomeConnectInitError`
  (hc_error + retry); a late answer only counts while that client is still `this.hc`.

## Quality bar

- Follow the repository's existing Biome configuration.
- Avoid broad refactors “for cleanliness”; do focused edits.
- Run `node --run test` and `node --run lint` after every change.

## References

- GitHub Copilot repository instructions: https://docs.github.com/de/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- MagicMirror² documentation: https://docs.magicmirror.builders/
- MagicMirror² module development: https://docs.magicmirror.builders/development/module-development.html
- MagicMirror² configuration reference: https://docs.magicmirror.builders/configuration/introduction.html
- Node.js documentation: https://nodejs.org/en/docs
- npm CLI documentation: https://docs.npmjs.com/cli/
- Home Connect Developer Portal (API reference, OAuth device flow): https://developer.home-connect.com/
