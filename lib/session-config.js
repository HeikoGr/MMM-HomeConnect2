"use strict";

const { isDeepStrictEqual } = require("node:util");

/*
 * Which config keys belong to the one shared HomeConnect session, how a later
 * client's config compares with the session owner's, and whether a client still
 * runs the config MagicMirror loaded at startup.
 */

// Config keys that shape the shared HomeConnect session. All displays are served
// by one API session and one SSE stream, so these settings can only exist once.
// Everything else (showDeviceIcon, showDeviceIf*, header, progressRefreshIntervalMs,
// ...) is evaluated in the browser and may legitimately differ per display.
// "language" is MagicMirror's own setting, which the module follows.
const SESSION_CONFIG_KEYS = Object.freeze(["clientId", "clientSecret", "language", "logLevel"]);

// Different credentials mean a different HomeConnect account - the shared session
// cannot serve such a client at all, so it is turned away. Every other difference
// is harmless enough to just log: the session settings simply keep precedence.
const CRITICAL_CONFIG_KEYS = Object.freeze(["clientId", "clientSecret"]);

/** @returns {string[]} Credential keys in which the client differs from the session owner */
function findCredentialMismatchKeys(ownerConfig, clientConfig) {
  return CRITICAL_CONFIG_KEYS.filter((key) => ownerConfig[key] !== clientConfig[key]);
}

/** @returns {string[]} Credential keys a session cannot be opened without */
function findMissingCredentialKeys(clientConfig) {
  const clientId = typeof clientConfig?.clientId === "string" ? clientConfig.clientId.trim() : "";
  return clientId ? [] : ["clientId"];
}

/**
 * This module's entries in the configs MagicMirror loaded at startup - the full
 * one and, with hideConfigSecrets, the redacted copy the browser gets.
 * MagicMirror names every instance module_<index>_<name>, so the entry of the
 * asking display is found by its index; without one, each entry is a candidate.
 * @param {object[]} mmConfigs - MagicMirror configs to search; typically both global.config and
 *   global.configRedacted (the latter for hideConfigSecrets setups where the browser sends
 *   redacted values). Falsy entries are skipped.
 * @param {string} moduleName
 * @param {string} [identifier] - The display's module identifier
 * @returns {{language: string|undefined, config: object}[]|null} Null when unknown
 */
function findServerModuleEntries(mmConfigs, moduleName, identifier) {
  const index = Number(/^module_(\d+)_/.exec(identifier || "")?.[1]);
  const entries = [];
  for (const mmConfig of mmConfigs) {
    const modules = Array.isArray(mmConfig?.modules) ? mmConfig.modules : null;
    if (!modules) {
      continue;
    }
    const candidates =
      Number.isInteger(index) && modules[index]?.module === moduleName
        ? [modules[index]]
        : modules.filter((entry) => entry?.module === moduleName);
    for (const entry of candidates) {
      entries.push({ language: mmConfig.language, config: entry.config || {} });
    }
  }
  return entries.length > 0 ? entries : null;
}

const sameValue = isDeepStrictEqual;

/**
 * A browser tab that survived a server restart still runs the config it loaded
 * before. Every key the server config sets must arrive unchanged (the client adds
 * the module defaults on top), and MagicMirror's language must match - otherwise
 * the tab is outdated and would e.g. open the session with old credentials or
 * render next to the server's language in its own.
 * @param {object[]|null} serverEntries - From findServerModuleEntries
 * @param {object} clientConfig - The config the display sent, with its MagicMirror language
 * @returns {boolean} Whether no server entry matches the client
 */
function isOutdatedClientConfig(serverEntries, clientConfig) {
  if (!serverEntries) {
    return false;
  }
  return !serverEntries.some(
    ({ language, config }) =>
      (!language || language === clientConfig.language) &&
      Object.keys(config).every((key) => sameValue(config[key], clientConfig[key])),
  );
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
  findMissingCredentialKeys,
  findServerModuleEntries,
  isOutdatedClientConfig,
};
