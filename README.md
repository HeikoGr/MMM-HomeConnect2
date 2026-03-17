# MMM-HomeConnect2 (Headless Device Flow)

This module connects MagicMirror to BSH (Bosch, Siemens, Neff, Gaggenau, ...) devices. It uses the OAuth2 Device Flow so a browser is not required on the MagicMirror server.

## Overview / Appliance Status
![Overview of appliance status](img/screenshot.png)

Key features
- Headless Device Flow authentication (no local browser needed)
- On-screen instructions and code for user authentication
- Token storage and automatic refresh
- Basic rate limiting and error handling

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/HeikoGr/MMM-HomeConnect2
cd MMM-HomeConnect2
npm install
```

## Update

```bash
cd ~/MagicMirror/modules/MMM-HomeConnect2
git pull
npm install
```

##  Requirements

- You need to have a registred Home Connect Account with eMail and password with connected Home Connect devices.
- You also need to register for a Home Connect Developer Account [Home Connect Registration](https://developer.home-connect.com/user/register).
- You also need to register an Application in the developer portal to get a Client ID
- a Client Secret is not needed for headless authentication.

Simple config example (add to your MagicMirror `config/config.js`):

```js
{
    module: "MMM-HomeConnect2",
    position: "top_left",
    config: {
        clientId: "YOUR_CLIENT_ID",
        showDeviceIcon: true,
        updateFrequency: 60 * 60 * 1000 // 1 hour
    }
},
```

### Authentication / Device Flow
![Authentication Workflow visualisation](img/pic01_auth.png)

How authentication works
- First time: module shows a URL and a short code on the MagicMirror screen.
- Open that URL on any device, enter the code and grant access.
- The module saves tokens locally and uses them to call the API.

If the token expires, the module will automatically refresh it when possible.

Troubleshooting
- If you see "polling too quickly" errors, wait a minute and try again.
- Check logs with `pm2 logs mm` or in your terminal.
- Token file: `modules/MMM-HomeConnect2/refresh_token.json` (do not commit this file).

Security
- Keep `clientSecret` and `refresh_token.json` private. Do not commit them to git.

Developer notes
- API endpoints used: device_authorization, token, and homeappliances endpoints of Home Connect.
- Minimum polling interval: 5 seconds. Module adapts if server returns slow_down.

## Comparison to the original

This fork is based on djerik's [MMM-HomeConnect](https://github.com/djerik/MMM-HomeConnect).

**Main differences:**
- **Device Flow only** — no built-in Express server or browser-based OAuth fallback; optimized for headless environments
- **QR code authentication** — scan the URL directly with your phone
- **Reduced dependencies** — removed `express` and `open` packages
- **Improved error handling** — better logging and token refresh logic

**When to use the original:** If you prefer automatic browser-based OAuth or need the exact original implementation.

**Credits:** Many thanks to djerik for the original module.