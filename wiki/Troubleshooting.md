# Troubleshooting

## Common Issues

### Polling too quickly

Wait a minute and try again. The Home Connect device-flow endpoints can enforce polling backoff.

### No devices shown

- Verify the Home Connect account actually has connected appliances.
- Check whether your app was authorized successfully.
- Enable `logLevel: "debug"` to inspect runtime state.

### SSE or live updates stop

- The module rebuilds the SSE subscription automatically after 70 seconds without any traffic.
- Enable `logLevel: "debug"` to see when that happens in the log.

### Configuration mismatch banner

The banner only appears when a display sends different `clientId` or `clientSecret`
values than the running session - that is a different Home Connect account and cannot
be served by the shared session. Align the credentials and reload.

A dimmed note listing option names instead means harmless drift: the display stays
connected and simply runs with the session settings established by the first client.
The log line `Client config differs from the running session` names the exact keys and
values. Usually the second browser has a cached older module version - a hard reload
fixes it.

### Rate limits

The module already throttles some backend requests. If the API returns HTTP 429, wait for the internal backoff window before retrying.

The block is saved to `rate_limit.json` next to the module, so a restart during it does not start
a new session (token refresh, snapshot, event streams) that would only draw more 429s. The display
shows the remaining time, and the session starts on its own once the block ends. Delete the file
to start immediately anyway.

During a block the module sends nothing to the API at all: a 429 while the session starts is
recorded as a block (honouring `Retry-After`), the start is retried only after it, and program
requests triggered by appliance events wait as well. The scheduled snapshot catches up afterwards.

### Token problems

- Check that `refresh_token.json` exists and is writable.
- If a stored token is broken, delete it and complete the device flow again.