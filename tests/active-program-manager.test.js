"use strict";

const assert = require("assert");
const ActiveProgramManager = require("../lib/active-program-manager");

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    // Retries transient "No active program" failures up to maxRetries.
    {
        const calls = [];
        const fetchFn = async () => {
            calls.push(Date.now());
            return {
                haId: "ha-1",
                success: false,
                statusCode: 404,
                error: "No active program"
            };
        };

        const manager = new ActiveProgramManager({
            fetchFn,
            broadcastFn: () => { },
            logger: { info() { }, debug() { }, error() { } },
            maxRetries: 3,
            retryDelayMs: 5
        });

        manager.schedule([{ haId: "ha-1", name: "Dishwasher" }], "instance-a");

        await wait(40);
        assert.strictEqual(calls.length, 3);
        manager.clearAll();
    }

    // Does not retry non-retryable auth/quota failures.
    {
        const calls = [];
        const fetchFn = async () => {
            calls.push(Date.now());
            return {
                haId: "ha-2",
                success: false,
                statusCode: 429,
                error: "rate limit"
            };
        };

        const manager = new ActiveProgramManager({
            fetchFn,
            broadcastFn: () => { },
            logger: { info() { }, debug() { }, error() { } },
            maxRetries: 3,
            retryDelayMs: 5
        });

        manager.schedule([{ haId: "ha-2", name: "Washer" }], "instance-b");

        await wait(30);
        assert.strictEqual(calls.length, 1);
        manager.clearAll();
    }

    // A schedule() call arriving while a retry fetch is in flight (timeoutId
    // already cleared, fetch not yet resolved) must not queue a second,
    // overlapping fetch for the same device.
    {
        const calls = [];
        let releaseFetch;
        const fetchFn = async () => {
            calls.push(Date.now());
            await new Promise((resolve) => {
                releaseFetch = resolve;
            });
            return { haId: "ha-3", success: false, statusCode: 404, error: "No active program" };
        };

        const manager = new ActiveProgramManager({
            fetchFn,
            broadcastFn: () => { },
            logger: { info() { }, debug() { }, error() { } },
            maxRetries: 3,
            retryDelayMs: 5
        });

        manager.schedule([{ haId: "ha-3", name: "Oven" }], "instance-c");
        await wait(15); // let the timer fire and the fetch start (calls.length === 1)
        assert.strictEqual(calls.length, 1);

        // Concurrent schedule() while the in-flight fetch above hasn't resolved yet.
        manager.schedule([{ haId: "ha-3", name: "Oven" }], "instance-c");
        await wait(15);
        assert.strictEqual(calls.length, 1, "must not start a second overlapping fetch");

        releaseFetch();
        await wait(15);
        manager.clearAll();
    }

    console.log("active-program-manager.test.js OK");
})();
