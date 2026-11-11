# Security

The module holds a refresh token for your Home Connect account. Whoever has that token (and your
client ID) can read your appliances' states and, depending on what your developer application allows,
control them. A few settings decide who can get at it.

## Who can reach the mirror

MagicMirror serves its web page and the whole `modules/` folder on its port (8080 by default).

- `address` and `ipWhitelist` in `config/config.js` decide which devices may connect. The default
  (`address: "localhost"`, `ipWhitelist` with only local addresses) allows only the mirror itself.
- `address: "0.0.0.0"` with `ipWhitelist: []` opens the mirror to every device in your network. Do
  that only if you need it, and prefer listing the addresses of the devices that should connect.
- Never forward the MagicMirror port to the internet.

The module keeps its token and state files in `.state/` inside the module folder, which MagicMirror
does not serve. Versions up to 1.7.8 kept them next to the module, where they could be downloaded; see
[Authentication](Authentication#updating-from-178-or-older) if you update from such a version.

## Secrets in config.js

`clientId` and `clientSecret` can stay out of the browser: write them as
`${SECRET_HC_CLIENT_ID}` and `${SECRET_HC_CLIENT_SECRET}`, put the values into `config/config.env`
and set `hideConfigSecrets: true` (see the MagicMirror documentation on config variables for the
details). The browser then only sees the placeholders; the module's backend takes the real values from
the server's own config.

## Revoking access

If you think the token got out (an exposed mirror, a shared backup, a log posted somewhere):

1. Remove the application's access in your Home Connect account (Home Connect app, profile settings,
   or the developer portal for a private application).
2. Delete `.state/refresh_token.json` and restart MagicMirror.
3. Sign in again with the QR code.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/HeikoGr/MMM-HomeConnect2/blob/master/SECURITY.md).
