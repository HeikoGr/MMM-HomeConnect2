"use strict";

let moduleLogLevel = "none";

function setModuleLogLevel(level) {
    if (!level) return;
    moduleLogLevel = String(level).toLowerCase();
}

function moduleLog(level, ...args) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
    const cfg = moduleLogLevel in levels ? moduleLogLevel : "none";
    const lvl = level in levels ? level : "info";
    if (levels[lvl] < levels[cfg]) return; // skip if below configured level
    const prefix = "[MMM-HomeConnect]";
    try {
        if (lvl === "debug") {
            if (typeof console.debug === "function") console.debug(prefix, ...args);
            else console.log(prefix, ...args);
        } else if (lvl === "info") {
            console.log(prefix, ...args);
        } else if (lvl === "warn") {
            console.warn(prefix, ...args);
        } else {
            console.error(prefix, ...args);
        }
    } catch (error) {
        console.log("Error in moduleLog:", error);
    }
}

module.exports = {
    setModuleLogLevel,
    moduleLog
};
