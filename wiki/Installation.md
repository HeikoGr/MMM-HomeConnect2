# Installation

## Requirements

- Node.js `>=22.22.2 <23` or `>=24`, the same range as MagicMirror² 2.38 (`engines` in `package.json`)
- A Home Connect account with connected appliances
- A Home Connect developer application with a client ID, see [Developer Application](Developer-Application)

## Install The Module

```bash
cd ~/MagicMirror/modules
git clone --recurse-submodules https://github.com/HeikoGr/MMM-HomeConnect2
cd MMM-HomeConnect2
npm ci --omit=dev
```

The module depends on the `lib/mmm-shared` git submodule. `npm ci` fetches it through its
`postinstall` step and stops with an error if that is not possible. A ZIP download from GitHub does
not contain the submodule; install with `git clone` instead. If the module fails to start with
`Cannot find module './lib/mmm-shared/mmm-shared'`, run:

```bash
cd ~/MagicMirror/modules/MMM-HomeConnect2
git submodule update --init --recursive
```

Continue with [Quick Start](Quick-Start) after installation.
