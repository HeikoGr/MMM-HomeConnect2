"use strict";

/*
 * Which config keys belong to the one shared HomeConnect session, and how a
 * later client's config compares with the session owner's.
 */

// Config keys that shape the shared HomeConnect session. All displays are served
// by one API session and one SSE stream, so these settings can only exist once.
// Everything else (showDeviceIcon, showDeviceIf*, header, progressRefreshIntervalMs,
// ...) is evaluated in the browser and may legitimately differ per display.
const SESSION_CONFIG_KEYS = Object.freeze([
  "apiLanguage",
  "apiRequestTimeoutMs",
  "clientId",
  "clientSecret",
  "enableSSEHeartbeat",
  "logLevel",
  "minActiveProgramIntervalMs",
  "ssePreSubscribeRefreshMs",
  "sseRecoveryCooldownMs",
  "sseHeartbeatCheckIntervalMs",
  "sseHeartbeatStaleThresholdMs",
]);

// Different credentials mean a different HomeConnect account - the shared session
// cannot serve such a client at all, so it is turned away. Every other difference
// is harmless enough to just log: the session settings simply keep precedence.
const CRITICAL_CONFIG_KEYS = Object.freeze(["clientId", "clientSecret"]);

// The API language is baked into the shared device data (Accept-Language), so it
// can only be resolved once - by the client that opens the session. An explicitly
// configured value always wins over the browser-derived hint.
function resolveSessionLanguage(config = {}) {
  const configured = typeof config.apiLanguage === "string" ? config.apiLanguage.trim() : "";
  if (configured) {
    return configured;
  }

  const preferred = typeof config.preferredApiLanguage === "string" ? config.preferredApiLanguage.trim() : "";
  return preferred;
}

/** @returns {string[]} Credential keys in which the client differs from the session owner */
function findCredentialMismatchKeys(ownerConfig, clientConfig) {
  return CRITICAL_CONFIG_KEYS.filter((key) => ownerConfig[key] !== clientConfig[key]);
}

/** @returns {string[]} Session keys the client asked for differently (and will not get) */
function findIgnoredSessionKeys(ownerConfig, clientConfig) {
  return SESSION_CONFIG_KEYS.filter((key) => (ownerConfig[key] ?? null) !== (clientConfig[key] ?? null));
}

module.exports = {
  CRITICAL_CONFIG_KEYS,
  SESSION_CONFIG_KEYS,
  findCredentialMismatchKeys,
  findIgnoredSessionKeys,
  resolveSessionLanguage,
};
