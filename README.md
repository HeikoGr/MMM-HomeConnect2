# MMM-HomeConnect (Headless Device Flow)

This module connects MagicMirror to BSH (Bosch, Siemens, Neff, Gaggenau, ...) devices. It uses the OAuth2 Device Flow so a browser is not required on the MagicMirror server.

Key features
- Headless Device Flow authentication (no local browser needed)
- On-screen instructions and code for user authentication
- Token storage and automatic refresh
- Basic rate limiting and error handling

Quick install
```bash
cd ~/MagicMirror/modules
git clone https://github.com/djerik/MMM-HomeConnect
cd MMM-HomeConnect
npm install
```

- You need to have a registred Home Connect Account with eMail and password with connected Home Connect devices.
- You also need to register for a Home Connect Developer Account [Home Connect Registration](https://developer.home-connect.com/user/register).
- You also need to register an Application in the developer portal to get a Client ID
- a Client Secret is not needed for headless authentication.

Simple config example (add to your MagicMirror `config/config.js`):

```js
{
    module: "MMM-HomeConnect",
    position: "top_left",
    config: {
        client_ID: "YOUR_CLIENT_ID",
        client_Secret: "YOUR_CLIENT_SECRET",
        use_headless_auth: true,
        showDeviceIcon: true,
        updateFrequency: 60 * 60 * 1000 // 1 hour
    }
}
```

How authentication works
- First time: module shows a URL and a short code on the MagicMirror screen.
- Open that URL on any device, enter the code and grant access.
- The module saves tokens locally and uses them to call the API.

If the token expires, the module will automatically refresh it when possible.

Troubleshooting
- If you see "polling too quickly" errors, wait a minute and try again.
- Check logs with `pm2 logs mm` or in your terminal.
- Token file: `modules/MMM-HomeConnect/refresh_token.json` (do not commit this file).

Security
- Keep `client_Secret` and `refresh_token.json` private. Do not commit them to git.

Developer notes
- API endpoints used: device_authorization, token, and homeappliances endpoints of Home Connect.
- Minimum polling interval: 5 seconds. Module adapts if server returns slow_down.

License
- MIT

Support
- This is a community fork. Open an issue for bugs or questions.
````