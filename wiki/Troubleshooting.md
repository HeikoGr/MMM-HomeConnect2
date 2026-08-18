# Troubleshooting

## Common Issues

### Polling too quickly

Wait a minute and try again. The Home Connect device-flow endpoints can enforce polling backoff.

### No devices shown

- Verify the Home Connect account actually has connected appliances.
- Check whether your app was authorized successfully.
- Enable `logLevel: "debug"` to inspect runtime state.

### SSE or live updates stop

- The module can rebuild its SSE subscription automatically.
- Review `sseHeartbeatCheckIntervalMs`, `sseHeartbeatStaleThresholdMs`, and `sseRecoveryCooldownMs` if your network is unstable.

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

### Token problems

- Check that `refresh_token.json` exists and is writable.
- If a stored token is broken, delete it and complete the device flow again.