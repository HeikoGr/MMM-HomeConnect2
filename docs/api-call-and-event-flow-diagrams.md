# API Call And Event Flow Diagrams

Dieses Dokument sammelt die bisher erstellten Mermaid-Diagramme zur Frage:
Wann werden welche Home-Connect-API-Calls ausgefuehrt und wie werden Events verarbeitet.

## Diagramm 1: Gesamtfluss als Flowchart

```mermaid
flowchart TD
  %% =========================
  %% OVERVIEW
  %% =========================
  A[Frontend startet Modul] --> B[sendSocketNotification: CONFIG]
  B --> C[Node Helper: handleConfigNotification]

  C -->|Token vorhanden| D[initializeHomeConnect]
  C -->|Kein Token| E[Headless Device Flow Auth]

  %% =========================
  %% AUTH FLOW
  %% =========================
  subgraph AUTH[Auth / Token]
    E --> E1[POST /security/oauth/device_authorization]
    E1 --> E2[pollForToken: POST /security/oauth/token]
    E2 -->|Intervall: deviceAuth.interval, mindestens 5s| E2
    E2 -->|slow_down| E3[Intervall +5s, mindestens 10s]
    E3 --> E2
    E2 -->|success| D

    D --> D1[refresh token to access token]
    D1 --> D2[Token Refresh Timer setzen]
    D2 -->|bei 90 Prozent von expires_in| D3[refreshTokens]
    D3 --> D2
    D3 -->|Fehler| D4[Retry in 60s]
    D4 --> D3
  end

  %% =========================
  %% INITIAL DEVICE FETCH
  %% =========================
  D --> F[Initialer Device-Fetch nach 2s]
  F --> G[DeviceService getDevices]
  G --> G1[API: getHomeAppliances]
  G1 --> G2[Pro Device: getStatus + getSettings]
  G2 --> G3[Broadcast MMM-HomeConnect_Update ans Frontend]

  %% =========================
  %% SSE SUBSCRIPTION + HEARTBEAT
  %% =========================
  G1 --> H[SSE Subscriptions aufbauen]
  H --> H0[Pre-SSE Token Refresh optional]
  H0 --> H1[subscribe NOTIFY + STATUS + EVENT]
  H1 --> H2[SSE Heartbeat Monitor starten]

  subgraph SSE[SSE Laufzeitverhalten]
    H2 --> H3[Heartbeat Check alle 60s]
    H3 -->|keine Events fuer 3min oder laenger| H4[INIT_STATUS sse_stale]
    H3 -->|Event empfangen| H5[applyEventToDevice + broadcastDevices]
    H5 --> H6[INIT_STATUS sse_recovered falls vorher stale]

    H1 --> H7[EventSource Error]
    H7 -->|HTTP 401/403| H8[recoverFromAuthError -> refreshTokens]
    H8 -->|bei Fehler| H9[Recreate EventSources in 30s]
    H7 -->|HTTP 429| H9
    H7 -->|sonstige Fehler| H10[Recreate EventSources in 5s]
    H9 --> H1
    H10 --> H1
  end

  %% =========================
  %% FRONTEND PERIODIC/UI TRIGGERS
  %% =========================
  subgraph FE[Frontend Trigger]
    G3 --> I[Frontend empfaengt MMM-HomeConnect_Update]
    I --> I1[updateDom]
    I --> I2[scheduleActiveProgramSnapshot]
    I --> I3[recoverMissingActivePrograms]

    I2 -->|nur wenn seit letztem Request >= minActiveProgramIntervalMs| J[REQUEST_DEVICE_REFRESH mit haIds]
    I2 -->|Default minActiveProgramIntervalMs: 10min| J

    I3 -->|nur 1x pro Recovery-Zyklus je Geraet| K[REQUEST_DEVICE_REFRESH mit bypassActiveProgramThrottle=true]
    I3 -->|wenn ActiveProgramSource active oder Geraet nicht laeuft State reset| I3

    I4[UI Progress Timer] -->|alle 30s, min 5s| I1
    I5[resume] -->|sofort| L[REQUEST_DEVICE_REFRESH forceRefresh true bypassActiveProgramThrottle true]
    I5 -->|nach 1.5s| M[GET_ACTIVE_PROGRAMS force=true]
  end

  %% =========================
  %% REQUEST_DEVICE_REFRESH PATH
  %% =========================
  J --> N[Node: handleStateRefreshRequest]
  K --> N
  L --> N

  N --> N1{SSE healthy?}
  N1 -->|ja und nicht forceRefresh| N2[broadcastDevices aus Cache]
  N1 -->|nein oder forceRefresh| N3[getDevices dann HomeAppliances Status Settings]
  N2 --> O[handleGetActivePrograms mit bypassActiveProgramThrottle]
  N3 --> O

  %% =========================
  %% ACTIVE PROGRAM FETCH PATH
  %% =========================
  M --> O
  O --> O1{rateLimitUntil aktiv und force false}
  O1 -->|ja| O2[INIT_STATUS device_error 429 plus remainingSeconds]
  O1 -->|nein| O3{MIN_ACTIVE_PROGRAM_INTERVAL erfuellt?}
  O3 -->|nein und force false| O4[Throttled kein API Call]
  O3 -->|ja oder force true| O5[fetchActiveProgramsForDevices]

  subgraph PROGRAMS[Program API Calls pro Device]
    O5 --> P1{Device connected ODER appearsActive?}
    P1 -->|nein| P2[skip]
    P1 -->|ja| P3[getActiveProgram]
    P3 -->|200| P4[optional: getAvailableProgram fuer Constraints]
    P3 -->|404| P5[getSelectedProgram]
    P5 -->|wenn noetig| P6[getAvailablePrograms und getAvailableProgram]
    P3 -->|429| P7[RateLimit Error]
    P4 --> P8[applyProgramResult]
    P5 --> P8
    P6 --> P8
    P8 --> P9[zwischen Devices: 500ms Delay]
  end

  O5 --> Q[Broadcast ACTIVE_PROGRAMS_DATA und MMM-HomeConnect_Update]
  P7 --> R[handleActiveProgramFetchError]
  R --> R1[rateLimitUntil gesetzt auf now plus Backoff]
  R1 -->|Backoff zufaellig: 2, 4 oder 8 Minuten| R2[INIT_STATUS device_error 429]

  %% =========================
  %% RETRY MANAGER
  %% =========================
  O5 --> S{No active program, aber appearsActive?}
  S -->|ja| T[ActiveProgramManager.schedule]
  T -->|retryDelayMs: 5s| U[Retry getActiveProgram]
  U -->|max 3 Versuche je Geraet| U
  U -->|success| Q

  %% =========================
  %% VISUAL RATE LIMIT
  %% =========================
  R2 --> V[Frontend erkennt statusCode 429 oder isRateLimit]
  O2 --> V
  V --> W[Anzeige Banner: HTTP 429 + Meldung + Wartezeit]
```

## Diagramm 2: Sequence Diagram

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

  alt Refresh-Token vorhanden
    NH->>HC: init(refresh_token)
  else Kein Token
    NH->>HC: POST /security/oauth/device_authorization
    loop Device-Flow Polling (min 5s Intervall)
      NH->>HC: POST /security/oauth/token
      alt authorization_pending
        HC-->>NH: warten
      else slow_down
        HC-->>NH: Intervall erhoehen (+5s, min 10s)
      else success
        HC-->>NH: access_token + refresh_token
      end
    end
  end

  Note over NH,HC: Nach erfolgreicher Init
  NH->>DS: attachClient(hc)
  NH->>PS: attachClient(hc)
  NH->>DS: getDevices() (initial nach ~2s)

  DS->>HC: getHomeAppliances
  HC-->>DS: Geraete-Liste
  loop pro Geraet (wenn connected oder appearsActive)
    DS->>HC: getStatus
    DS->>HC: getSettings
  end
  DS->>DS: subscribe NOTIFY/STATUS/EVENT
  DS-->>FE: MMM-HomeConnect_Update(devices)

  Note over DS,SSE: SSE-Heartbeat
  loop alle 60s (default)
    DS->>DS: heartbeat check
    alt >=3 min keine Events
      DS-->>FE: INIT_STATUS(sse_stale)
    else Event empfangen
      SSE-->>DS: event payload
      DS->>DS: applyEventToDevice + recordSseEvent
      DS-->>FE: MMM-HomeConnect_Update(devices)
      DS-->>FE: INIT_STATUS(sse_recovered) (falls vorher stale)
    end
  end

  Note over FE: UI-Timer
  loop progressRefreshIntervalMs (default 30s, min 5s)
    FE->>FE: updateDom()
  end

  Note over FE: Bei MMM-HomeConnect_Update
  FE->>FE: recoverMissingActivePrograms()
  alt fehlende ActiveProgram-Daten und laufend
    FE->>NH: REQUEST_DEVICE_REFRESH(haIds, bypassActiveProgramThrottle=true)\n(max 1x pro Recovery-Zyklus je Geraet)
  end

  FE->>FE: scheduleActiveProgramSnapshot()
  alt seit letztem Request >= minActiveProgramIntervalMs (default 10 min)
    FE->>NH: REQUEST_DEVICE_REFRESH(haIds)
  end

  Note over NH: REQUEST_DEVICE_REFRESH verarbeitet
  NH->>NH: sseHealthy? subscribed && !heartbeatStale && hasDevices
  alt forceRefresh oder SSE ungesund
    NH->>DS: getDevices() -> HomeAppliances/Status/Settings
  else SSE gesund
    NH->>DS: broadcastDevices() aus Cache
  end
  NH->>NH: handleGetActivePrograms(force=bypassActiveProgramThrottle)

  alt rateLimitUntil aktiv und force=false
    NH-->>FE: INIT_STATUS(device_error, 429, remainingSeconds)
  else Throttle aktiv (MIN_ACTIVE_PROGRAM_INTERVAL)
    NH->>NH: kein Program-API-Call
  else ActiveProgram-Call erlaubt
    NH->>NH: fetchActiveProgramsForDevices()
    loop pro Zielgeraet (sequentiell)
      alt connected oder appearsActive
        NH->>PS: fetchActiveProgramForDevice(haId)
        PS->>HC: getActiveProgram
        alt 200 OK
          HC-->>PS: active program
          opt Constraints laden
            PS->>HC: getAvailableProgram(programKey)\n(Cache pro haId+programKey)
            HC-->>PS: program definition
          end
        else 404
          HC-->>PS: not found
          PS->>HC: getSelectedProgram
          alt selected vorhanden
            HC-->>PS: selected program
            opt Constraints laden (gecached)
              PS->>HC: getAvailableProgram(programKey)
              HC-->>PS: program definition
            end
          else fallback erlaubt (nicht fuer blockierte Typen)
            PS->>HC: getAvailablePrograms
            HC-->>PS: available list
            PS->>HC: getAvailableProgram(firstProgramKey)
            HC-->>PS: program definition
          end
        else 429
          HC-->>PS: rate limit
          PS->>PS: throw 429
        end
        Note over NH: 500ms Delay zwischen Geraeten
      else skip Geraet
        NH->>NH: no call
      end
    end

    alt Ergebnisse vorhanden
      NH->>PS: applyProgramResult()
      NH-->>FE: MMM-HomeConnect_Update
      NH-->>FE: ACTIVE_PROGRAMS_DATA
    end

    alt No active program aber appearsActive
      NH->>APM: schedule retry\nDelay 5s, max 3 Versuche
      loop Retry
        APM->>PS: fetchActiveProgramForDevice
        PS->>HC: getActiveProgram
      end
    end
  end

  alt 429 in Program-Flow
    PS->>PS: rateLimitUntil = now + backoff
    Note over PS: backoff zufaellig: 2 / 4 / 8 min
    PS-->>FE: INIT_STATUS(device_error, statusCode=429, isRateLimit=true)
    FE->>FE: Banner HTTP 429 anzeigen
  end

  Note over HC: Token-Refresh-Zyklus
  loop bei ~90% token lifetime
    HC->>HC: refreshTokens()
    alt Erfolg
      HC->>HC: recreateEventSources()
    else Fehler
      HC->>HC: Retry nach 60s
    end
  end

  Note over SSE,HC: EventSource Fehlerbehandlung
  alt 401/403
    HC->>HC: auth recovery + refreshTokens
    HC->>HC: recreate in 30s (authDelayMs)
  else 429
    HC->>HC: recreate in 30s (authDelayMs)
  else sonstige Fehler
    HC->>HC: recreate in 5s (baseDelayMs)
  end

  Note over FE: resume()
  FE->>NH: REQUEST_DEVICE_REFRESH(forceRefresh=true, bypassActiveProgramThrottle=true)
  FE->>NH: GET_ACTIVE_PROGRAMS(force=true) nach 1.5s
```
