# API Call And Event Flow Diagrams

This document collects the Mermaid diagrams created so far for the question:
When are which Home Connect API calls executed, and how are events processed.

## Diagram 1: Overall Flow as Flowchart

```mermaid
flowchart TD
  %% =========================
  %% OVERVIEW
  %% =========================
  A[Frontend starts module] --> B[sendSocketNotification: CONFIG]
  B --> C[Node Helper: handleConfigNotification]

  C -->|Token available| D[initializeHomeConnect]
  C -->|No token| E[Headless Device Flow Auth]

  %% =========================
  %% AUTH FLOW
  %% =========================
  subgraph AUTH[Auth / Token]
    E --> E1[POST /security/oauth/device_authorization]
    E1 --> E2[pollForToken: POST /security/oauth/token]
    E2 -->|Interval: deviceAuth.interval, minimum 5s| E2
    E2 -->|slow_down| E3[Interval +5s, minimum 10s]
    E3 --> E2
    E2 -->|success| D

    D --> D1[refresh token to access token]
    D1 --> D2[Set token refresh timer]
    D2 -->|at 90 percent of expires_in| D3[refreshTokens]
    D3 --> D2
    D3 -->|Error| D4[Retry in 60s]
    D4 --> D3
  end

  %% =========================
  %% INITIAL DEVICE FETCH
  %% =========================
  D --> F[Initial device fetch after 2s]
  F --> G[DeviceService getDevices]
  G --> G1[API: getHomeAppliances]
  G1 --> G2[Per device: getStatus + getSettings]
  G2 --> G3[Broadcast MMM-HomeConnect_Update to frontend]

  %% =========================
  %% SSE SUBSCRIPTION + HEARTBEAT
  %% =========================
  G1 --> H[Set up SSE subscriptions]
  H --> H0[Pre-SSE Token Refresh optional]
  H0 --> H1[subscribe NOTIFY + STATUS + EVENT]
  H1 --> H2[Start SSE heartbeat monitor]

  subgraph SSE[SSE Runtime Behavior]
    H2 --> H3[Heartbeat check every 60s]
    H3 -->|no events for 3min or longer| H4[INIT_STATUS sse_stale]
    H3 -->|event received| H5[applyEventToDevice + broadcastDevices]
    H5 --> H6[INIT_STATUS sse_recovered if previously stale]

    H1 --> H7[EventSource Error]
    H7 -->|HTTP 401/403| H8[recoverFromAuthError -> refreshTokens]
    H8 -->|on error| H9[Recreate EventSources in 30s]
    H7 -->|HTTP 429| H9
    H7 -->|other errors| H10[Recreate EventSources in 5s]
    H9 --> H1
    H10 --> H1
  end

  %% =========================
  %% FRONTEND PERIODIC/UI TRIGGERS
  %% =========================
  subgraph FE[Frontend triggers]
    G3 --> I[Frontend receives MMM-HomeConnect_Update]
    I --> I1[updateDom]
    I --> I2[scheduleActiveProgramSnapshot]
    I --> I3[recoverMissingActivePrograms]

    I2 -->|only if since last request >= minActiveProgramIntervalMs| J[REQUEST_DEVICE_REFRESH with haIds]
    I2 -->|Default minActiveProgramIntervalMs: 10min| J

    I3 -->|only once per recovery cycle per device| K[REQUEST_DEVICE_REFRESH with bypassActiveProgramThrottle=true]
    I3 -->|if ActiveProgramSource is active or device is not running state reset| I3

    I4[UI Progress Timer] -->|every 30s, min 5s| I1
    I5[resume] -->|immediately| L[REQUEST_DEVICE_REFRESH forceRefresh true bypassActiveProgramThrottle true]
    I5 -->|after 1.5s| M[GET_ACTIVE_PROGRAMS force=true]
  end

  %% =========================
  %% REQUEST_DEVICE_REFRESH PATH
  %% =========================
  J --> N[Node: handleStateRefreshRequest]
  K --> N
  L --> N

  N --> N1{SSE healthy?}
  N1 -->|yes and not forceRefresh| N2[broadcastDevices from cache]
  N1 -->|no or forceRefresh| N3[getDevices then HomeAppliances Status Settings]
  N2 --> O[handleGetActivePrograms with bypassActiveProgramThrottle]
  N3 --> O

  %% =========================
  %% ACTIVE PROGRAM FETCH PATH
  %% =========================
  M --> O
  O --> O1{rateLimitUntil active and force false}
  O1 -->|yes| O2[INIT_STATUS device_error 429 plus remainingSeconds]
  O1 -->|no| O3{MIN_ACTIVE_PROGRAM_INTERVAL satisfied?}
  O3 -->|no and force false| O4[Throttled no API call]
  O3 -->|yes or force true| O5[fetchActiveProgramsForDevices]

  subgraph PROGRAMS[Program API calls per device]
    O5 --> P1{Device connected OR appearsActive?}
    P1 -->|no| P2[skip]
    P1 -->|yes| P3[getActiveProgram]
    P3 -->|200| P4[optional: getAvailableProgram for constraints]
    P3 -->|404| P5[getSelectedProgram]
    P5 -->|if needed| P6[getAvailablePrograms and getAvailableProgram]
    P3 -->|429| P7[RateLimit Error]
    P4 --> P8[applyProgramResult]
    P5 --> P8
    P6 --> P8
    P8 --> P9[between devices: 500ms delay]
  end

  O5 --> Q[Broadcast ACTIVE_PROGRAMS_DATA and MMM-HomeConnect_Update]
  P7 --> R[handleActiveProgramFetchError]
  R --> R1[rateLimitUntil set to now plus backoff]
  R1 -->|Backoff random: 2, 4 or 8 minutes| R2[INIT_STATUS device_error 429]

  %% =========================
  %% RETRY MANAGER
  %% =========================
  O5 --> S{No active program, but appearsActive?}
  S -->|yes| T[ActiveProgramManager.schedule]
  T -->|retryDelayMs: 5s| U[Retry getActiveProgram]
  U -->|max 3 retries per device| U
  U -->|success| Q

  %% =========================
  %% VISUAL RATE LIMIT
  %% =========================
  R2 --> V[Frontend detects statusCode 429 or isRateLimit]
  O2 --> V
  V --> W[Display banner: HTTP 429 + message + wait time]
```

## Diagram 2: Sequence Diagram

```mermaid
sequenceDiagram
  autonumber
  participant FE as Frontend MMM-HomeConnect2
  participant NH as node_helper
  participant DS as DeviceService
  participant PS as ProgramService
  participant APM as ActiveProgramManager
  participant HC as HomeConnect API
  participant SSE as HomeConnect SSE Stream

  Note over FE: Start
  FE->>NH: CONFIG(instanceId, config)
  NH->>NH: updateActiveProgramInterval()\nDefault: 10 min

  alt Refresh-Token available
    NH->>HC: init(refresh_token)
  else No token
    NH->>HC: POST /security/oauth/device_authorization
    loop Device flow polling (min 5s interval)
      NH->>HC: POST /security/oauth/token
      alt authorization_pending
        HC-->>NH: wait
      else slow_down
        HC-->>NH: increase interval (+5s, min 10s)
      else success
        HC-->>NH: access_token + refresh_token
      end
    end
  end

  Note over NH,HC: After successful init
  NH->>DS: attachClient(hc)
  NH->>PS: attachClient(hc)
  NH->>DS: getDevices() (initial after ~2s)

  DS->>HC: getHomeAppliances
  HC-->>DS: Device list
  loop per device (if connected or appearsActive)
    DS->>HC: getStatus
    DS->>HC: getSettings
  end
  DS->>DS: subscribe NOTIFY/STATUS/EVENT
  DS-->>FE: MMM-HomeConnect_Update(devices)

  Note over DS,SSE: SSE-Heartbeat
  loop every 60s (default)
    DS->>DS: heartbeat check
    alt >=3 min no events
      DS-->>FE: INIT_STATUS(sse_stale)
    else event received
      SSE-->>DS: event payload
      DS->>DS: applyEventToDevice + recordSseEvent
      DS-->>FE: MMM-HomeConnect_Update(devices)
      DS-->>FE: INIT_STATUS(sse_recovered) (if previously stale)
    end
  end

  Note over FE: UI-Timer
  loop progressRefreshIntervalMs (default 30s, min 5s)
    FE->>FE: updateDom()
  end

  Note over FE: On MMM-HomeConnect_Update
  FE->>FE: recoverMissingActivePrograms()
  alt missing ActiveProgram data and running
    FE->>NH: REQUEST_DEVICE_REFRESH(haIds, bypassActiveProgramThrottle=true)\n(max once per recovery cycle per device)
  end

  FE->>FE: scheduleActiveProgramSnapshot()
  alt since last request >= minActiveProgramIntervalMs (default 10 min)
    FE->>NH: REQUEST_DEVICE_REFRESH(haIds)
  end

  Note over NH: REQUEST_DEVICE_REFRESH processed
  NH->>NH: sseHealthy? subscribed && !heartbeatStale && hasDevices
  alt forceRefresh or SSE unhealthy
    NH->>DS: getDevices() -> HomeAppliances/Status/Settings
  else SSE healthy
    NH->>DS: broadcastDevices() from cache
  end
  NH->>NH: handleGetActivePrograms(force=bypassActiveProgramThrottle)

  alt rateLimitUntil active and force=false
    NH-->>FE: INIT_STATUS(device_error, 429, remainingSeconds)
  else Throttle active (MIN_ACTIVE_PROGRAM_INTERVAL)
    NH->>NH: no program API call
  else ActiveProgram call allowed
    NH->>NH: fetchActiveProgramsForDevices()
    loop per target device (sequential)
      alt connected or appearsActive
        NH->>PS: fetchActiveProgramForDevice(haId)
        PS->>HC: getActiveProgram
        alt 200 OK
          HC-->>PS: active program
          opt load constraints
            PS->>HC: getAvailableProgram(programKey)\n(Cache per haId+programKey)
            HC-->>PS: program definition
          end
        else 404
          HC-->>PS: not found
          PS->>HC: getSelectedProgram
          alt selected present
            HC-->>PS: selected program
            opt load constraints (cached)
              PS->>HC: getAvailableProgram(programKey)
              HC-->>PS: program definition
            end
          else fallback allowed (not for blocked types)
            PS->>HC: getAvailablePrograms
            HC-->>PS: available list
            PS->>HC: getAvailableProgram(firstProgramKey)
            HC-->>PS: program definition
          end
        else 429
          HC-->>PS: rate limit
          PS->>PS: throw 429
        end
        Note over NH: 500ms delay between devices
      else skip device
        NH->>NH: no call
      end
    end

    alt results available
      NH->>PS: applyProgramResult()
      NH-->>FE: MMM-HomeConnect_Update
      NH-->>FE: ACTIVE_PROGRAMS_DATA
    end

    alt No active program but appearsActive
      NH->>APM: schedule retry\nDelay 5s, max 3 retries
      loop Retry
        APM->>PS: fetchActiveProgramForDevice
        PS->>HC: getActiveProgram
      end
    end
  end

  alt 429 in Program-Flow
    PS->>PS: rateLimitUntil = now + backoff
    Note over PS: backoff random: 2 / 4 / 8 min
    PS-->>FE: INIT_STATUS(device_error, statusCode=429, isRateLimit=true)
    FE->>FE: show HTTP 429 banner
  end

  Note over HC: Token refresh cycle
  loop at ~90% token lifetime
    HC->>HC: refreshTokens()
    alt Success
      HC->>HC: recreateEventSources()
    else Error
      HC->>HC: Retry after 60s
    end
  end

  Note over SSE,HC: EventSource error handling
  alt 401/403
    HC->>HC: auth recovery + refreshTokens
    HC->>HC: recreate in 30s (authDelayMs)
  else 429
    HC->>HC: recreate in 30s (authDelayMs)
  else other errors
    HC->>HC: recreate in 5s (baseDelayMs)
  end

  Note over FE: resume()
  FE->>NH: REQUEST_DEVICE_REFRESH(forceRefresh=true, bypassActiveProgramThrottle=true)
  FE->>NH: GET_ACTIVE_PROGRAMS(force=true) after 1.5s
```
