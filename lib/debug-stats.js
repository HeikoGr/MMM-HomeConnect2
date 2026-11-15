"use strict";

/*
 * Debug statistics (last API call, SSE traffic, per-endpoint counters) and the
 * SSE hooks DeviceService calls back into.
 *
 * A mixin: node_helper.js spreads these methods into its definition.
 */
const { log } = require("./logger");

// Debug stats go to the displays with a debug panel, which re-render on arrival.
// A busy SSE stream would otherwise mean a full re-render per event, so the
// panel settles for being at most this stale.
const DEBUG_STATS_BROADCAST_INTERVAL_MS = 5000;

module.exports = {
  broadcastDebugStats(force = false) {
    const { clientInstances, debugInstances } = this.globalSession;
    const targets = [...debugInstances].filter((identifier) => clientInstances.has(identifier));
    // Without a debug panel on any display there is nobody to send them to.
    if (targets.length === 0) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastDebugStatsBroadcastTs < DEBUG_STATS_BROADCAST_INTERVAL_MS) {
      return;
    }
    this.lastDebugStatsBroadcastTs = now;

    // Only what renderDebugPanel() (lib/status-views.js) shows.
    const stats = {
      lastApiCallTs: this.debugStats.lastApiCallTs,
      lastSseEventTs: this.debugStats.lastSseEventTs,
      lastSseTrafficTs: this.debugStats.lastSseTrafficTs,
      apiCounters: { ...this.debugStats.apiCounters },
      session: {
        authenticated: this.sessionAuthenticated,
        authFlowInProgress: this.authFlowInProgress,
        deviceRefreshInFlight: this.deviceRefreshInFlight,
        programFetchInFlight: this.programFetchCoordinator().isInFlight(),
        rateLimitRemainingMs: Math.max(0, this.getRateLimitUntil() - now),
        sseChannels: (this.hc?.getEventSourceStates?.() || []).map((channel) => ({
          label: channel.label,
          open: channel.open,
          channelLimit: channel.channelLimit,
          retryAt: channel.retryAt,
        })),
      },
    };
    for (const identifier of targets) {
      this.sendEventToInstance(identifier, "DEBUG_STATS", stats);
    }
  },

  recordApiCall(apiName) {
    if (!apiName) return;
    this.debugStats.lastApiCallTs = Date.now();
    this.debugStats.apiCounters[apiName] = (this.debugStats.apiCounters[apiName] || 0) + 1;
    this.broadcastDebugStats();
  },

  recordSseEvent() {
    const now = Date.now();
    this.debugStats.lastSseEventTs = now;
    this.debugStats.lastSseTrafficTs = now;
    this.broadcastDebugStats();
  },

  recordSseKeepAlive() {
    this.debugStats.lastSseTrafficTs = Date.now();
    this.broadcastDebugStats();
  },

  handleSseStale(context = {}) {
    if (!this.hc || this.authFlowInProgress) {
      log.debug("Ignoring SSE stale recovery while HomeConnect is unavailable", context);
      return;
    }

    if (!this.deviceService || typeof this.deviceService.reconnectEventSubscriptions !== "function") {
      log.warn("SSE watchdog cannot rebuild subscriptions - DeviceService unavailable", context);
      return;
    }

    log.warn("SSE watchdog triggered subscription rebuild", context);
    this.deviceService.reconnectEventSubscriptions().then((rebuilt) => {
      if (!rebuilt) {
        return;
      }

      // The rebuilt SSE channels bring the state back on their own; a full
      // snapshot during an API rate limit would only spend blocked quota.
      if (this.isRateLimited()) {
        const remainingSeconds = Math.ceil((this.getRateLimitUntil() - Date.now()) / 1000);
        log.info(`SSE rebuilt; skipping the resync snapshot - rate limited for another ${remainingSeconds}s`);
        return;
      }

      this.dispatchDeviceRefreshWithProgramSync({
        reason: "sse_watchdog_resync",
        requester: "sse_watchdog",
        forcePrograms: true,
        activeProgramsOnly: true,
      });
    });
  },

  // A device just started reporting a program in progress (via SSE) but we don't
  // know which program it is yet - fetch it now instead of waiting for the next
  // scheduled full snapshot (up to 30 minutes later). Runs through the normal
  // GET_ACTIVE_PROGRAMS path so existing throttling/dedup/retry logic still applies.
  handleActiveProgramNeededFromSse(haId) {
    if (!haId || !this.hc || this.authFlowInProgress) {
      return;
    }

    log.debug("SSE indicates a device is active without known program - fetching it", {
      haId,
    });

    this.handleGetActivePrograms({
      identifier: "sse_program_detected",
      haIds: [haId],
      force: true,
    });
  },
};
