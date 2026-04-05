/* global Module, Log */ // eslint-disable-line no-redeclare

function computeProgressDisplayState({
  device,
  effectiveRemainingSeconds,
  estimatedTotalSeconds,
  progressNumeric,
  suppressSelectedProgramRuntime,
  effectiveOperationStateActive,
  observedPercent
}) {
  let estimatedTotalPercent;
  if (
    Number.isFinite(estimatedTotalSeconds) &&
    estimatedTotalSeconds > 0 &&
    Number.isFinite(effectiveRemainingSeconds) &&
    effectiveRemainingSeconds >= 0 &&
    effectiveRemainingSeconds <= estimatedTotalSeconds
  ) {
    estimatedTotalPercent = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          ((estimatedTotalSeconds - effectiveRemainingSeconds) / estimatedTotalSeconds) * 100
        )
      )
    );
  }

  let initialPercent;
  if (
    device._initialRemaining &&
    Number.isFinite(Number(device._initialRemaining)) &&
    Number(device._initialRemaining) > 0 &&
    effectiveRemainingSeconds > 0
  ) {
    const initialRemaining = Number(device._initialRemaining);
    initialPercent = Math.max(
      0,
      Math.min(
        100,
        Math.round(((initialRemaining - effectiveRemainingSeconds) / initialRemaining) * 100)
      )
    );
  }

  const canTrustExplicitProgress =
    !suppressSelectedProgramRuntime &&
    progressNumeric !== undefined &&
    (progressNumeric >= 100 ||
      progressNumeric > 0 ||
      !(effectiveRemainingSeconds > 0 && effectiveOperationStateActive));

  let percent;
  let progressSource = "none";
  if (canTrustExplicitProgress) {
    percent = progressNumeric;
    progressSource = "programProgress";
  } else if (estimatedTotalPercent !== undefined) {
    percent = estimatedTotalPercent;
    progressSource = "estimatedTotalProgramTime";
  } else if (
    observedPercent !== undefined &&
    (initialPercent === undefined || observedPercent > initialPercent)
  ) {
    percent = observedPercent;
    progressSource = "observedElapsed+remaining";
  } else if (initialPercent !== undefined) {
    percent = initialPercent;
    progressSource = "initialRemaining";
  } else if (observedPercent !== undefined) {
    percent = observedPercent;
    progressSource = "observedElapsed+remaining";
  }

  if (suppressSelectedProgramRuntime) {
    percent = undefined;
  }

  const visibleRemainingSeconds = suppressSelectedProgramRuntime ? null : effectiveRemainingSeconds;
  const isIndeterminate = percent === undefined && visibleRemainingSeconds > 0;
  if (isIndeterminate) {
    progressSource = "indeterminate";
  }

  return {
    percent,
    progressSource,
    visibleRemainingSeconds,
    isIndeterminate,
    estimatedTotalPercent,
    initialPercent
  };
}

function normalizeProgressValue(progressValue) {
  if (progressValue === undefined || progressValue === null) {
    return undefined;
  }

  const parsed = Number(progressValue);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function getOperationStateInfo(device) {
  const operationStateRaw = device.OperationState || device.operationState || null;
  const operationStateString =
    typeof operationStateRaw === "string"
      ? operationStateRaw
      : operationStateRaw && typeof operationStateRaw.value === "string"
        ? operationStateRaw.value
        : null;
  const label = operationStateString ? operationStateString.split(".").pop() : "";

  return {
    label,
    isFinished: /Finished/i.test(label || ""),
    isActive: /(Run|Active|DelayedStart|InProgress)/i.test(label || ""),
    isDelayedStart: /DelayedStart/i.test(label || ""),
    isPaused: /Pause/i.test(label || "")
  };
}

function computeProgramDisplayState({
  device,
  operationStateDelayedStart,
  suppressSelectedProgramRuntime,
  visibleRemainingSeconds,
  estimatedTotalSeconds,
  hasEstimatedDuration,
  startInRelativeSeconds,
  finishInRelativeSeconds,
  isFinished,
  nowMs,
  translate,
  formatDuration,
  formatClockTime
}) {
  const plannedDurationLabel =
    Number.isFinite(estimatedTotalSeconds) && estimatedTotalSeconds > 0
      ? `${hasEstimatedDuration ? `${translate("APPROX_PREFIX")} ` : ""}${formatDuration(estimatedTotalSeconds)}`
      : "";
  const visiblePlannedDurationLabel = suppressSelectedProgramRuntime ? "" : plannedDurationLabel;
  const showPlannedDurationInTitle = !(visibleRemainingSeconds > 0);
  const selectedProgramVisible =
    device.ActiveProgramSource !== "selected" || operationStateDelayedStart;
  const programName = selectedProgramVisible ? device.ActiveProgramName || "" : "";
  const programPhase =
    selectedProgramVisible && typeof device.ActiveProgramPhase === "string"
      ? device.ActiveProgramPhase
      : "";
  const programDetails =
    selectedProgramVisible && Array.isArray(device.ActiveProgramDetails)
      ? device.ActiveProgramDetails.filter((value) => typeof value === "string" && value)
      : [];
  const programSupplementParts = [];

  if (programPhase) {
    programSupplementParts.push(programPhase);
  }
  if (programDetails.length > 0) {
    programSupplementParts.push(programDetails.join(" • "));
  }

  const wrinkleProtectionActive =
    isFinished &&
    [programPhase, ...programDetails].some(
      (value) => typeof value === "string" && /Wrinkle|Ironing/i.test(value)
    );
  const effectiveStartInRelativeSeconds =
    startInRelativeSeconds > 0
      ? startInRelativeSeconds
      : finishInRelativeSeconds > 0 && estimatedTotalSeconds > 0
        ? Math.max(0, finishInRelativeSeconds - estimatedTotalSeconds)
        : null;
  const effectiveFinishInRelativeSeconds =
    finishInRelativeSeconds > 0
      ? finishInRelativeSeconds
      : effectiveStartInRelativeSeconds > 0 && estimatedTotalSeconds > 0
        ? effectiveStartInRelativeSeconds + estimatedTotalSeconds
        : null;
  const delayedStartScheduleParts = [];
  if (effectiveFinishInRelativeSeconds > 0) {
    delayedStartScheduleParts.push(
      `${translate("ENDS_AT")} ${translate("APPROX_PREFIX")} ${formatClockTime(
        nowMs + effectiveFinishInRelativeSeconds * 1000
      )}`
    );
  }
  const delayedStartText = operationStateDelayedStart
    ? effectiveStartInRelativeSeconds > 0
      ? `${translate("DELAYED_START")} • ${translate("STARTS_IN")} ${hasEstimatedDuration ? `${translate("APPROX_PREFIX")} ` : ""}${formatDuration(effectiveStartInRelativeSeconds)}${delayedStartScheduleParts.length ? ` • ${delayedStartScheduleParts.join(" • ")}` : ""}`
      : translate("DELAYED_START")
    : "";
  const programMeta =
    programName && visiblePlannedDurationLabel && showPlannedDurationInTitle
      ? `${programName} • ${visiblePlannedDurationLabel}`
      : programName || (showPlannedDurationInTitle ? visiblePlannedDurationLabel : "");

  return {
    programMeta,
    programSupplement: programSupplementParts.join(" | "),
    wrinkleProtectionActive,
    delayedStartText,
    visiblePlannedDurationLabel
  };
}

Module.register("MMM-HomeConnect2", {
  updated: 0,
  devices: [],
  config: null,
  authInfo: null,
  authStatus: null,
  instanceId: null,
  deviceRuntimeHints: {},
  lastActiveProgramRequestTs: 0,
  activeProgramRecoveryRequestTsByHaId: {},
  debugStats: null,
  progressRefreshTimer: null,

  defaults: {
    header: "Home Connect Appliances",
    clientId: "",
    clientSecret: "",
    apiLanguage: "",

    showDeviceIcon: true,
    showAlwaysAllDevices: false,
    showDeviceIfDoorIsOpen: true,
    showDeviceIfFailure: true,
    showDeviceIfInfoIsAvailable: true,
    enableSSEHeartbeat: true, // Enable SSE heartbeat checks by default
    sseHeartbeatCheckIntervalMs: 60 * 1000, // 1 minute
    sseHeartbeatStaleThresholdMs: 3 * 60 * 1000, // 3 minutes
    progressRefreshIntervalMs: 30 * 1000,
    minActiveProgramIntervalMs: 10 * 60 * 1000, // 10 minutes between active program fetches (backend throttle)
    // Module logging level: none | error | warn | info | debug
    logLevel: ""
  },

  start() {
    // Generate a unique instance ID
    this.instanceId = `hc_${Math.random().toString(36).substr(2, 9)}`;
    this.ensureProgressRefreshTimer();
  },

  ensureProgressRefreshTimer() {
    if (this.progressRefreshTimer) {
      return;
    }

    const refreshIntervalMs =
      typeof this.config?.progressRefreshIntervalMs === "number"
        ? Math.max(5000, this.config.progressRefreshIntervalMs)
        : this.defaults.progressRefreshIntervalMs;

    this.progressRefreshTimer = setInterval(() => {
      if (this.suspended || !Array.isArray(this.devices) || this.devices.length === 0) {
        return;
      }

      this.updateDom(0);
    }, refreshIntervalMs);
  },

  clearProgressRefreshTimer() {
    if (this.progressRefreshTimer) {
      clearInterval(this.progressRefreshTimer);
      this.progressRefreshTimer = null;
    }
  },

  getActiveProgramRecoveryCooldownMs() {
    return 15 * 1000;
  },

  getActiveProgramRecoveryState() {
    if (!this.activeProgramRecoveryRequestTsByHaId) {
      this.activeProgramRecoveryRequestTsByHaId = {};
    }

    return this.activeProgramRecoveryRequestTsByHaId;
  },

  recoverMissingActivePrograms(devices = this.devices) {
    const deviceUtils = this.getDeviceUtils();
    const requestState = this.getActiveProgramRecoveryState();
    const recoverHaIds = [];
    const now = Date.now();
    const cooldownMs = this.getActiveProgramRecoveryCooldownMs();

    devices.forEach((device) => {
      const haId = device?.haId || device?.haid || device?.id;
      if (!haId) {
        return;
      }

      const operationState = getOperationStateInfo(device);
      const appearsActive = deviceUtils.deviceAppearsActive(device);
      const running =
        device.PowerState !== "Off" &&
        (operationState.isActive || appearsActive) &&
        !operationState.isDelayedStart;

      if (device.ActiveProgramSource === "active") {
        delete requestState[haId];
        return;
      }

      if (!running) {
        delete requestState[haId];
        return;
      }

      const needsRecovery =
        device.ActiveProgramSource === "selected" ||
        !device.ActiveProgramName ||
        !device.ActiveProgramSource;

      if (!needsRecovery) {
        return;
      }

      if (now - (requestState[haId] || 0) < cooldownMs) {
        return;
      }

      requestState[haId] = now;
      recoverHaIds.push(haId);
    });

    if (!recoverHaIds.length) {
      return;
    }

    this.lastActiveProgramRequestTs = now;
    this.requestStateRefresh({
      haIds: recoverHaIds,
      bypassActiveProgramThrottle: true
    });
  },

  requestStateRefresh(options = {}) {
    const payload = {
      instanceId: this.instanceId,
      ...options
    };
    this.sendSocketNotification("REQUEST_DEVICE_REFRESH", payload);
  },

  loaded(callback) {
    callback();
  },

  getScripts() {
    // Use full module-relative path so the MagicMirror loader can find the file
    return ["modules/MMM-HomeConnect2/lib/device-utils.js"];
  },

  getStyles() {
    return ["MMM-HomeConnect2.css"];
  },

  getTranslations() {
    return {
      en: "translations/en.json",
      de: "translations/de.json",
      da: "translations/da.json"
    };
  },

  getPreferredApiLanguage() {
    const configuredLanguage =
      typeof this.config?.apiLanguage === "string" ? this.config.apiLanguage.trim() : "";
    if (configuredLanguage) {
      return configuredLanguage;
    }

    const magicMirrorLanguage =
      typeof globalThis.config?.language === "string" ? globalThis.config.language.trim() : "";
    if (magicMirrorLanguage) {
      return magicMirrorLanguage;
    }

    const browserLanguages = Array.isArray(navigator?.languages)
      ? navigator.languages
      .map((language) => (typeof language === "string" ? language.trim() : ""))
      .filter(Boolean)
      : [];
    if (browserLanguages.length > 0) {
      return browserLanguages[0];
    }

    const browserLanguage =
      typeof navigator?.language === "string" ? navigator.language.trim() : "";
    if (browserLanguage) {
      return browserLanguage;
    }

    const documentLanguage =
      typeof document?.documentElement?.lang === "string"
        ? document.documentElement.lang.trim()
        : "";
    if (documentLanguage) {
      return documentLanguage;
    }

    return "";
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      // Send config with instanceId
      this.sendSocketNotification("CONFIG", {
        ...this.config,
        instanceId: this.instanceId,
        apiLanguage: this.getPreferredApiLanguage()
      });
    }
  },

  socketNotificationReceived(notification, payload) {
    // Only respond to messages for this instance (if instanceId present)
    if (payload && payload.instanceId && payload.instanceId !== this.instanceId) {
      return;
    }

    const safePayload = payload || {};

    switch (notification) {
      case "MMM-HomeConnect_Update":
        this.devices = safePayload || [];
        this.recoverMissingActivePrograms(this.devices);
        this.updateDom();
        // After initial device list arrives, request a snapshot of active programs
        // so RemainingProgramTime / ProgramProgress are populated even before SSE events come in.
        this.scheduleActiveProgramSnapshot();
        break;
      case "AUTH_INFO":
        this.authInfo = safePayload;
        this.updateDom();
        break;
      case "AUTH_STATUS":
        this.authStatus = safePayload;
        this.updateDom();
        break;
      case "INIT_STATUS": {
        Log.log(`${this.name} Init Status: ${safePayload.status} - ${safePayload.message}`);
        this.lastInitStatus = safePayload;

        if (safePayload.status === "session_active" || safePayload.status === "complete") {
          // Session active - normal display
          this.authInfo = null;
          this.authStatus = null;
        } else if (safePayload.status === "auth_in_progress") {
          // Authentication already in progress (special auth UI)
          this.authStatus = {
            status: "polling",
            message: safePayload.message
          };
        }
        this.updateDom();
        break;
      }
      case "DEBUG_STATS":
        this.debugStats = safePayload || {};
        this.updateDom();
        break;
      default:
        break;
    }
  },

  suspend() {
    this.suspended = true;
  },

  resume() {
    this.suspended = false;
    // On resume, trigger a revalidation: request a fresh device update and
    // explicitly request active program snapshots so UI resumes reflecting
    // currently running programs immediately.
    try {
      this.lastActiveProgramRequestTs = 0;
      this.requestStateRefresh({ forceRefresh: true, bypassActiveProgramThrottle: true });

      const haIds = this.devices
        .map((d) => d.haId || d.haid || d.id)
        .filter((id) => typeof id === "string" && id.length);

      setTimeout(() => {
        try {
          this.sendSocketNotification("GET_ACTIVE_PROGRAMS", {
            instanceId: this.instanceId,
            haIds,
            force: true
          });
        } catch (err) {
          Log.error(`${this.name} resume fallback active program request failed: ${err}`);
        }
      }, 1500);
    } catch (e) {
      Log.error(`${this.name} resume actions failed: ${e}`);
    }
  },

  stop() {
    this.clearProgressRefreshTimer();
  },

  scheduleActiveProgramSnapshot() {
    try {
      const haIds = this.devices.map((d) => d.haId || d.haid || d.id).filter((id) => !!id);
      if (!haIds.length) {
        return;
      }

      const now = Date.now();
      const elapsed = now - (this.lastActiveProgramRequestTs || 0);
      const minInterval =
        typeof this.config.minActiveProgramIntervalMs === "number"
          ? Math.max(0, this.config.minActiveProgramIntervalMs)
          : this.defaults.minActiveProgramIntervalMs;

      if (!this.lastActiveProgramRequestTs || elapsed >= minInterval) {
        this.lastActiveProgramRequestTs = now;
        this.requestStateRefresh({ haIds });
      }
    } catch (e) {
      Log.error(`${this.name} failed scheduling active programs: ${e}`);
    }
  },

  getDeviceUtils() {
    const browserUtils =
      typeof window !== "undefined" && window.HomeConnectDeviceUtils
        ? window.HomeConnectDeviceUtils
        : {};

    return {
      parseStartInRelativeSeconds:
        typeof browserUtils.parseStartInRelativeSeconds === "function"
          ? browserUtils.parseStartInRelativeSeconds
          : () => null,
      parseFinishInRelativeSeconds:
        typeof browserUtils.parseFinishInRelativeSeconds === "function"
          ? browserUtils.parseFinishInRelativeSeconds
          : () => null,
      parseRemainingSeconds:
        typeof browserUtils.parseRemainingSeconds === "function"
          ? browserUtils.parseRemainingSeconds
          : () => null,
      parseProgress:
        typeof browserUtils.parseProgress === "function"
          ? browserUtils.parseProgress
          : () => undefined,
      parseEstimatedTotalSeconds:
        typeof browserUtils.parseEstimatedTotalSeconds === "function"
          ? browserUtils.parseEstimatedTotalSeconds
          : () => null,
      isEstimatedDuration:
        typeof browserUtils.isEstimatedDuration === "function"
          ? browserUtils.isEstimatedDuration
          : () => false,
      getDeviceTypeMeta:
        typeof browserUtils.getDeviceTypeMeta === "function"
          ? browserUtils.getDeviceTypeMeta
          : (type) => ({ iconName: type ? `${type}.png` : null, fallbackIconClass: "fa-plug" }),
      deviceAppearsActive:
        typeof browserUtils.deviceAppearsActive === "function"
          ? browserUtils.deviceAppearsActive
          : () => false,
      isDeviceConnected:
        typeof browserUtils.isDeviceConnected === "function"
          ? browserUtils.isDeviceConnected
          : () => false,
      isDeviceExplicitlyDisconnected:
        typeof browserUtils.isDeviceExplicitlyDisconnected === "function"
          ? browserUtils.isDeviceExplicitlyDisconnected
          : () => false,
      shouldDisplayDevice:
        typeof browserUtils.shouldDisplayDevice === "function"
          ? browserUtils.shouldDisplayDevice
          : () => false
    };
  },

  getUniqueStrings(values, maxItems = Infinity) {
    const seen = new Set();
    const result = [];

    values.forEach((value) => {
      if (typeof value !== "string") {
        return;
      }

      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      if (result.length < maxItems) {
        result.push(normalized);
      }
    });

    return result;
  },

  getObjectSummaryValues(value, maxItems = Infinity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    return this.getUniqueStrings(Object.values(value), maxItems);
  },

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) {
      return "";
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return (hours > 0 ? `${hours}h ` : "") + `${String(minutes).padStart(2, "0")}m`;
  },

  formatDebugAge(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return "n/a";
    }

    const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    return this.formatDuration(ageSeconds) || `${ageSeconds}s`;
  },

  formatClockTime(timestamp) {
    if (!Number.isFinite(timestamp)) {
      return "";
    }

    const locale = this.getPreferredApiLanguage() || undefined;
    const timeFormat = globalThis.config?.timeFormat;
    const hour12 = timeFormat === 12 ? true : timeFormat === 24 ? false : undefined;

    try {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12
      }).format(timestamp);
    } catch {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
    }
  },

  getObservedProgressEstimate(device, remainingSeconds) {
    const observedAt = Number(device?._remainingObservedAt);
    if (!Number.isFinite(observedAt) || !(remainingSeconds > 0)) {
      return undefined;
    }

    const observedElapsedSeconds = Math.max(0, Math.round((Date.now() - observedAt) / 1000));
    if (observedElapsedSeconds <= 0) {
      return undefined;
    }

    const estimatedTotalSeconds = observedElapsedSeconds + remainingSeconds;
    if (!(estimatedTotalSeconds > 0)) {
      return undefined;
    }

    return Math.max(
      0,
      Math.min(100, Math.round((observedElapsedSeconds / estimatedTotalSeconds) * 100))
    );
  },

  getEffectiveRemainingSeconds(device, remainingSeconds) {
    if (!(remainingSeconds > 0)) {
      return remainingSeconds;
    }

    const lastSeenAt = Number(device?._lastRemainingSeenAt || device?._remainingObservedAt);
    if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
      return remainingSeconds;
    }

    const elapsedSeconds = Math.max(0, Math.round((Date.now() - lastSeenAt) / 1000));
    return Math.max(0, remainingSeconds - elapsedSeconds);
  },

  getDeviceRuntimeHint(runtimeHints, device) {
    const deviceKey = device.haId || device.haid || device.id || device.name || "unknown";
    return runtimeHints[deviceKey] || (runtimeHints[deviceKey] = { hadActive: false });
  },

  updateRuntimeHintState({
    hint,
    powerState,
    remainingSeconds,
    progressNumeric,
    operationStateActive,
    suppressSelectedProgramRuntime
  }) {
    if (powerState === "Off") {
      hint.hadActive = false;
    }
    if (operationStateActive && powerState !== "Off") {
      hint.hadActive = true;
    }
    if (!suppressSelectedProgramRuntime && remainingSeconds !== null && remainingSeconds > 0) {
      hint.hadActive = true;
    }
    if (
      !suppressSelectedProgramRuntime &&
      progressNumeric !== undefined &&
      progressNumeric > 0 &&
      progressNumeric < 100
    ) {
      hint.hadActive = true;
    }

    return hint.hadActive && remainingSeconds === 0;
  },

  buildDeviceDisplayState(device, runtimeHints, deviceUtils) {
    const explicitlyDisconnected = deviceUtils.isDeviceExplicitlyDisconnected(device);
    const isConnected = explicitlyDisconnected ? false : deviceUtils.isDeviceConnected(device);
    const appearsActive = deviceUtils.deviceAppearsActive(device);
    const remainingSeconds = deviceUtils.parseRemainingSeconds(device);
    const effectiveRemainingSeconds = this.getEffectiveRemainingSeconds(device, remainingSeconds);
    const estimatedTotalSeconds = deviceUtils.parseEstimatedTotalSeconds(device);
    const hasEstimatedDuration = deviceUtils.isEstimatedDuration(device);
    const progressValue = deviceUtils.parseProgress(device);
    const startInRelativeSeconds =
      typeof deviceUtils.parseStartInRelativeSeconds === "function"
        ? deviceUtils.parseStartInRelativeSeconds(device)
        : null;
    const finishInRelativeSeconds =
      typeof deviceUtils.parseFinishInRelativeSeconds === "function"
        ? deviceUtils.parseFinishInRelativeSeconds(device)
        : null;
    const hint = this.getDeviceRuntimeHint(runtimeHints, device);
    const progressNumeric = normalizeProgressValue(progressValue);
    const operationState = getOperationStateInfo(device);
    const suppressSelectedProgramRuntime =
      device.ActiveProgramSource === "selected" && !operationState.isDelayedStart;
    const effectiveOperationStateActive = suppressSelectedProgramRuntime
      ? false
      : operationState.isActive;
    const effectiveAppearsActive = suppressSelectedProgramRuntime ? false : appearsActive;
    const finishedViaZero = this.updateRuntimeHintState({
      hint,
      powerState: device.PowerState,
      remainingSeconds,
      progressNumeric,
      operationStateActive: effectiveOperationStateActive,
      suppressSelectedProgramRuntime
    });
    const isFinished = operationState.isFinished || progressNumeric === 100 || finishedViaZero;
    if (isFinished) {
      hint.hadActive = false;
    }
    const observedPercent = this.getObservedProgressEstimate(device, effectiveRemainingSeconds);
    const progressState = computeProgressDisplayState({
      device,
      effectiveRemainingSeconds,
      estimatedTotalSeconds,
      progressNumeric,
      suppressSelectedProgramRuntime,
      effectiveOperationStateActive,
      observedPercent
    });
    const {
      percent,
      progressSource,
      visibleRemainingSeconds,
      isIndeterminate,
      estimatedTotalPercent,
      initialPercent
    } = progressState;

    const typeMeta = deviceUtils.getDeviceTypeMeta(device.type);
    const programState = computeProgramDisplayState({
      device,
      operationStateDelayedStart: operationState.isDelayedStart,
      suppressSelectedProgramRuntime,
      visibleRemainingSeconds,
      estimatedTotalSeconds,
      hasEstimatedDuration,
      startInRelativeSeconds,
      finishInRelativeSeconds,
      isFinished,
      nowMs: Date.now(),
      translate: this.translate.bind(this),
      formatDuration: this.formatDuration.bind(this),
      formatClockTime: this.formatClockTime.bind(this)
    });
    const {
      programMeta,
      programSupplement,
      wrinkleProtectionActive,
      delayedStartText,
      visiblePlannedDurationLabel
    } = programState;

    const deviceSpecificDetails = this.getObjectSummaryValues(device.DeviceStatusByKey, 4);
    const deviceAlerts = this.getObjectSummaryValues(device.DeviceAlertsByKey, 3);

    const detailText = deviceSpecificDetails.join(" • ");
    const alertText = deviceAlerts.length
      ? `${this.translate("ACTIVE_ALERTS")}: ${deviceAlerts.join(" • ")}`
      : "";

    const statusText = explicitlyDisconnected
      ? this.translate("DEVICE_NOT_CONNECTED")
      : wrinkleProtectionActive
        ? this.translate("WRINKLE_PROTECTION_ACTIVE")
        : visibleRemainingSeconds > 0
          ? `${this.translate("DONE_IN")} ${hasEstimatedDuration ? `${this.translate("APPROX_PREFIX")} ` : ""}${this.formatDuration(visibleRemainingSeconds)}`
          : "";
    const showProgressDebug = (this.config?.logLevel || "").toLowerCase() === "debug";
    const progressDebug = showProgressDebug
      ? [
        `src=${progressSource}`,
        `api=${progressNumeric !== undefined ? `${progressNumeric}%` : "n/a"}`,
        `total=${estimatedTotalPercent !== undefined ? `${estimatedTotalPercent}%` : "n/a"}`,
        `initial=${initialPercent !== undefined ? `${initialPercent}%` : "n/a"}`,
        `observed=${observedPercent !== undefined ? `${observedPercent}%` : "n/a"}`,
        `remaining=${visibleRemainingSeconds !== null ? this.formatDuration(visibleRemainingSeconds) || `${visibleRemainingSeconds}s` : "n/a"}`,
        `rawRemaining=${remainingSeconds !== null ? this.formatDuration(remainingSeconds) || `${remainingSeconds}s` : "n/a"}`,
        `planned=${visiblePlannedDurationLabel || "n/a"}`,
        `seen=${this.formatDebugAge(Number(device._remainingObservedAt))}`
      ].join(" | ")
      : "";

    return {
      deviceName: device.name,
      imageName: typeMeta.iconName,
      fallbackIconClass: typeMeta.fallbackIconClass,
      runtime: {
        explicitlyDisconnected,
        isConnected,
        appearsActive: effectiveAppearsActive,
        operationStateActive: effectiveOperationStateActive,
        operationStateDelayedStart: operationState.isDelayedStart,
        operationStateFinished: operationState.isFinished,
        operationStatePaused: operationState.isPaused,
        effectiveRemainingSeconds: visibleRemainingSeconds,
        hasEstimatedDuration,
        isFinished,
        isIndeterminate,
        wrinkleProtectionActive,
        percent
      },
      presentation: {
        delayedStartText,
        progressDebug,
        programMeta,
        detailText,
        alertText,
        programSupplement,
        showProgressDebug,
        statusText
      }
    };
  },

  getDeviceProgressHtml(displayState) {
    const { presentation, runtime } = displayState;

    if (presentation.delayedStartText) {
      return `<div class='hc-finished'>${presentation.delayedStartText}</div>`;
    }
    if (runtime.wrinkleProtectionActive) {
      return `<div class='hc-finished'>${this.translate("WRINKLE_PROTECTION_ACTIVE")}</div>`;
    }
    if (runtime.isFinished) {
      return `<div class='hc-finished'>${this.translate("PROGRAM_FINISHED")}</div>`;
    }
    if (runtime.isIndeterminate) {
      return `<progress max='100' width='95%'></progress><span class='hc-progress-label'>${this.translate("IN_PROGRESS")}</span>`;
    }
    if (runtime.percent !== undefined) {
      return `<progress value='${runtime.percent}' max='100' width='95%'></progress><span class='hc-progress-label'>${runtime.percent}%</span>`;
    }

    return "";
  },

  getStatusIconsHtml(device, displayState) {
    const { runtime } = displayState;
    let programIcon = "";
    if (runtime.explicitlyDisconnected) {
      programIcon =
        "<i class='fa fa-chain-broken deviceStatusIcon deviceStatusIconOffline' title='Device not connected'></i>";
    } else if (device.PowerState !== "Off" && runtime.operationStateDelayedStart) {
      programIcon = "<i class='fa fa-clock-o deviceStatusIcon' title='Delayed start'></i>";
    } else if (device.PowerState !== "Off" && runtime.operationStatePaused) {
      programIcon = "<i class='fa fa-pause deviceStatusIcon' title='Program paused'></i>";
    } else if (
      device.PowerState !== "Off" &&
      (runtime.operationStateActive || runtime.appearsActive) &&
      !runtime.isFinished &&
      !runtime.operationStateFinished
    ) {
      programIcon = "<i class='fa fa-play deviceStatusIcon' title='Program running'></i>";
    }

    const statusIcons = [];

    if (programIcon) {
      statusIcons.push(programIcon);
    } else if (device.PowerState === "On" || device.PowerState === "Standby") {
      statusIcons.push(
        `<i class='fa fa-toggle-on deviceStatusIcon' title='${device.PowerState}'></i>`
      );
    } else if (device.PowerState === "Off") {
      statusIcons.push("<i class='fa fa-toggle-off deviceStatusIcon' title='Power off'></i>");
    }

    if (device.DoorState === "Open") {
      statusIcons.push("<i class='fa fa-door-open deviceStatusIcon' title='Door Open'></i>");
    }

    if (device.Lighting === true) {
      statusIcons.push("<i class='fa fa-lightbulb-o deviceStatusIcon' title='Light On'></i>");
    }

    return statusIcons.join("");
  },

  renderDeviceCard(device, runtimeHints, deviceUtils) {
    if (!deviceUtils.shouldDisplayDevice(device, this.config)) {
      return "";
    }

    const displayState = this.buildDeviceDisplayState(device, runtimeHints, deviceUtils);
    const { runtime, presentation } = displayState;
    const progressBarHtml = this.getDeviceProgressHtml(displayState);
    const containerClasses = ["deviceContainer"];
    if (!this.config.showDeviceIcon) {
      containerClasses.push("deviceContainerWithoutDeviceIcon");
    }
    if (runtime.explicitlyDisconnected) {
      containerClasses.push("deviceOffline");
    }

    let container = `<div class='${containerClasses.join(" ")}'>`;
    if (this.config.showDeviceIcon) {
      if (displayState.imageName) {
        container += `<img src='modules/MMM-HomeConnect2/Icons/${displayState.imageName}' class='device_img'>`;
      } else {
        container += `<div class='device_img deviceIconFallback'><i class='fa ${displayState.fallbackIconClass}'></i></div>`;
      }
    }
    container += `<div class='deviceStatusIcons'>${this.getStatusIconsHtml(device, displayState)}</div>`;
    container += `<div class='deviceName bright small'>${displayState.deviceName}`;
    if (presentation.programMeta) {
      container += `<div class='deviceProgram dimmed xsmall'>${presentation.programMeta}</div>`;
    }
    if (presentation.programSupplement) {
      container += `<div class='deviceProgramDetails dimmed xsmall'>${presentation.programSupplement}</div>`;
    }
    if (presentation.detailText) {
      container += `<div class='deviceProgramDetails dimmed xsmall'>${presentation.detailText}</div>`;
    }
    if (presentation.alertText) {
      container += `<div class='deviceAlert xsmall'>${presentation.alertText}</div>`;
    }
    container += "</div>";
    container += `<div class='deviceStatus dimmed xsmall'>${presentation.statusText}</div>`;
    container += `<div class='deviceProgressBar'>${progressBarHtml}</div>`;
    if (presentation.showProgressDebug) {
      container += `<div class='hc-device-debug'>${presentation.progressDebug}</div>`;
    }
    container += "</div>";

    return container;
  },

  getDom() {
    const div = document.createElement("div");
    const runtimeHints = this.deviceRuntimeHints || (this.deviceRuntimeHints = {});
    const deviceUtils = this.getDeviceUtils();

    // Show authentication info if available
    if (this.authInfo && this.authInfo.status === "waiting") {
      div.innerHTML = this.getAuthHTML();
      return div;
    }

    // Show authentication status if available
    if (this.authStatus && this.authStatus.status === "polling") {
      div.innerHTML = this.getAuthStatusHTML();
      return div;
    }

    // Show error if authentication failed
    if (this.authStatus && this.authStatus.status === "error") {
      div.innerHTML = this.getAuthErrorHTML();
      return div;
    }

    // Show loading message if no devices yet
    if (!this.devices || this.devices.length === 0) {
      const loadingHtml =
        "<div class='small'>" +
        `<i class='fa fa-cog fa-spin'></i> ${this.translate("SESSION_BASED_AUTH")}<br>` +
        `<span class='dimmed'>${this.translate("LOADING_APPLIANCES")}...</span>` +
        "</div>";
      div.innerHTML = loadingHtml;
      return div;
    }

    const wrapper = this.devices
      .map((device) => this.renderDeviceCard(device, runtimeHints, deviceUtils))
      .filter(Boolean)
      .join("");

    if (wrapper === "") {
      div.innerHTML = `<div class='dimmed small'>${this.translate("NO_ACTIVE_APPLIANCES")}</div>${this.getDebugPanel()}`;
      return div;
    }

    const debugPanel = this.getDebugPanel();
    div.innerHTML = `${wrapper}${debugPanel}`;
    return div;
  },

  getAuthHTML() {
    let html = "";
    html += "<div class='auth-container'>";
    html += `<div class='auth-header'>🔐 ${this.translate("AUTH_TITLE")}</div>`;

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>📱 <strong>${this.translate("AUTH_STEP1")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    html += `<div class='auth-url'><a href='${this.authInfo.verification_uri}'>${this.authInfo.verification_uri}</a></div>`;
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>🔑 <strong>${this.translate("AUTH_STEP2")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    html += `<div class='auth-code'>${this.authInfo.user_code}</div>`;
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-step'>";
    html += `<div class='auth-step-title'>🔗 <strong>${this.translate("AUTH_STEP_DIRECT")}</strong></div>`;
    html += "<div class='auth-step-content'>";
    // Prefer QR SVG if provided by the helper; fallback to direct link
    if (this.authInfo.verification_qr_svg) {
      html += `<div class='auth-qr'>${this.authInfo.verification_qr_svg}</div>`;
    } else if (this.authInfo.verification_uri_complete) {
      html += `<div class='auth-url'><a href='${this.authInfo.verification_uri_complete}'>${this.authInfo.verification_uri_complete}</a></div>`;
    }
    html += "</div>";
    html += "</div>";

    html += "<div class='auth-footer'>";
    html += `<div class='auth-timer'>⏱️ ${this.translate("AUTH_CODE_EXPIRES")} ${this.authInfo.expires_in_minutes} ${this.translate("AUTH_MINUTES")}</div>`;
    html += "</div>";

    html += `<div class='auth-waiting'>${this.translate("AUTH_WAITING")}</div>`;
    html += "</div>";

    return html;
  },

  getAuthStatusHTML() {
    let html = "";
    html += "<div class='auth-container'>";
    html += `<div class='auth-header'>⏳ ${this.translate("AUTH_STATUS_WAITING")}</div>`;

    // Progress bar
    if (this.authStatus.attempt && this.authStatus.maxAttempts) {
      const progress = Math.round((this.authStatus.attempt / this.authStatus.maxAttempts) * 100);
      html += "<div class='progress-container'>";
      html += "<div class='progress-bar'>";
      html += `<div class='progress-fill' style='width: ${progress}%'></div>`;
      html += "</div>";
      html += "</div>";
    }

    html += `<div class='auth-message'>${this.authStatus.message}</div>`;

    if (this.authStatus.interval) {
      html += `<div class='auth-info'>${this.translate("AUTH_POLL_INTERVAL")} ${this.authStatus.interval} ${this.translate("AUTH_SECONDS")}</div>`;
    }

    html += "</div>";

    return html;
  },

  getDebugPanel() {
    const logLevel = (this.config?.logLevel || this.defaults.logLevel || "none").toLowerCase();
    if (logLevel !== "debug" || !this.debugStats) {
      return "";
    }
    const formatTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "n/a");
    const rows = [];

    // Status from INIT_STATUS gets rendered only in debug mode
    if (this.lastInitStatus && this.lastInitStatus.message) {
      rows.push(
        `<div class='hc-debug-row'><span class='hc-debug-label'>last init status:</span> ${this.lastInitStatus.message
        }</div>`
      );
    }

    rows.push(
      `<div class='hc-debug-row'><span class='hc-debug-label'>SSE:</span> ${formatTime(
        this.debugStats.lastSseEventTs
      )}</div>`
    );
    rows.push(
      `<div class='hc-debug-row'><span class='hc-debug-label'>API:</span> ${formatTime(
        this.debugStats.lastApiCallTs
      )}</div>`
    );
    const counters = this.debugStats.apiCounters || {};
    const counterEntries = Object.entries(counters);
    if (counterEntries.length) {
      rows.push("<div class='hc-debug-subtitle'>API counts</div>");
      counterEntries.sort(([a], [b]) => a.localeCompare(b));
      counterEntries.forEach(([name, value]) => {
        rows.push(
          `<div class='hc-debug-row'><span class='hc-debug-label'>${name}</span> ${value}</div>`
        );
      });
    }
    return `<div class='hc-debug-panel'>${rows.join("")}</div>`;
  },

  getAuthErrorHTML() {
    let html = "";
    html += "<div class='auth-container error'>";
    html += `<div class='auth-header'>❌ ${this.translate("AUTH_FAILED_TITLE")}</div>`;
    html += `<div class='auth-message'>${this.authStatus.message}</div>`;
    html += `<div class='auth-info'>${this.translate("AUTH_FAILED_INFO")}</div>`;
    html += "</div>";

    return html;
  }
}); // End Module
