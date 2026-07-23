# MMM-HomeConnect2

MagicMirror module for Home Connect appliances using the OAuth2 device flow.

## Screenshot

![MMM-HomeConnect2](img/screenshot.png)

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/HeikoGr/MMM-HomeConnect2
cd MMM-HomeConnect2
npm ci --omit=dev
```

## Update

```bash
cd ~/MagicMirror/modules/MMM-HomeConnect2
git pull
npm ci --omit=dev
```

## Configuration

```js
{
    module: "MMM-HomeConnect2",
    position: "top_left",
    config: {
        clientId: "YOUR_CLIENT_ID",
        apiLanguage: "en",
        showDeviceIcon: true,
        showDeviceIfInfoIsAvailable: true,
    },
},
```

Authentication QR example:

![Device flow authentication](img/pic01_auth.png)

## Documentation

User-facing documentation now lives in the project wiki:

- [Wiki Home](https://github.com/HeikoGr/MMM-HomeConnect2/wiki)
- [Installation](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Installation)
- [Update](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Update)
- [Quick Start](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Quick-Start)
- [Configuration](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Configuration)
- [Authentication](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Authentication)
- [Troubleshooting](https://github.com/HeikoGr/MMM-HomeConnect2/wiki/Troubleshooting)

Technical and development documentation remains in `docs/`:

- [docs/README.md](docs/README.md)
- [docs/api-call-and-event-flow-diagrams.md](docs/api-call-and-event-flow-diagrams.md)
- [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md)