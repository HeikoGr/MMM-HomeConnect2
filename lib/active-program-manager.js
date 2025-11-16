"use strict";

class ActiveProgramManager {
  constructor(opts = {}) {
    this.fetchFn = opts.fetchFn; // async function(device, attempt) -> result
    this.broadcastFn = opts.broadcastFn; // function(programData, instanceId)
    this.logger = opts.logger || console;
    this.maxRetries = opts.maxRetries || 3;
    this.retryDelayMs = opts.retryDelayMs || 5000;
    this.timers = new Map(); // haId -> { attempt, timeoutId, instanceId }
  }

  clear(haId) {
    const s = this.timers.get(haId);
    if (s && s.timeoutId) clearTimeout(s.timeoutId);
    this.timers.delete(haId);
  }

  clearAll() {
    for (const [haId, st] of this.timers.entries()) {
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
          this.logger.debug(
            `ActiveProgramManager: max retries reached for ${device.name}`
          );
        this.timers.delete(device.haId);
        return;
      }
      if (current && current.timeoutId) {
        this.logger.debug &&
          this.logger.debug(
            `ActiveProgramManager: retry already scheduled for ${device.name}`
          );
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
    this.timers.set(device.haId, { attempt, timeoutId: null, instanceId });
    try {
      this.logger.debug &&
        this.logger.debug(
          `ActiveProgramManager: executing retry for ${device.name} (attempt ${attempt})`
        );
      const result = await this.fetchFn(device.haId, device.name);
      this.logger.debug &&
        this.logger.debug(
          `ActiveProgramManager: retry result for ${device.name}`,
          { success: result.success, error: result.error || null }
        );
      if (result.success && result.data) {
        // apply and broadcast via callback
        const payload = {
          [result.haId]: { name: device.name, program: result.data }
        };
        this.clear(device.haId);
        this.broadcastFn(payload, instanceId);
        return;
      }
      // Not successful: re-schedule if attempts remain and device still appears active
      if (
        attempt < this.maxRetries &&
        device &&
        typeof device !== "undefined"
      ) {
        // schedule another attempt
        this.schedule([device], instanceId);
        return;
      }
      this.clear(device.haId);
    } catch (err) {
      this.logger.error &&
        this.logger.error(
          `ActiveProgramManager: retry fetch failed for ${device.name}:`,
          err
        );
      this.clear(device.haId);
    }
  }
}

module.exports = ActiveProgramManager;
