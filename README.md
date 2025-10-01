# MMM-HomeConnect (Headless Device Flow Version)

Diese erweiterte Version des MMM-HomeConnect Moduls unterstützt die **headless Device Flow Authentifizierung** für Server/Client-getrennte MagicMirror Installationen. Keine Browser-Interaktion auf dem MagicMirror-Server erforderlich!

## ✨ Neue Features

- 🔐 **Headless Device Flow Authentifizierung** - funktioniert ohne lokalen Browser
- 📱 **In-Mirror Authentication UI** - Anzeige der Auth-URL und Code direkt im MagicMirror
- ⏱️ **Live Status Updates** - Echtzeit-Fortschritt mit Progress Bar
- 🔄 **Intelligentes Token Management** - automatische Wiederverwendung gespeicherter Tokens
- 🛡️ **Robustes Rate Limiting** - respektiert API-Limits und passt sich automatisch an
- 📊 **Detaillierte Logging** - ausführliche Konsolen-Ausgaben für Debugging

## Problem mit dem Original

Das ursprüngliche MMM-HomeConnect Modul verwendet den OAuth2 Authorization Code Flow, der:

1. Einen lokalen Express-Server startet (Port 3000)
2. Einen Browser auf dem Server öffnet
3. Benutzer-Interaktion am Server erfordert

**❌ Problem:** Bei Server/Client-getrennten Installationen (z.B. headless Raspberry Pi) kann kein Browser geöffnet werden.

## Lösung: OAuth2 Device Flow

Diese Version implementiert den **OAuth2 Device Flow** (RFC 8628), der:

1. ✅ **Headless-kompatibel** ist (kein lokaler Browser erforderlich)
2. ✅ **Benutzer kann sich von jedem Gerät** authentifizieren
3. ✅ **Funktioniert mit Server/Client-getrennten** Installationen
4. ✅ **Verwendet offizielle Home Connect API-Endpunkte**

## Installation

```bash
# Original Repository klonen
git clone https://github.com/djerik/MMM-HomeConnect
cd MMM-HomeConnect
npm install

# Diese modifizierten Dateien verwenden
# node_helper-final-fixed.js → node_helper.js
# MMM-HomeConnect-final.js → MMM-HomeConnect.js
```

## Konfiguration

### Grundkonfiguration:

```javascript
{
    module: "MMM-HomeConnect",
    position: "top_left",
    config: {
        client_ID: "IHR_DEVELOPER_CLIENT_ID",
        client_Secret: "IHR_DEVELOPER_CLIENT_SECRET",
        use_headless_auth: true, // 🆕 Headless Device Flow aktivieren
        showDeviceIcon: true,
        updateFrequency: 1000*60*60 // 1 Stunde
    }
}
```

### Konfigurationsoptionen:

| Parameter | Standard | Beschreibung |
|-----------|----------|--------------|
| `client_ID` | `""` | **Erforderlich** - Client ID aus dem Developer Portal |
| `client_Secret` | `""` | **Erforderlich** - Client Secret aus dem Developer Portal |
| `use_headless_auth` | `false` | **🆕 NEU** - Aktiviert headless Device Flow Authentifizierung |
| `showDeviceIcon` | `true` | Zeigt Geräte-Icons an |
| `showAlwaysAllDevices` | `false` | Zeigt alle Geräte, auch wenn ausgeschaltet |
| `updateFrequency` | `3600000` | Update-Intervall in Millisekunden |

## Authentifizierungsablauf

### Beim ersten Start (kein Token vorhanden):

1. **Device Flow wird gestartet** - MagicMirror zeigt Auth-Screen an
2. **Benutzer öffnet URL** auf einem beliebigen Gerät mit Browser
3. **Code eingeben** - Benutzer gibt den angezeigten Code ein
4. **Automatische Vervollständigung** - Token wird gespeichert und verwendet

**Im MagicMirror wird angezeigt:**

```
🔐 Home Connect Authentifizierung

📱 Schritt 1: Öffnen Sie diese URL in einem Browser:
https://api.home-connect.com/security/oauth/authorize

🔑 Schritt 2: Geben Sie diesen Code ein:
XYZ-ABC

⏱️ Code läuft ab in: 5 Minuten
```

### Bei späteren Starts (Token vorhanden):

1. **✅ Direkter Start** - Gespeicherter Refresh Token wird verwendet
2. **✅ Keine erneute Authentifizierung** erforderlich
3. **✅ Automatisches Token-Refresh** bei Ablauf

## Voraussetzungen

### Home Connect Developer Account:

1. **Registrierung** bei [Home Connect Developer Portal](https://developer.home-connect.com/)
2. **Neue Anwendung erstellen** mit Authorization Code Grant Flow
3. **Redirect URI setzen:** `http://localhost:3000/o2c`
4. **Client ID und Client Secret** notieren

### Home Connect Benutzerkonto:

1. **Aktives Home Connect Konto** mit E-Mail und Passwort
2. **Angemeldete Hausgeräte** (Waschmaschine, Geschirrspüler, etc.)

## Troubleshooting

### Häufige Probleme:

**1. "polling too quickly" Fehler:**
```
❌ Headless authentication failed: Token request failed: The client is polling too quickly
```

**Lösung:**
- Warten Sie 1-2 Minuten
- Starten Sie MagicMirror neu
- Das System passt das Polling-Intervall automatisch an

**2. Doppelte Authentifizierungsaufforderungen:**
```
⚠️ Config already processed, ignoring duplicate
```
✅ **Behoben** - Config wird nur einmal verarbeitet

**3. "Device code expired":**
- Der Code ist 5 Minuten gültig
- Starten Sie MagicMirror neu für einen neuen Code

**4. "User denied authorization":**
- Benutzer hat die Berechtigung verweigert
- Starten Sie MagicMirror neu und versuchen Sie es erneut

### Debug-Informationen:

**Konsolen-Logs prüfen:**
```bash
# Wenn MagicMirror mit pm2 läuft:
pm2 logs mm

# Wenn MagicMirror direkt läuft:
# Logs erscheinen im Terminal
```

**Token-Status prüfen:**
```bash
ls -la modules/MMM-HomeConnect/refresh_token.json
cat modules/MMM-HomeConnect/refresh_token.json
```

## Technische Details

### Verwendete API-Endpunkte:

1. **Device Authorization:** `POST https://api.home-connect.com/security/oauth/device_authorization`
2. **Token Exchange:** `POST https://api.home-connect.com/security/oauth/token`
3. **API Calls:** `GET https://api.home-connect.com/api/homeappliances`

### Rate Limiting:

- **Minimum Polling-Intervall:** 5 Sekunden
- **Adaptives Intervall:** Erhöht sich bei `slow_down` Errors
- **Maximum Versuche:** Basierend auf Code-Ablaufzeit
- **Token Refresh:** Max. 100 pro Tag, 10 pro Minute

### Sicherheit:

- **Client Secret** wird nur server-seitig verwendet
- **Refresh Token** wird lokal in `refresh_token.json` gespeichert
- **Access Token** läuft alle 24 Stunden ab
- **Device Codes** laufen nach 5 Minuten ab

## Unterschiede zum Original

| Aspekt | Original | Diese Version |
|--------|----------|---------------|
| **Authentifizierung** | Authorization Code Flow | Device Flow |
| **Browser-Abhängigkeit** | ❌ Lokaler Browser erforderlich | ✅ Browser auf beliebigem Gerät |
| **Server-Setup** | ❌ Express-Server auf Port 3000 | ✅ Keine lokalen Server |
| **UI-Integration** | ❌ Nur Konsole | ✅ In-Mirror Auth-Screen |
| **Headless-Support** | ❌ Nicht möglich | ✅ Vollständig unterstützt |
| **Rate Limiting** | ❌ Nicht implementiert | ✅ Intelligente Anpassung |
| **Token Management** | ✅ Refresh Token | ✅ Verbesserte Validierung |
| **Error Handling** | ❌ Basis | ✅ Ausführlich mit UI-Feedback |

## Status-Anzeigen

### 🔐 Auth Screen (Authentifizierung erforderlich)
- Zeigt URL und Code für die Anmeldung
- Countdown bis Code-Ablauf
- Direktlink für einfache Nutzung

### ⏳ Polling Screen (Warten auf Benutzer)
- Progress Bar mit Fortschritt
- Live-Update der Versuche
- Aktuelles Polling-Intervall

### ❌ Error Screen (Fehler aufgetreten)
- Beschreibung des Fehlers
- Lösungsvorschläge
- Neustart-Anweisungen

### 📱 Device Screen (Normal betrieb)
- Liste der verbundenen Geräte
- Status und Programme
- Verbleibende Zeiten

## Changelog

### Version 2.0 (2025-09-27)

**🆕 Neue Features:**
- OAuth2 Device Flow Implementierung
- In-Mirror Authentication UI
- Live Status Updates mit Progress Bar
- Intelligentes Rate Limiting
- Robuste Token-Validierung
- Erweiterte Fehlerbehandlung

**🔧 Fixes:**
- Doppelte CONFIG-Nachrichten behoben
- Scope-Parameter entfernt (automatisch vom Server gesetzt)
- Verbesserte Refresh Token Erkennung
- Stabileres Polling mit adaptiven Intervallen

**⚡ Verbesserungen:**
- Detaillierte Konsolen-Logs
- Benutzerfreundliche UI-Anzeigen
- Professionelle Fehlermeldungen
- Automatische Fallback-Mechanismen

## Lizenz

MIT License

## Support

**Bei Problemen:**

1. **Logs prüfen** (`pm2 logs mm` oder Terminal-Ausgabe)
2. **Token-Datei prüfen** (`modules/MMM-HomeConnect/refresh_token.json`)
3. **MagicMirror neu starten** bei Fehlern
4. **Developer Portal** - Client ID/Secret überprüfen

**Diese Version ist nicht offiziell unterstützt** von BSH oder dem ursprünglichen Modulentwickler, sondern eine Community-Erweiterung.