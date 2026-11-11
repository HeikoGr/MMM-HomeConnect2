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
The log line `Client config differs from the running session` names the differing keys (not
their values, which may be credentials). Usually the second browser has a cached older module version - a hard reload
fixes it.

### Rate limits

The module already throttles some backend requests. If the API returns HTTP 429, wait for the internal backoff window before retrying.

The block is saved to `.state/rate_limit.json` in the module folder, so a restart during it does not start
a new session (token refresh, snapshot, event streams) that would only draw more 429s. The display
shows the remaining time, and the session starts on its own once the block ends. Delete the file
to start immediately anyway.

During a block the module sends nothing to the API at all: a 429 while the session starts is
recorded as a block (honouring `Retry-After`), the start is retried only after it, and program
requests triggered by appliance events wait as well. The scheduled snapshot catches up afterwards.

`Too many parallel monitoring connections. Maximum is 10` is different: Home Connect counts open
event streams per `clientId` and account. Only new streams are refused, REST requests still work, so
the module shows no rate-limit notice and keeps its 30-minute snapshot. A refused stream retries on
its own, up to once an hour. Appliances without a stream show snapshot data until then, and values
that only come from `/settings` (such as the power state) stay as they are. The log line
`monitoring channel limit reached with N channel(s) open here` shows how many of the 10 are this
module's. The debug panel lists each channel. If `N` is below 10, the rest is held elsewhere, for
example by another install with the same `clientId`, or Home Connect still counts streams it ended
itself. A separate `clientId` has its own count.

### Progress bar starts at 0 % after a restart

Home Connect reports no start time for a program. For appliances without a real progress value
(some dryers), the bar is elapsed time / (elapsed + remaining), counted from the moment the module
first saw the program running. That moment is saved to `.state/run_state.json` in the module folder and
restored after a restart, as long as the program and its remaining time still fit the saved run.
Delete the file to start counting afresh.

The module also keeps `.state/program_stats.json`: per appliance the list of available
programs and, per program, counters and the last 20 runs (a duration only when both start and end
were watched). A run starts when the program starts (not when a delayed start was set) and ends
when the program ends (not when a dryer's wrinkle guard is over); an error that the appliance
recovers from does not split it. It is filled from events the module receives anyway; the program
list is fetched once from an idle appliance and again only when an unknown program shows up. Both
files are gitignored and can be deleted at any time.

### Token problems

- Check that `.state/refresh_token.json` exists and that the module folder is writable.
- If a stored token is broken, delete it and complete the device flow again.