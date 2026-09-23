/*
 * Device display state: what a device card shows (progress, program line,
 * status texts), derived from the backend's device snapshot. Pure functions,
 * loaded in the browser via getScripts() and in the tests via require().
 */
(() => {
  "use strict";

  function computeProgressDisplayState({
    device,
    effectiveRemainingSeconds,
    estimatedTotalSeconds,
    progressNumeric,
    suppressSelectedProgramRuntime,
    effectiveOperationStateActive,
    observedPercent,
  }) {
    // A remaining time of exactly 0 turns this formula into a constant 100 %, which
    // is only meaningful while a program actually runs. Appliances keep reporting a
    // stale 0 next to the planned duration once a cycle is over, so without this
    // proof an idle appliance would paint a permanently full bar.
    const hasRunningProgramEvidence = effectiveRemainingSeconds > 0 || effectiveOperationStateActive === true;

    let estimatedTotalPercent;
    if (
      hasRunningProgramEvidence &&
      Number.isFinite(estimatedTotalSeconds) &&
      estimatedTotalSeconds > 0 &&
      Number.isFinite(effectiveRemainingSeconds) &&
      effectiveRemainingSeconds >= 0 &&
      effectiveRemainingSeconds <= estimatedTotalSeconds
    ) {
      estimatedTotalPercent = Math.max(
        0,
        Math.min(100, Math.round(((estimatedTotalSeconds - effectiveRemainingSeconds) / estimatedTotalSeconds) * 100)),
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
        Math.min(100, Math.round(((initialRemaining - effectiveRemainingSeconds) / initialRemaining) * 100)),
      );
    }

    // A reported 0 % is only meaningful while a program actually runs. Appliances
    // reset progress to 0 when a cycle ends and then stop updating it, so an idle
    // appliance carrying that leftover value must fall back to the other sources
    // (or show no bar at all) instead of claiming a program is at 0 %.
    const canTrustExplicitProgress =
      !suppressSelectedProgramRuntime &&
      progressNumeric !== undefined &&
      (progressNumeric > 0 || (effectiveOperationStateActive && !(effectiveRemainingSeconds > 0)));

    let percent;
    let progressSource = "none";
    if (canTrustExplicitProgress) {
      percent = progressNumeric;
      progressSource = "programProgress";
    } else if (estimatedTotalPercent !== undefined) {
      percent = estimatedTotalPercent;
      progressSource = "estimatedTotalProgramTime";
    } else if (observedPercent !== undefined && (initialPercent === undefined || observedPercent > initialPercent)) {
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
      initialPercent,
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

  // Thin adapter over the shared state parser. `isActive` deliberately means "Run"
  // and nothing else: delayed start and pause carry their own icons, and an
  // unrecognised state must never be interpreted as running.
  function getOperationStateInfo(device, deviceUtils) {
    const state = deviceUtils.parseOperationState(device);

    return {
      known: state.known,
      isFinished: state.isFinished,
      isActive: state.isRun,
      isDelayedStart: state.isDelayedStart,
      isPaused: state.isPaused,
      hasNoProgram: state.hasNoProgram,
    };
  }

  function isWrinkleProtectionLabel(value) {
    return typeof value === "string" && /(Wrinkle|Less\s+Ironing|Knitterschutz|Kr[oø]lle)/i.test(value);
  }

  function computeProgramDisplayState({
    device,
    operationStateHasNoProgram,
    operationStateDelayedStart,
    programRunning,
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
    formatClockTime,
  }) {
    const plannedDurationLabel =
      Number.isFinite(estimatedTotalSeconds) && estimatedTotalSeconds > 0
        ? `${hasEstimatedDuration ? `${translate("APPROX_PREFIX")} ` : ""}${formatDuration(estimatedTotalSeconds)}`
        : "";
    const visiblePlannedDurationLabel = suppressSelectedProgramRuntime ? "" : plannedDurationLabel;
    const showPlannedDurationInTitle = !(visibleRemainingSeconds > 0);
    const rawProgramName = typeof device.ActiveProgramName === "string" ? device.ActiveProgramName : "";
    const rawSource = device.ActiveProgramSource || (rawProgramName ? "active" : "");
    // "active" claims that this program is running right now. An appliance reporting
    // Inactive or Ready contradicts that, and the operation state is the more
    // reliable of the two: it keeps being reported, while the program data lingers
    // from the run that just ended. What remains is the program on the dial, which
    // is exactly what "selected" means. A finished program is left alone - it is not
    // running either, but it is still worth naming. The backend demotes the same
    // way; this also catches a device object that has not been refreshed since.
    const source = rawSource === "active" && operationStateHasNoProgram ? "selected" : rawSource;
    // A merely selected program says nothing about what the appliance is doing - the
    // dial can sit on "Synthetics" for days. It is only worth showing once that
    // program is actually running or scheduled to start.
    const showSelectedProgram = programRunning || operationStateDelayedStart;
    let programName;
    if (source === "active" && rawProgramName) {
      programName = `${translate("ACTIVE_PROGRAM")}: ${rawProgramName}`;
    } else if (source === "selected" && rawProgramName) {
      programName = showSelectedProgram ? `${translate("SELECTED_PROGRAM")}: ${rawProgramName}` : "";
    } else if (source === "available" && Array.isArray(device.AvailablePrograms) && device.AvailablePrograms.length) {
      programName = `${translate("AVAILABLE_PROGRAMS")}: ${device.AvailablePrograms.join(", ")}`;
    } else {
      programName = rawProgramName;
    }
    const showProgramDetails = source === "active" || (source === "selected" && showSelectedProgram);
    const programPhase =
      showProgramDetails && typeof device.ActiveProgramPhase === "string" ? device.ActiveProgramPhase : "";
    const programDetails =
      showProgramDetails && Array.isArray(device.ActiveProgramDetails)
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
      isFinished && [programPhase, ...programDetails].some((value) => isWrinkleProtectionLabel(value));
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
          nowMs + effectiveFinishInRelativeSeconds * 1000,
        )}`,
      );
    }
    const delayedStartText = operationStateDelayedStart
      ? effectiveStartInRelativeSeconds > 0
        ? `${translate("DELAYED_START")} • ${translate("STARTS_IN")} ${hasEstimatedDuration ? `${translate("APPROX_PREFIX")} ` : ""}${formatDuration(effectiveStartInRelativeSeconds)}${delayedStartScheduleParts.length ? ` • ${delayedStartScheduleParts.join(" • ")}` : ""}`
        : translate("DELAYED_START")
      : "";
    // A planned duration is a property of a program, so it is only shown next to the
    // program it belongs to. On its own it is unattributable - after a cycle ends an
    // appliance keeps reporting the duration of the run that just finished, and a
    // bare "approx. 2h 29m" under an idle appliance claims a program that is not
    // there. While a program runs the remaining time is the better number anyway,
    // which is what showPlannedDurationInTitle already encodes.
    const programMeta =
      programName && visiblePlannedDurationLabel && showPlannedDurationInTitle
        ? `${programName} • ${visiblePlannedDurationLabel}`
        : programName;

    return {
      programMeta,
      programSupplement: programSupplementParts.join(" | "),
      wrinkleProtectionActive,
      delayedStartText,
      visiblePlannedDurationLabel,
    };
  }

  /**
   * lib/device-utils.js functions with safe fallbacks for any that are missing.
   *
   * @param {object} [browserUtils] - window.HomeConnectDeviceUtils
   * @returns {object} Complete set of device-utils functions
   */
  function withDeviceUtilsFallbacks(browserUtils = {}) {
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
        typeof browserUtils.parseRemainingSeconds === "function" ? browserUtils.parseRemainingSeconds : () => null,
      parseProgress: typeof browserUtils.parseProgress === "function" ? browserUtils.parseProgress : () => undefined,
      parseEstimatedTotalSeconds:
        typeof browserUtils.parseEstimatedTotalSeconds === "function"
          ? browserUtils.parseEstimatedTotalSeconds
          : () => null,
      isEstimatedDuration:
        typeof browserUtils.isEstimatedDuration === "function" ? browserUtils.isEstimatedDuration : () => false,
      getDeviceTypeMeta:
        typeof browserUtils.getDeviceTypeMeta === "function"
          ? browserUtils.getDeviceTypeMeta
          : (type) => ({ iconName: type ? `${type}.png` : null, fallbackIconClass: "fa-plug" }),
      isDeviceExplicitlyDisconnected:
        typeof browserUtils.isDeviceExplicitlyDisconnected === "function"
          ? browserUtils.isDeviceExplicitlyDisconnected
          : () => false,
      shouldDisplayDevice:
        typeof browserUtils.shouldDisplayDevice === "function" ? browserUtils.shouldDisplayDevice : () => false,
      parseOperationState:
        typeof browserUtils.parseOperationState === "function"
          ? browserUtils.parseOperationState
          : () => ({
              known: false,
              isRun: false,
              isPaused: false,
              isDelayedStart: false,
              isFinished: false,
              hasProgramInProgress: false,
            }),
    };
  }

  function getUniqueStrings(values, maxItems = Infinity) {
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
  }

  function getObjectSummaryValues(value, maxItems = Infinity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    return getUniqueStrings(Object.values(value), maxItems);
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) {
      return "";
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours > 0 ? `${hours}h ` : ""}${String(minutes).padStart(2, "0")}m`;
  }

  function formatDebugAge(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return "n/a";
    }

    const ageSeconds = Math.max(0, Math.round((now - timestamp) / 1000));
    return formatDuration(ageSeconds) || `${ageSeconds}s`;
  }

  function getObservedProgressEstimate(device, remainingSeconds, now = Date.now()) {
    const observedAt = Number(device?._remainingObservedAt);
    if (!Number.isFinite(observedAt) || !(remainingSeconds > 0)) {
      return undefined;
    }

    const observedElapsedSeconds = Math.max(0, Math.round((now - observedAt) / 1000));
    if (observedElapsedSeconds <= 0) {
      return undefined;
    }

    const estimatedTotalSeconds = observedElapsedSeconds + remainingSeconds;
    if (!(estimatedTotalSeconds > 0)) {
      return undefined;
    }

    return Math.max(0, Math.min(100, Math.round((observedElapsedSeconds / estimatedTotalSeconds) * 100)));
  }

  function getEffectiveRemainingSeconds(device, remainingSeconds, now = Date.now()) {
    if (!(remainingSeconds > 0)) {
      return remainingSeconds;
    }

    const lastSeenAt = Number(device?._lastRemainingSeenAt || device?._remainingObservedAt);
    if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
      return remainingSeconds;
    }

    const elapsedSeconds = Math.max(0, Math.round((now - lastSeenAt) / 1000));
    return Math.max(0, remainingSeconds - elapsedSeconds);
  }

  function getDeviceRuntimeHint(runtimeHints, device) {
    const deviceKey = device.haId || device.haid || device.id || device.name || "unknown";
    if (!runtimeHints[deviceKey]) {
      runtimeHints[deviceKey] = { hadActive: false };
    }
    return runtimeHints[deviceKey];
  }

  function updateRuntimeHintState({
    hint,
    powerState,
    remainingSeconds,
    progressNumeric,
    operationStateActive,
    suppressSelectedProgramRuntime,
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
  }

  /**
   * Everything a device card shows, derived from one device snapshot.
   *
   * @param {object} device - Device as pushed by the backend
   * @param {object} runtimeHints - Per-device memory across renders (mutated)
   * @param {object} deviceUtils - lib/device-utils.js functions (with fallbacks)
   * @param {object} ctx - { translate, formatClockTime, debug, now }
   * @returns {object} { deviceName, imageName, fallbackIconClass, runtime, presentation }
   */
  function buildDeviceDisplayState(device, runtimeHints, deviceUtils, ctx) {
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const translate = ctx.translate;
    const explicitlyDisconnected = deviceUtils.isDeviceExplicitlyDisconnected(device);
    const remainingSeconds = deviceUtils.parseRemainingSeconds(device);
    const effectiveRemainingSeconds = getEffectiveRemainingSeconds(device, remainingSeconds, now);
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
    const hint = getDeviceRuntimeHint(runtimeHints, device);
    const progressNumeric = normalizeProgressValue(progressValue);
    const operationState = getOperationStateInfo(device, deviceUtils);
    const hasRuntimeSignalsForSelectedProgram =
      operationState.isActive ||
      (Number.isFinite(remainingSeconds) && remainingSeconds > 0 && !hasEstimatedDuration) ||
      (progressNumeric !== undefined && progressNumeric > 0 && progressNumeric < 100);
    const suppressSelectedProgramRuntime =
      device.ActiveProgramSource === "selected" &&
      !operationState.isDelayedStart &&
      !hasRuntimeSignalsForSelectedProgram;
    const effectiveOperationStateActive = suppressSelectedProgramRuntime ? false : operationState.isActive;
    const finishedViaZero = updateRuntimeHintState({
      hint,
      powerState: device.PowerState,
      remainingSeconds,
      progressNumeric,
      operationStateActive: effectiveOperationStateActive,
      suppressSelectedProgramRuntime,
    });
    const isFinished = operationState.isFinished || progressNumeric === 100 || finishedViaZero;
    // The play icon and the selected-program line are factual claims about the
    // appliance, so they need proof: an operation state we understand that says
    // "Run". Remaining times and progress values routinely survive a finished or
    // merely selected program and must not be used to infer that something runs.
    const programRunning = operationState.known && effectiveOperationStateActive && !isFinished;
    if (isFinished) {
      hint.hadActive = false;
    }
    const observedPercent = getObservedProgressEstimate(device, effectiveRemainingSeconds, now);
    const progressState = computeProgressDisplayState({
      device,
      effectiveRemainingSeconds,
      estimatedTotalSeconds,
      progressNumeric,
      suppressSelectedProgramRuntime,
      effectiveOperationStateActive,
      observedPercent,
    });
    const { percent, progressSource, visibleRemainingSeconds, isIndeterminate, estimatedTotalPercent, initialPercent } =
      progressState;

    const typeMeta = deviceUtils.getDeviceTypeMeta(device.type);
    const programState = computeProgramDisplayState({
      device,
      operationStateHasNoProgram: operationState.hasNoProgram,
      operationStateDelayedStart: operationState.isDelayedStart,
      programRunning,
      suppressSelectedProgramRuntime,
      visibleRemainingSeconds,
      estimatedTotalSeconds,
      hasEstimatedDuration,
      startInRelativeSeconds,
      finishInRelativeSeconds,
      isFinished,
      nowMs: now,
      translate,
      formatDuration,
      formatClockTime: ctx.formatClockTime,
    });
    const { programMeta, programSupplement, wrinkleProtectionActive, delayedStartText, visiblePlannedDurationLabel } =
      programState;

    const deviceSpecificDetails = getObjectSummaryValues(device.DeviceStatusByKey, 4);
    const deviceAlerts = getObjectSummaryValues(device.DeviceAlertsByKey, 3);

    const detailText = deviceSpecificDetails.join(" • ");
    const alertText = deviceAlerts.length ? `${translate("ACTIVE_ALERTS")}: ${deviceAlerts.join(" • ")}` : "";

    const statusText = explicitlyDisconnected
      ? translate("DEVICE_NOT_CONNECTED")
      : visibleRemainingSeconds > 0
        ? `${translate("DONE_IN")} ${hasEstimatedDuration ? `${translate("APPROX_PREFIX")} ` : ""}${formatDuration(visibleRemainingSeconds)}`
        : "";
    const showProgressDebug = ctx.debug === true;
    const progressDebug = showProgressDebug
      ? [
          `src=${progressSource}`,
          `api=${progressNumeric !== undefined ? `${progressNumeric}%` : "n/a"}`,
          `total=${estimatedTotalPercent !== undefined ? `${estimatedTotalPercent}%` : "n/a"}`,
          `initial=${initialPercent !== undefined ? `${initialPercent}%` : "n/a"}`,
          `observed=${observedPercent !== undefined ? `${observedPercent}%` : "n/a"}`,
          `remaining=${visibleRemainingSeconds !== null ? formatDuration(visibleRemainingSeconds) || `${visibleRemainingSeconds}s` : "n/a"}`,
          `rawRemaining=${remainingSeconds !== null ? formatDuration(remainingSeconds) || `${remainingSeconds}s` : "n/a"}`,
          `planned=${visiblePlannedDurationLabel || "n/a"}`,
          `seen=${formatDebugAge(Number(device._remainingObservedAt), now)}`,
        ].join(" | ")
      : "";

    return {
      deviceName: device.name,
      imageName: typeMeta.iconName,
      fallbackIconClass: typeMeta.fallbackIconClass,
      runtime: {
        explicitlyDisconnected,
        operationStateDelayedStart: operationState.isDelayedStart,
        operationStatePaused: operationState.isPaused,
        programRunning,
        isFinished,
        isIndeterminate,
        wrinkleProtectionActive,
        percent,
      },
      presentation: {
        delayedStartText,
        progressDebug,
        programMeta,
        detailText,
        alertText,
        programSupplement,
        showProgressDebug,
        statusText,
      },
    };
  }

  const exportsObj = {
    buildDeviceDisplayState,
    computeProgramDisplayState,
    computeProgressDisplayState,
    formatDebugAge,
    formatDuration,
    getObjectSummaryValues,
    getOperationStateInfo,
    getUniqueStrings,
    normalizeProgressValue,
    withDeviceUtilsFallbacks,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportsObj;
  }

  if (typeof window !== "undefined") {
    window.HomeConnectDisplayState = exportsObj;
  }
})();
