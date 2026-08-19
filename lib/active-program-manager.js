"use strict";

class ActiveProgramManager {
  constructor(opts = {}) {
    this.fetchFn = opts.fetchFn;
    this.broadcastFn = opts.broadcastFn;
    this.logger = opts.logger || console;
    this.maxRetries = opts.maxRetries || 3;
    this.retryDelayMs = opts.retryDelayMs || 5000;
    this.timers = new Map();
  }

  isRetryableProgramFetchFailure(result) {
    if (!result || typeof result !== "object") {
      return false;
    }

    if (result.error === "No active program") {
      return true;
    }

    const statusCode = Number(result.statusCode);
    if (Number.isFinite(statusCode)) {
      if ([401, 403, 429].includes(statusCode)) {
        return false;
      }
      if (statusCode >= 500) {
        return true;
      }
      return false;
    }

    const errorText = String(result.error || "").toLowerCase();
    if (
      errorText.includes("timeout") ||
      errorText.includes("etimedout") ||
      errorText.includes("temporar")
    ) {
      return true;
    }

    return false;
  }

  clear(haId) {
    const s = this.timers.get(haId);
    if (s && s.timeoutId) clearTimeout(s.timeoutId);
    this.timers.delete(haId);
  }

  clearAll() {
    for (const [, st] of this.timers.entries()) {
      if (st && st.timeoutId) clearTimeout(st.timeoutId);
    }
    this.timers.clear();
  }

  schedule(devices, instanceId) {
    devices.forEach((device) => {
      if (!device || !device.haId) return;
      const current = this.timers.get(device.haId);
      const next = (current?.attempt || 0) + 1;
      if (next > this.maxRetries) {
        this.logger.debug &&
          this.logger.debug(`ActiveProgramManager: max retries reached for ${device.name}`);
        this.timers.delete(device.haId);
        return;
      }
      if (current && (current.timeoutId || current.running)) {
        this.logger.debug &&
          this.logger.debug(`ActiveProgramManager: retry already scheduled for ${device.name}`);
        return;
      }
      this.logger.info &&
        this.logger.info(
          `ActiveProgramManager: scheduling retry for ${device.name} in ${this.retryDelayMs}ms (attempt ${next}/${this.maxRetries})`
        );
      const timeoutId = setTimeout(
        () => this._runRetry(device, instanceId, next),
        this.retryDelayMs
      );
      this.timers.set(device.haId, { attempt: next, timeoutId, instanceId });
    });
  }

  async _runRetry(device, instanceId, attempt) {
    if (!device) return;
    // running:true closes the window between the timer firing (timeoutId
    // cleared below) and this fetch resolving, during which a concurrent
    // schedule() call for the same device would otherwise slip past the
    // timeoutId check and queue a second, overlapping retry.
    this.timers.set(device.haId, { attempt, timeoutId: null, running: true, instanceId });
    try {
      this.logger.debug &&
        this.logger.debug(
          `ActiveProgramManager: executing retry for ${device.name} (attempt ${attempt})`
        );
      const result = await this.fetchFn(device.haId, device.name);
      this.logger.debug &&
        this.logger.debug(`ActiveProgramManager: retry result for ${device.name}`, {
          success: result.success,
          error: result.error || null
        });
      if (result.success && result.data) {
        // apply and broadcast via callback
        const payload = {
          [result.haId]: { name: device.name, program: result.data }
        };
        this.clear(device.haId);
        this.broadcastFn(payload, instanceId);
        return;
      }
      const retryableFailure = this.isRetryableProgramFetchFailure(result);
      if (this.logger.debug) {
        this.logger.debug(`ActiveProgramManager: failure classification for ${device.name}`, {
          retryableFailure,
          statusCode: result && result.statusCode,
          error: result && result.error
        });
      }

      // Re-schedule only for retryable failures.
      if (retryableFailure && attempt < this.maxRetries && device && typeof device !== "undefined") {
        // Clear the running flag first (keeping attempt so schedule() still
        // advances the retry count correctly) so this legitimate
        // self-reschedule isn't blocked by the same guard that stops
        // concurrent external schedule() calls while a fetch is in flight.
        this.timers.set(device.haId, { attempt, timeoutId: null, running: false, instanceId });
        this.schedule([device], instanceId);
        return;
      }
      this.clear(device.haId);
    } catch (err) {
      this.logger.error &&
        this.logger.error(`ActiveProgramManager: retry fetch failed for ${device.name}:`, err);
      this.clear(device.haId);
    }
  }
}

module.exports = ActiveProgramManager;
