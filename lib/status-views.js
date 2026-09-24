"use strict";

// Everything the module shows besides the appliance cards: the OAuth device-flow
// views, the status banners (rate limit, init retry, Home Connect errors, config
// mismatch) and the debug panel. Pure presentation over the state the module
// keeps; all API-derived values are inserted as text via the DOM builder.
//
// Loaded in the browser via getScripts() after dom-builder.js (exposed as
// window.HomeConnectStatusViews) and required directly in Node tests.
(() => {
  const { h, isSafeHttpUrl } =
    typeof module !== "undefined" && module.exports ? require("./dom-builder") : window.HomeConnectDomBuilder;

  const HOME_CONNECT_ERROR_PATTERNS = [
    /RemoteControlNotActive/i,
    /RemoteStartNotActive/i,
    /WrongOperationState/i,
    /BSH\.Common\.Error/i,
  ];

  /**
   * @param {object} state - { lastInitStatus, lastInitStatusReceivedAt, authStatus }
   * @param {number} [now] - Epoch ms
   * @returns {{title: string, message: string}|null} Rate-limit notice or null
   */
  function getRateLimitNotice(state, now = Date.now()) {
    const status = state.lastInitStatus || state.authStatus;
    if (!status || typeof status !== "object") {
      return null;
    }

    // A rate limit with a known length is over once that time has passed; no
    // further status may arrive until the next snapshot, so expire it here.
    const limitSeconds = Number(status.rateLimitSeconds);
    if (
      status === state.lastInitStatus &&
      Number.isFinite(limitSeconds) &&
      limitSeconds > 0 &&
      Number.isFinite(state.lastInitStatusReceivedAt) &&
      now >= state.lastInitStatusReceivedAt + limitSeconds * 1000
    ) {
      return null;
    }

    const message = typeof status.message === "string" ? status.message.trim() : "";
    const isRateLimited =
      status.isRateLimit === true ||
      Number(status.statusCode) === 429 ||
      Number.isFinite(status.rateLimitSeconds) ||
      /(^|\D)429(\D|$)|rate limit/i.test(message);

    if (!isRateLimited) {
      return null;
    }

    return {
      title: "HTTP 429",
      message: message || "Home Connect API rate limit reached",
    };
  }

  /**
   * @param {object} state - { lastInitStatus, authStatus }
   * @returns {{title: string, message: string}|null} Notice for a BSH error text or null
   */
  function getHomeConnectErrorNotice(state) {
    const status = state.lastInitStatus || state.authStatus;
    // hc_error belongs to the init retry banner.
    if (!status || typeof status !== "object" || status.status === "hc_error") {
      return null;
    }

    const message = typeof status.message === "string" ? status.message.trim() : "";
    if (!message || !HOME_CONNECT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return null;
    }

    return {
      title: "Home Connect",
      message: message.replace(/\s+/g, " ").trim(),
    };
  }

  // All status banners share one shape: a title plus one or more message lines.
  function statusBanner(title, messages) {
    return h("div", { class: "hc-status-banner hc-status-banner-warning" }, [
      h("div", { class: "hc-status-banner-title" }, title),
      messages.filter(Boolean).map((message) => h("div", { class: "hc-status-banner-message" }, message)),
    ]);
  }

  // A failed HomeConnect init (typically network/DNS not up yet after a reboot)
  // is retried by the backend with backoff. Without this banner the module would
  // show "Loading appliances" for minutes with no hint that anything went wrong.
  function initRetryBanner(status, translate) {
    if (!status || typeof status !== "object" || status.status !== "hc_error") {
      return null;
    }

    const retryInSeconds = Math.round(Number(status.retryInSeconds));
    let retryText = "";
    if (Number.isFinite(retryInSeconds) && retryInSeconds > 0) {
      const delayText = retryInSeconds < 90 ? `${retryInSeconds}s` : `${Math.round(retryInSeconds / 60)} min`;
      retryText = `${translate("HC_INIT_RETRY_IN")} ${delayText}`;
    }
    const errorText = typeof status.message === "string" ? status.message.trim() : "";

    return statusBanner(translate("HC_INIT_FAILED_TITLE"), [errorText, retryText]);
  }

  function configMismatchBanner(status, translate) {
    if (!status || typeof status !== "object" || status.isConfigMismatch !== true) {
      return null;
    }

    const mismatchKeys = Array.isArray(status.mismatchKeys) ? status.mismatchKeys : [];
    const isCredentialMismatch = mismatchKeys.some((key) => key === "clientId" || key === "clientSecret");
    const fallbackMessage = isCredentialMismatch
      ? translate("CONFIG_MISMATCH_CREDENTIALS")
      : translate("CONFIG_MISMATCH");

    const message =
      typeof status.message === "string" && status.message.trim() ? status.message.trim() : fallbackMessage;

    return statusBanner(translate("CONFIG_MISMATCH_TITLE"), [message]);
  }

  // Config problems the backend turned this display away for: an outdated tab
  // that could not reload by itself, or a config without clientId.
  function configProblemBanner(status, translate) {
    if (!status || typeof status !== "object") {
      return null;
    }

    if (status.status === "config_outdated") {
      return statusBanner(translate("CONFIG_OUTDATED_TITLE"), [translate("CONFIG_OUTDATED")]);
    }

    if (status.status === "config_incomplete") {
      return statusBanner(translate("CONFIG_INCOMPLETE_TITLE"), [translate("CONFIG_MISSING_CLIENT_ID")]);
    }

    return null;
  }

  /**
   * A display the backend turned away gets no appliances, so "Loading" would
   * only mislead.
   * @param {object} status - The last INIT_STATUS payload
   * @returns {boolean} Whether the backend rejected this display's config
   */
  function isConfigRejected(status) {
    if (!status || typeof status !== "object") {
      return false;
    }
    return (
      status.isConfigMismatch === true || status.status === "config_outdated" || status.status === "config_incomplete"
    );
  }

  /**
   * @param {object} state - { lastInitStatus, lastInitStatusReceivedAt, authStatus }
   * @param {object} ctx - { translate, now }
   * @returns {Array<HTMLElement|null>} Banners in display order (null where none applies)
   */
  function renderNotices(state, ctx) {
    const rateLimit = getRateLimitNotice(state, ctx.now);
    const homeConnectError = getHomeConnectErrorNotice(state);
    return [
      rateLimit ? statusBanner(rateLimit.title, [rateLimit.message]) : null,
      initRetryBanner(state.lastInitStatus, ctx.translate),
      homeConnectError ? statusBanner(homeConnectError.title, [homeConnectError.message]) : null,
      configMismatchBanner(state.lastInitStatus, ctx.translate),
      configProblemBanner(state.lastInitStatus, ctx.translate),
    ];
  }

  // Links from the OAuth server are only rendered as links when they are http(s).
  function authLink(url) {
    const content = isSafeHttpUrl(url) ? h("a", { href: url }, url) : url;
    return h("div", { class: "auth-url" }, content);
  }

  function authStep(icon, title, content) {
    return h("div", { class: "auth-step" }, [
      h("div", { class: "auth-step-title" }, [`${icon} `, h("strong", null, title)]),
      h("div", { class: "auth-step-content" }, content),
    ]);
  }

  /** The device-flow instructions: URL, user code, QR code, expiry. */
  function renderAuthInfo(authInfo, ctx) {
    const { translate } = ctx;

    // The QR code SVG is generated by the helper. Rendering it as an image keeps
    // it out of the document markup entirely - an <img> cannot run scripts.
    let directContent = null;
    if (authInfo.verification_qr_svg) {
      directContent = h("div", { class: "auth-qr" }, [
        h("img", {
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(authInfo.verification_qr_svg)}`,
          alt: "QR code",
        }),
      ]);
    } else if (authInfo.verification_uri_complete) {
      directContent = authLink(authInfo.verification_uri_complete);
    }

    return h("div", { class: "auth-container" }, [
      h("div", { class: "auth-header" }, `🔐 ${translate("AUTH_TITLE")}`),
      authStep("📱", translate("AUTH_STEP1"), authLink(authInfo.verification_uri)),
      authStep("🔑", translate("AUTH_STEP2"), h("div", { class: "auth-code" }, authInfo.user_code)),
      authStep("🔗", translate("AUTH_STEP_DIRECT"), directContent),
      h("div", { class: "auth-footer" }, [
        h(
          "div",
          { class: "auth-timer" },
          `⏱️ ${translate("AUTH_CODE_EXPIRES")} ${authInfo.expires_in_minutes} ${translate("AUTH_MINUTES")}`,
        ),
      ]),
      h("div", { class: "auth-waiting" }, translate("AUTH_WAITING")),
    ]);
  }

  /** Waiting for the user to confirm the device flow. */
  function renderAuthStatus(authStatus, ctx) {
    const { translate } = ctx;

    let progressBar = null;
    if (authStatus.attempt && authStatus.maxAttempts) {
      const progress = Math.round((authStatus.attempt / authStatus.maxAttempts) * 100);
      progressBar = h("div", { class: "progress-container" }, [
        h("div", { class: "progress-bar" }, [h("div", { class: "progress-fill", style: `width: ${progress}%` })]),
      ]);
    }

    return h("div", { class: "auth-container" }, [
      h("div", { class: "auth-header" }, `⏳ ${translate("AUTH_STATUS_WAITING")}`),
      progressBar,
      h("div", { class: "auth-message" }, authStatus.message),
      authStatus.interval
        ? h(
            "div",
            { class: "auth-info" },
            `${translate("AUTH_POLL_INTERVAL")} ${authStatus.interval} ${translate("AUTH_SECONDS")}`,
          )
        : null,
    ]);
  }

  function renderAuthError(authStatus, ctx) {
    return h("div", { class: "auth-container error" }, [
      h("div", { class: "auth-header" }, `❌ ${ctx.translate("AUTH_FAILED_TITLE")}`),
      h("div", { class: "auth-message" }, authStatus.message),
      h("div", { class: "auth-info" }, ctx.translate("AUTH_FAILED_INFO")),
    ]);
  }

  /**
   * @param {object} state - { debugStats, lastInitStatus }
   * @returns {HTMLElement|null} Debug panel, or null without stats
   */
  function renderDebugPanel(state) {
    const { debugStats, lastInitStatus } = state;
    if (!debugStats) {
      return null;
    }
    const formatTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "n/a");
    const row = (label, value) =>
      h("div", { class: "hc-debug-row" }, [h("span", { class: "hc-debug-label" }, label), ` ${value}`]);
    const rows = [];

    if (lastInitStatus?.message) {
      rows.push(row("last init status:", lastInitStatus.message));
    }

    rows.push(row("SSE traffic:", formatTime(debugStats.lastSseTrafficTs || debugStats.lastSseEventTs)));
    rows.push(row("SSE event:", formatTime(debugStats.lastSseEventTs)));
    rows.push(row("API:", formatTime(debugStats.lastApiCallTs)));

    const session = debugStats.session || null;
    if (session && typeof session === "object") {
      const rateLimitRemainingSec = Number.isFinite(session.rateLimitRemainingMs)
        ? Math.max(0, Math.ceil(session.rateLimitRemainingMs / 1000))
        : 0;
      const sessionFlags = [
        session.authenticated ? "authenticated" : "not authenticated",
        session.authFlowInProgress ? "auth in progress" : null,
        session.deviceRefreshInFlight ? "device refresh" : null,
        session.programFetchInFlight ? "program fetch" : null,
      ]
        .filter(Boolean)
        .join(", ");
      rows.push(row("session:", sessionFlags));
      rows.push(row("rate limit remaining:", `${rateLimitRemainingSec}s`));
    }

    const counterEntries = Object.entries(debugStats.apiCounters || {});
    if (counterEntries.length) {
      rows.push(h("div", { class: "hc-debug-subtitle" }, "API counts"));
      counterEntries.sort(([a], [b]) => a.localeCompare(b));
      for (const [name, value] of counterEntries) {
        rows.push(row(name, value));
      }
    }
    return h("div", { class: "hc-debug-panel" }, rows);
  }

  /** While no appliance has arrived yet. */
  function renderLoading(ctx) {
    return h("div", { class: "small" }, [
      h("i", { class: "fa fa-cog fa-spin" }),
      ` ${ctx.translate("SESSION_BASED_AUTH")}`,
      h("br"),
      h("span", { class: "dimmed" }, `${ctx.translate("LOADING_APPLIANCES")}...`),
    ]);
  }

  function renderNoActiveAppliances(ctx) {
    return h("div", { class: "dimmed small" }, ctx.translate("NO_ACTIVE_APPLIANCES"));
  }

  const exportsObj = {
    getHomeConnectErrorNotice,
    getRateLimitNotice,
    isConfigRejected,
    renderAuthError,
    renderAuthInfo,
    renderAuthStatus,
    renderDebugPanel,
    renderLoading,
    renderNoActiveAppliances,
    renderNotices,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportsObj;
  }

  if (typeof window !== "undefined") {
    window.HomeConnectStatusViews = exportsObj;
  }
})();
