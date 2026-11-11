# Authentication

MMM-HomeConnect2 uses the OAuth2 device flow.

## First Login

1. Start MagicMirror with the module enabled.
2. Wait for the module to display a verification URL and short code.
3. Open the URL on another device.
4. Enter the code and grant access.

## After Authorization

- The module stores the refresh token in `.state/refresh_token.json` inside the module folder.
- Future restarts should reuse the saved token automatically.
- If the refresh token becomes invalid, the device flow is shown again.

## Security Notes

- Keep `clientSecret` private if you use one.
- The refresh token grants access to your Home Connect account. It is kept in `.state/` because
  MagicMirror serves the whole `modules/` folder over HTTP and skips only paths starting with a dot.
- Do not commit the `.state/` folder to git.

### Updating from 1.7.8 or older

Older versions kept `refresh_token.json`, `rate_limit.json`, `run_state.json` and
`program_stats.json` directly in the module folder, where MagicMirror served them, for example at
`http://<mirror>:8080/modules/MMM-HomeConnect2/refresh_token.json`. On the first start after the
update the module moves them into `.state/` on its own; no new login is needed.

If your mirror was reachable from other devices (an `ipWhitelist` that allows more than
`localhost`), treat the old token as exposed: remove the module's access in your Home Connect
account (app settings or the developer portal), then restart MagicMirror and sign in again with
the QR code.

## Common Auth Problems

- If authorization seems stuck, wait briefly before retrying because the API may enforce a polling interval.
- If you changed your Home Connect app settings, re-run the device flow with the updated client ID or secret.