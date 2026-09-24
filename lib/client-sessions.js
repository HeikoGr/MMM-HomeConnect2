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
   * The language of every text the Home Connect API sends (program names,
   * phases, options): MagicMirror's own, as loaded on the server. Taking it from
   * whichever display connects first mixed languages whenever that was a tab
   * from before a config change. The display's value only stands in outside
   * MagicMirror.
   */
  resolveSessionLanguage(payload) {
    const serverLanguage = this.serverConfigs().find((mmConfig) => mmConfig?.language)?.language;
    return String(serverLanguage || payload.language || "").trim();
  },

  // apiLanguage used to set the API language; the module now follows MagicMirror.
  warnAboutRetiredLanguageOption(payload, language) {
    const retired = typeof payload.apiLanguage === "string" ? payload.apiLanguage.trim() : "";
    if (!retired || this.retiredLanguageOptionReported) {
      return;
    }
    this.retiredLanguageOptionReported = true;
    log.warn(
      `The apiLanguage option is no longer used - Home Connect texts follow MagicMirror's language ("${language}"). Remove apiLanguage from config.js`,
    );
  },

  /*
   * A browser tab that was open across a server restart reconnects with the
   * config it loaded before. Were it the first to arrive, its old settings -
   * e.g. an empty clientId from the template, or the previous language - would
   * claim the session. So that tab is asked to reload, and a config without
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
    this.emitInitStatus(
      "auth_in_progress",
      {
        instanceId,
      },
      { broadcast: false, targetInstanceId: instanceId },
    );

    // The QR code went out when the login started - a display that connects
    // later (a new or reopened tab) would otherwise only see "in progress".
    const pending = this.pendingAuthInfo;
    if (!pending) {
      log.debug("Authentication in progress - display will be updated when it completes", { instanceId });
      return;
    }

    log.debug("Login in progress - sending the current login code to the display", { instanceId });
    const expiresIn = Number(pending.payload?.expires_in);
    const remainingSeconds = Number.isFinite(expiresIn)
      ? Math.max(0, Math.round(expiresIn - (Date.now() - pending.issuedAt) / 1000))
      : undefined;
    this.sendEventToInstance(instanceId, "AUTH_INFO", {
      ...pending.payload,
      ...(remainingSeconds === undefined
        ? {}
        : { expires_in: remainingSeconds, expires_in_minutes: Math.floor(remainingSeconds / 60) }),
    });
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
    } else if (this.lastAuthFailure) {
      // The failure was broadcast before this display connected - without it,
      // the display would show "Loading appliances" forever.
      this.emitAuthStatus(
        "error",
        { ...this.lastAuthFailure, instanceId },
        { broadcast: false, targetInstanceId: instanceId },
      );
    }
  },

  handleConfigNotification(payload) {
    // A helper that was restarted while a valid client + token were already in
    // place has no auth flow to run - adopt the existing session instead.
    if (!this.sessionAuthenticated && !this.authFlowInProgress && this.hc && this.globalSession.refreshToken) {
      this.sessionAuthenticated = true;
    }

    const instanceId = payload.instanceId || "default";

    // The display's own MagicMirror language decides whether it is outdated.
    if (this.rejectUnusableConfig(instanceId, payload)) {
      return;
    }

    const language = this.resolveSessionLanguage(payload);
    this.warnAboutRetiredLanguageOption(payload, language);
    const clientSessionConfig = { ...payload, language };

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
      this.config = { ...payload, language: this.sessionOwnerConfig.language };
      // apply configured log level for module-level logging via auth service
      this.authService.setConfig(this.config);
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.language);
      }
      this.handleConfigNotificationFirstTime(instanceId);
    } else {
      this.updateActiveProgramInterval();
      if (this.deviceService && typeof this.deviceService.setConfig === "function") {
        this.deviceService.setConfig(this.config);
      }
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.language);
      }
      this.handleConfigNotificationSubsequent(instanceId);
    }
  },
};
