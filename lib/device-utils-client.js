/* Browser helper for MMM-HomeConnect2: exposes parsing helpers to the frontend
 * This file is intentionally small and attaches helpers to the global
 * `window.HomeConnectDeviceUtils` object so `MMM-HomeConnect2.js` can reuse
 * the same parsing logic as the backend.
 */
(function () {
    function parseRemainingSeconds(device) {
        const remCandidates = [
            device.RemainingProgramTime,
            device.remainingProgramTime,
            device.remaining_time,
            device.remaining,
            device['BSH.Common.Status.RemainingProgramTime'],
            device['BSH.Common.Option.RemainingProgramTime']
        ];
        for (const v of remCandidates) {
            if (v === undefined || v === null) continue;
            if (typeof v === 'number' && !Number.isNaN(v)) return v;
            if (typeof v === 'string') {
                const n = parseInt(v, 10);
                if (!Number.isNaN(n)) return n;
                // ISO8601 PT..H..M..S
                const m = v.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                if (m) {
                    return (
                        (parseInt(m[1] || '0', 10) * 3600) +
                        (parseInt(m[2] || '0', 10) * 60) +
                        parseInt(m[3] || '0', 10)
                    );
                }
            }
        }
        return 0;
    }

    function parseProgress(device) {
        return (
            device.ProgramProgress ??
            device.programProgress ??
            device.program_progress ??
            device['BSH.Common.Option.ProgramProgress'] ??
            device['BSH.Common.Status.ProgramProgress'] ??
            undefined
        );
    }

    function deviceAppearsActive(device) {
        if (!device) return false;
        const rem = parseRemainingSeconds(device);
        if (typeof rem === 'number' && rem > 0) return true;
        const prog = parseProgress(device);
        if (typeof prog === 'number' && prog > 0 && prog < 100) return true;
        const op = device.OperationState || device.operationState || null;
        if (op && /(Run|Active|DelayedStart)/i.test(op)) return true;
        return false;
    }

    // Attach to window for frontend consumption
    if (typeof window !== 'undefined') {
        window.HomeConnectDeviceUtils = window.HomeConnectDeviceUtils || {};
        window.HomeConnectDeviceUtils.parseRemainingSeconds = parseRemainingSeconds;
        window.HomeConnectDeviceUtils.parseProgress = parseProgress;
        window.HomeConnectDeviceUtils.deviceAppearsActive = deviceAppearsActive;
    }
})();
