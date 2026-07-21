# Authentication

MMM-HomeConnect2 uses the OAuth2 device flow.

## First Login

1. Start MagicMirror with the module enabled.
2. Wait for the module to display a verification URL and short code.
3. Open the URL on another device.
4. Enter the code and grant access.

## After Authorization

- The module stores refresh data locally in `refresh_token.json`.
- Future restarts should reuse the saved token automatically.
- If the refresh token becomes invalid, the device flow is shown again.

## Security Notes

- Keep `clientSecret` private if you use one.
- Do not commit `refresh_token.json` to git.

## Common Auth Problems

- If authorization seems stuck, wait briefly before retrying because the API may enforce a polling interval.
- If you changed your Home Connect app settings, re-run the device flow with the updated client ID or secret.