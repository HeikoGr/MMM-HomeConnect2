"use strict";

/* Default texts for the INIT_STATUS and AUTH_STATUS events. */

const INIT_STATUS_MESSAGES = Object.freeze({
  initializing: "Initialization started",
  session_active: "Session active - using existing authentication",
  auth_in_progress: "Authentication in progress",
  complete: "Already initialized",
  hc_not_ready: "HomeConnect not ready",
  token_found: "Token found - initializing HomeConnect",
  rate_limited: "Rate limit - please wait...",
  initializing_hc: "Initializing HomeConnect...",
  auth_failed: "Authentication failed - please check manually",
  success: "Successfully initialized",
  reauth_required: "Stored HomeConnect token invalid - re-authentication required",
  config_outdated: "Display config is outdated - reloading",
  config_incomplete: "Module config incomplete - clientId missing",
});

const AUTH_STATUS_MESSAGES = Object.freeze({
  success: "Authentication successful",
  error: "Authentication failed",
  token_invalid: "Token invalid - starting new authentication flow",
});

/** A status payload: an explicit message wins over the default text. */
function buildStatusPayload(messageMap, status, payload = {}) {
  const baseMessage = messageMap[status] || "";
  const message = typeof payload.message === "string" && payload.message.length ? payload.message : baseMessage;

  return {
    status,
    message,
    ...payload,
  };
}

module.exports = { AUTH_STATUS_MESSAGES, INIT_STATUS_MESSAGES, buildStatusPayload };
