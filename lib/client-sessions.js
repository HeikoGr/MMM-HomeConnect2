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
  warnAboutIgnoredSessionConfig(identifier, clientSessionConfig) {
    const ignored = findIgnoredSessionKeys(this.sessionOwnerConfig, clientSessionConfig);

    if (ignored.length === 0) {
      return;
    }

    log.warn("Client config differs from the running session - session settings keep precedence", {
      identifier,
      keys: ignored,
      owner: this.sharedConfigOwnerIdentifier,
    });
  },

  rejectConfigMismatch(identifier, mismatchKeys = []) {
    log.warn("Rejecting client instance: credentials differ from the running session", {
      identifier,
      mismatchKeys,
    });

    this.globalSession.clientInstances.delete(identifier);

    this.emitInitStatus(
      "device_error",
      {
        identifier,
        isConfigMismatch: true,
        mismatchKeys: [...mismatchKeys],
      },
      { broadcast: false, targetIdentifier: identifier },
    );
  },

  // The configs MagicMirror loaded at startup; absent outside MagicMirror (tests).
  // Both are compared: with hideConfigSecrets the browser holds **SECRET_...**
  // placeholders. MagicMirror resolves them on its way to socketNotificationReceived,
  // but matching the redacted copy too keeps the outdated-tab check from depending on that.
  serverConfigs() {
    return [globalThis.config, globalThis.configRedacted].filter(Boolean);
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

  // apiLanguage is retired: Home Connect texts follow MagicMirror's language.
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
  rejectUnusableConfig(identifier, clientConfig) {
    const serverEntries = findServerModuleEntries(this.serverConfigs(), this.name || "MMM-HomeConnect2", identifier);

    if (isOutdatedClientConfig(serverEntries, clientConfig)) {
      log.info("Display runs an outdated config (loaded before the last server restart) - asking it to reload", {
        identifier,
      });
      this.globalSession.clientInstances.delete(identifier);
      // The start time lets the display reload once per server start (loop guard).
      this.emitInitStatus(
        "config_outdated",
        { identifier, serverStartedAt: this.startedAt },
        { broadcast: false, targetIdentifier: identifier },
      );
      return true;
    }

    const missingKeys = findMissingCredentialKeys(clientConfig);
    if (missingKeys.length > 0) {
      log.warn(`Missing ${missingKeys.join(", ")} in the module config - set it in config.js and restart MagicMirror`, {
        identifier,
      });
      this.globalSession.clientInstances.delete(identifier);
      this.emitInitStatus(
        "config_incomplete",
        { identifier, missingKeys },
        { broadcast: false, targetIdentifier: identifier },
      );
      return true;
    }

    return false;
  },

  handleConfigNotificationFirstTime(identifier) {
    this.configReceived = true;

    if (this.sessionAuthenticated) {
      return this.handleSessionAlreadyActive(identifier);
    }

    if (this.authFlowInProgress) {
      return this.notifyAuthInProgress(identifier);
    }

    this.emitInitStatus(
      "initializing",
      {
        identifier,
      },
      { broadcast: false, targetIdentifier: identifier },
    );

    this.checkTokenAndInitialize(identifier);
  },

  handleSessionAlreadyActive(identifier) {
    log.info("Session already authenticated - using existing tokens");
    this.schedulePeriodicFullSnapshotRefresh();
    this.emitInitStatus(
      "session_active",
      {
        identifier,
      },
      { broadcast: false, targetIdentifier: identifier },
    );

    this.dispatchDeviceRefreshWithProgramSync({
      reason: "session_active_refresh",
      requester: identifier || "session_active",
      forcePrograms: false,
    });
  },

  notifyAuthInProgress(identifier) {
    // The QR code went out when the login started - a display that connects
    // later (a new or reopened tab) would otherwise only see "in progress".
    const pending = this.pendingAuthInfo;
    if (!pending) {
      // No login code: the session starts with the saved token (or the device
      // flow has not issued its code yet). "auth_in_progress" would put the
      // display into the login view; a repeated CONFIGURE lands here right
      // after page load (see handleInitRequired in the frontend).
      log.debug("Session start in progress - display will be updated when it completes", { identifier });
      this.emitInitStatus("initializing", { identifier }, { broadcast: false, targetIdentifier: identifier });
      return;
    }

    this.emitInitStatus(
      "auth_in_progress",
      {
        identifier,
      },
      { broadcast: false, targetIdentifier: identifier },
    );

    log.debug("Login in progress - sending the current login code to the display", { identifier });
    const expiresIn = Number(pending.payload?.expires_in);
    const remainingSeconds = Number.isFinite(expiresIn)
      ? Math.max(0, Math.round(expiresIn - (Date.now() - pending.issuedAt) / 1000))
      : undefined;
    this.sendEventToInstance(identifier, "AUTH_INFO", {
      ...pending.payload,
      ...(remainingSeconds === undefined
        ? {}
        : { expires_in: remainingSeconds, expires_in_minutes: Math.floor(remainingSeconds / 60) }),
    });
  },

  handleConfigNotificationSubsequent(identifier) {
    if (this.sessionAuthenticated && this.hc && this.deviceService) {
      this.emitInitStatus(
        "complete",
        {
          identifier,
        },
        { broadcast: false, targetIdentifier: identifier },
      );

      this.deviceService.broadcastDevices(this.broadcastToAllClients.bind(this));
    } else if (this.authFlowInProgress) {
      this.notifyAuthInProgress(identifier);
    } else if (this.rateLimitDeferTimer) {
      // The session start waits for a rate-limit block to end.
      this.emitRateLimitNotice(identifier);
    } else if (this.lastAuthFailure) {
      // The failure was broadcast before this display connected - without it,
      // the display would show "Loading appliances" forever.
      this.emitAuthStatus(
        "error",
        { ...this.lastAuthFailure, identifier },
        { broadcast: false, targetIdentifier: identifier },
      );
    }
  },

  handleConfigNotification(payload) {
    // A helper that was restarted while a valid client + token were already in
    // place has no auth flow to run - adopt the existing session instead.
    if (!this.sessionAuthenticated && !this.authFlowInProgress && this.hc && this.globalSession.refreshToken) {
      this.sessionAuthenticated = true;
    }

    const identifier = payload.identifier || "default";

    // The display's own MagicMirror language decides whether it is outdated.
    if (this.rejectUnusableConfig(identifier, payload)) {
      return;
    }

    const language = this.resolveSessionLanguage(payload);
    this.warnAboutRetiredLanguageOption(payload, language);
    const clientSessionConfig = { ...payload, language };

    if (this.sessionOwnerConfig) {
      // A different account cannot be served by this session at all.
      const mismatchKeys = findCredentialMismatchKeys(this.sessionOwnerConfig, clientSessionConfig);
      if (mismatchKeys.length > 0) {
        this.rejectConfigMismatch(identifier, mismatchKeys);
        return;
      }

      this.warnAboutIgnoredSessionConfig(identifier, clientSessionConfig);
    } else {
      this.sessionOwnerConfig = clientSessionConfig;
    }

    this.globalSession.clientInstances.add(identifier);

    log.debug(`Processing CONFIG notification for instance: ${identifier}`);
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
      this.identifier = identifier;
      this.sharedConfigOwnerIdentifier = identifier;
      this.config = { ...payload, language: this.sessionOwnerConfig.language };
      // MagicMirror already resolves **SECRET_...** placeholders (hideConfigSecrets) on this
      // path, so the payload carries real credentials. The server's own copy still takes
      // precedence for AuthService, so the device flow never depends on what a browser sent.
      const fullServerEntries = findServerModuleEntries(
        [globalThis.config].filter(Boolean),
        this.name || "MMM-HomeConnect2",
        identifier,
      );
      const fullServerModuleConfig = fullServerEntries?.[0]?.config || null;
      this.authService.setConfig(fullServerModuleConfig ? { ...this.config, ...fullServerModuleConfig } : this.config);
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.language);
      }
      this.handleConfigNotificationFirstTime(identifier);
    } else {
      if (this.hc && typeof this.hc.setAcceptLanguage === "function") {
        this.hc.setAcceptLanguage(this.config.language);
      }
      this.handleConfigNotificationSubsequent(identifier);
    }
  },
};
