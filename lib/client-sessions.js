"use strict";

/*
 * Clients of the shared session: the first usable CONFIGURE opens it (owner
 * config), later ones are compared against it - different credentials are
 * rejected, other differences only logged - and get the running state. A
 * display with an outdated or incomplete config is turned away before it can
 * claim the session.
 *
 * A mixin: node_helper.js spreads these methods into its definition; they work
 * on the helper's session state and globalSession.
 */
const { log } = require("./logger");
const {
  findCredentialMismatchKeys,
  findIgnoredSessionKeys,
  findMissingCredentialKeys,
  findServerModuleEntries,
  isOutdatedClientConfig,
  resolveSessionLanguage,
} = require("./session-config");

module.exports = {
  // Warn about session settings a late client asked for but will not get. Purely
  // diagnostic: the display stays connected and keeps its own rendering options.
  warnAboutIgnoredSessionConfig(instanceId, clientSessionConfig) {
    const ignored = findIgnoredSessionKeys(this.sessionOwnerConfig, clientSessionConfig);

    if (ignored.length === 0) {
      return;
    }

    log.warn("Client config differs from the running session - session settings keep precedence", {
      instanceId,
      keys: ignored,
      owner: this.sharedConfigOwnerInstanceId,
    });
  },

  rejectConfigMismatch(instanceId, mismatchKeys = []) {
    log.warn("Rejecting client instance: credentials differ from the running session", {
      instanceId,
      mismatchKeys,
    });

    this.globalSession.clientInstances.delete(instanceId);

    this.emitInitStatus(
      "device_error",
      {
        instanceId,
        isConfigMismatch: true,
        mismatchKeys: [...mismatchKeys],
      },
      { broadcast: false, targetInstanceId: instanceId },
    );
  },

  // The configs MagicMirror loaded at startup; absent outside MagicMirror (tests).
  serverConfigs() {
    return [globalThis.config, globalThis.configRedacted];
  },

  /*
   * A browser tab that was open across a server restart reconnects with the
   * config it loaded before. Were it the first to arrive, its old settings -
   * e.g. an empty clientId from the template - would claim the session. So that tab is asked to reload, and a config without
   * clientId never opens a session.
   * @returns {boolean} Whether the client was turned away
   */
  rejectUnusableConfig(instanceId, clientConfig) {
    const serverEntries = findServerModuleEntries(this.serverConfigs(), this.name || "MMM-HomeConnect2", instanceId);

    if (isOutdatedClientConfig(serverEntries, clientConfig)) {
      log.info("Display runs an outdated config (loaded before the last server restart) - asking it to reload", {
        instanceId,
      });
      this.globalSession.clientInstances.delete(instanceId);
      // The start time lets the display reload once per server start (loop guard).
      this.emitInitStatus(
        "config_outdated",
        { instanceId, serverStartedAt: this.startedAt },
        { broadcast: false, targetInstanceId: instanceId },
      );
      return true;
    }

    const missingKeys = findMissingCredentialKeys(clientConfig);
    if (missingKeys.length > 0) {
      log.warn(`Missing ${missingKeys.join(", ")} in the module config - set it in config.js and restart MagicMirror`, {
        instanceId,
      });
      this.globalSession.clientInstances.delete(instanceId);
      this.emitInitStatus(
        "config_incomplete",
        { instanceId, missingKeys },
        { broadcast: false, targetInstanceId: instanceId },
      );
      return true;
    }

    return false;
  },

  handleConfigNotificationFirstTime(instanceId) {
    this.configReceived = true;

    if (this.sessionAuthenticated) {
      return this.handleSessionAlreadyActive(instanceId);
    }

    if (this.authFlowInProgress) {
      return this.notifyAuthInProgress(instanceId);
    }

    this.emitInitStatus(
      "initializing",
      {
        instanceId,
      },
      { broadcast: false, targetInstanceId: instanceId },
    );

    this.checkTokenAndInitialize(instanceId);
  },

  handleSessionAlreadyActive(instanceId) {
    log.info("Session already authenticated - using existing tokens");
    this.schedulePeriodicFullSnapshotRefresh();
    this.emitInitStatus(
      "session_active",
      {
        instanceId,
      },
      { broadcast: false, targetInstanceId: instanceId },
    );

    this.dispatchDeviceRefreshWithProgramSync({
      reason: "session_active_refresh",
      requester: instanceId || "session_active",
      forcePrograms: false,
    });
  },

  notifyAuthInProgress(instanceId) {
    log.info("Authentication already in progress for another client instance");
    this.emitInitStatus(
      "auth_in_progress",
      {
        instanceId,
      },
      { broadcast: false, targetInstanceId: instanceId },
    );
  },

  handleConfigNotificationSubsequent(instanceId) {
    if (this.sessionAuthenticated && this.hc && this.deviceService) {
      this.emitInitStatus(
        "complete",
        {
          instanceId,
        },
        { broadcast: false, targetInstanceId: instanceId },
      );

      this.deviceService.broadcastDevices(this.broadcastToAllClients.bind(this));
    } else if (this.authFlowInProgress) {
      this.notifyAuthInProgress(instanceId);
    }
  },

  handleConfigNotification(payload) {
    // A helper that was restarted while a valid client + token were already in
    // place has no auth flow to run - adopt the existing session instead.
    if (!this.sessionAuthenticated && !this.authFlowInProgress && this.hc && this.globalSession.refreshToken) {
      this.sessionAuthenticated = true;
    }

    const instanceId = payload.instanceId || "default";
    // Compare resolved languages: a client that leaves apiLanguage empty and lands
    // on the session language through its browser hint is not a real difference.
    const clientSessionConfig = { ...payload, apiLanguage: resolveSessionLanguage(payload) };

    if (this.rejectUnusableConfig(instanceId, clientSessionConfig)) {
      return;
    }

    if (this.sessionOwnerConfig) {
      // A different account cannot be served by this session at all.
      const mismatchKeys = findCredentialMismatchKeys(this.sessionOwnerConfig, clientSessionConfig);
      if (mismatchKeys.length > 0) {
        this.rejectConfigMismatch(instanceId, mismatchKeys);
        return;
      }

      this.warnAboutIgnoredSessionConfig(instanceId, clientSessionConfig);
    } else {
      this.sessionOwnerConfig = clientSessionConfig;
    }

    this.globalSession.clientInstances.add(instanceId);

    log.debug(`Processing CONFIG notification for instance: ${instanceId}`);
    log.debug(`Registered clients: ${this.globalSession.clientInstances.size}`);

    // If debug information has already been collected, immediately send a snapshot
    // to all known clients so newly loaded instances can see the debug panel
    // without waiting for additional events.
    try {
      if (
        this.debugStats &&
        (this.debugStats.lastApiCallTs || this.debugStats.lastSseEventTs || this.debugStats.lastSseTrafficTs)
      ) {
        this.broadcastDebugStats(true);
      }
    } catch (e) {
      log.warn("Failed to broadcast initial debug stats", e);
    }

    if (!this.configReceived) {
      this.instanceId = instanceId;
      this.sharedConfigOwnerInstanceId = instanceId;
      this.config = { ...payload, apiLanguage: this.sessionOwnerConfig.apiLanguage };
      // apply configured log level for module-level logging via auth service
      this.authService.setConfig(this.config);
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationFirstTime(instanceId);
    } else {
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.apiLanguage);
      }
      this.handleConfigNotificationSubsequent(instanceId);
    }
  },
};
