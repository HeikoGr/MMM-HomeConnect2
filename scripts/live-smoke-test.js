"use strict";

// Live smoke test against the real Home Connect API (`node --run test:live`): uses the stored
// refresh token and the clientId from the environment (HC_CLIENT_ID, HC_CLIENT_SECRET) or from
// /opt/magic_mirror/config/config.js, lists the appliances and prints status, settings and the
// active program of each. Read-only, but every call counts against the daily API quota.

const { refreshTokenPath } = require("../lib/module-paths");

async function runLiveSmokeTest() {
  const fs = require("node:fs");
  if (!fs.existsSync(refreshTokenPath)) {
    console.log("No .state/refresh_token.json found – skipping live API smoke test.");
    return;
  }

  console.log("\nRunning live HomeConnect smoke test using existing refresh_token.json ...");

  const HomeConnect = require("../lib/homeconnect-api");

  let tokenValue = null;
  try {
    const raw = fs.readFileSync(refreshTokenPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") {
        tokenValue = parsed.trim();
      } else if (parsed && typeof parsed === "object" && parsed.refresh_token) {
        tokenValue = parsed.refresh_token;
      }
    } catch {
      tokenValue = raw.trim();
    }
  } catch {
    console.log("Could not read refresh_token.json – skipping live test.");
    return;
  }

  if (!tokenValue) {
    console.log("refresh_token.json does not contain a usable token – skipping live test.");
    return;
  }

  let clientId = process.env.HC_CLIENT_ID || "";
  let clientSecret = process.env.HC_CLIENT_SECRET || "";

  // If clientId is not provided via ENV, read it from the running MagicMirror config.
  if (!clientId) {
    try {
      // Read global MagicMirror config (absolute path)
      const cfgPath = "/opt/magic_mirror/config/config.js";
      const fs = require("node:fs");
      if (fs.existsSync(cfgPath)) {
        try {
          // Attempt to require the config file (common MagicMirror config exports)
          const mmConfig = require(cfgPath);
          if (mmConfig) {
            // Typical MagicMirror config exposes an array `modules`
            if (Array.isArray(mmConfig.modules)) {
              for (const mod of mmConfig.modules) {
                const modName = mod && (mod.module || mod.name);
                if (modName === "MMM-HomeConnect2") {
                  const mconf = mod.config || {};
                  clientId = clientId || mconf.clientId || mconf.client_ID || mconf.client_ID || mconf.client_Ident;
                  clientSecret = clientSecret || mconf.clientSecret || mconf.client_Secret;
                  break;
                }
              }
            } else {
              // Some configs export a plain object with credentials
              clientId = clientId || mmConfig.clientId || mmConfig.client_ID;
              clientSecret = clientSecret || mmConfig.clientSecret || mmConfig.client_Secret;
            }
          }
        } catch {
          // Fallback: parse file contents for common patterns
          try {
            const raw = fs.readFileSync(cfgPath, "utf8");
            const idMatch = raw.match(/client[_-]?ID\s*[:=]\s*["']([^"']+)["']/i);
            if (idMatch) clientId = idMatch[1].trim();
            const secretMatch = raw.match(/client[_-]?Secret\s*[:=]\s*["']([^"']+)["']/i);
            if (secretMatch) clientSecret = secretMatch[1].trim();
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore and fall through to ENV-based check
    }
  }

  if (!clientId) {
    console.log(
      "HC_CLIENT_ID not set and not found in /opt/magic_mirror/config/config.js – skipping live test. Set HC_CLIENT_ID to run.",
    );
    return;
  }

  if (!clientSecret) {
    console.log("HC_CLIENT_SECRET not set – attempting live init without secret (if API allows)");
  }

  let hc = null;
  try {
    hc = new HomeConnect(clientId, clientSecret, tokenValue);
    await hc.init({ isSimulated: false });

    const res = await hc.getHomeAppliances();
    let appliances = [];
    if (res?.success && res.data) {
      if (Array.isArray(res.data.homeappliances)) {
        appliances = res.data.homeappliances;
      } else if (Array.isArray(res.data)) {
        appliances = res.data;
      }
    }

    if (!appliances || appliances.length === 0) {
      console.log("Live smoke test: no appliances returned.");
      return;
    }

    console.log(`Live smoke test OK – fetched ${appliances.length} appliance(s).`);

    // helper to add a timeout to API calls to avoid hanging the script
    const callWithTimeout = async (fn, ms = 5000) => {
      return Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("api timeout")), ms))]);
    };

    for (const device of appliances) {
      const haId = device.haId || device.haid || device.id || device.deviceId || device.uuid || device.serial || null;
      console.log("\n--- Appliance ---");
      console.log("Name:", device.name || device.nameShort || device.model || "<unknown>");
      console.log("haId:", haId || "<no haId>");

      if (!haId) continue;

      // Fetch status
      try {
        const status = await callWithTimeout(() => hc.getStatus(haId), 7000);
        console.log("Status:", JSON.stringify(status, null, 2));
      } catch (e) {
        console.warn("Status fetch error for", haId, e?.message ? e.message : e);
      }

      // Fetch settings
      try {
        const settings = await callWithTimeout(() => hc.getSettings(haId), 7000);
        console.log("Settings:", JSON.stringify(settings, null, 2));
      } catch (e) {
        console.warn("Settings fetch error for", haId, e?.message ? e.message : e);
      }

      // Fetch active program
      try {
        const program = await callWithTimeout(() => hc.getActiveProgram(haId), 7000);
        console.log("ActiveProgram:", JSON.stringify(program, null, 2));
      } catch (e) {
        console.warn("ActiveProgram fetch error for", haId, e?.message ? e.message : e);
      }

      // Small pause between devices to avoid rate limits
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    console.error("Live smoke test error:", err?.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    // Stops the refresh timer and closes every event source, so the process can exit.
    hc?.destroy();
  }
}

runLiveSmokeTest();
