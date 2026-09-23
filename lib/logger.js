"use strict";

/*
 * Backend logging for MMM-HomeConnect2 on top of createLogger from mmm-shared:
 * one level switch (the session's logLevel) and redaction of secrets in every
 * logged object. `log.<level>(message, ...details)` is what the helper, the
 * services and the API client log through.
 */
const shared = require("./mmm-shared/mmm-shared");

// node_helper.js swaps in a sink on MagicMirror's Log (setLogSink); tests and
// scripts keep console.
let sink = console;

// The session's own logLevel (from CONFIGURE) narrows the global one; unset
// means the global level alone.
let moduleLogLevel;

// The shared default list covers password/token/secret; the OAuth device flow
// adds codes that must not reach a log either.
const REDACTED_LOG_KEYS = [
  "password",
  "token",
  "apikey",
  "secret",
  "qrcode",
  "refreshtoken",
  "authorization",
  "device_code",
];

const logger = shared.createLogger({
  moduleName: "MMM-HomeConnect2",
  identifier: "node_helper",
  consoleRef: {
    debug: (entry) => sink.debug(entry),
    info: (entry) => sink.info(entry),
    warn: (entry) => sink.warn(entry),
    error: (entry) => sink.error(entry),
  },
  getLevel: () => moduleLogLevel || "debug",
  structured: true,
  redact: true,
  redactedKeys: REDACTED_LOG_KEYS,
});

/** @param {object} target - { debug, info, warn, error }, called with one entry */
function setLogSink(target) {
  sink = target || console;
}

function setModuleLogLevel(level) {
  moduleLogLevel = level ? String(level).toLowerCase() : undefined;
}

/** Errors have no enumerable fields; keep what is useful before redaction. */
function describe(value) {
  if (value instanceof Error) {
    const described = { name: value.name, message: value.message };
    if (value.statusCode !== undefined) described.statusCode = value.statusCode;
    if (value.code !== undefined) described.code = value.code;
    return described;
  }
  return value;
}

function toContext(details) {
  const values = details.map(describe);
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1 && values[0] && typeof values[0] === "object" && !Array.isArray(values[0])) {
    return values[0];
  }
  return { details: values.length === 1 ? values[0] : values };
}

function write(level, message, details) {
  try {
    logger[level](typeof message === "string" ? message : String(message), toContext(details));
  } catch (error) {
    console.error("[MMM-HomeConnect2] logging failed:", error?.message);
  }
}

const log = Object.freeze({
  debug: (message, ...details) => write("debug", message, details),
  info: (message, ...details) => write("info", message, details),
  warn: (message, ...details) => write("warn", message, details),
  error: (message, ...details) => write("error", message, details),
});

module.exports = {
  REDACTED_LOG_KEYS,
  log,
  setLogSink,
  setModuleLogLevel,
};
