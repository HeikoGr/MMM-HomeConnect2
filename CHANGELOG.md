# Changelog

## [1.3.2](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.3.1...v1.3.2) (2026-08-19)


### 🐛 Fixes

* **device:** prevent stale progress display when appliance is idle ([bfd387f](https://github.com/HeikoGr/MMM-HomeConnect2/commit/bfd387fce39424eb1bfd853f0f10b43703751578))

## [1.3.1](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.3.0...v1.3.1) (2026-08-19)


### 🐛 Fixes

* **active-program-manager:** close double-retry race window ([83df932](https://github.com/HeikoGr/MMM-HomeConnect2/commit/83df93216550e8cf61c2d32d5e4a924da2e17b87))
* **auth-service:** apply request timeout to OAuth device-flow fetches ([527ab24](https://github.com/HeikoGr/MMM-HomeConnect2/commit/527ab246462bc688922691e1adf94cb7bb3d391f))
* **config:** declare sseRecoveryCooldownMs in module defaults ([8b804f7](https://github.com/HeikoGr/MMM-HomeConnect2/commit/8b804f71203733715e6a52ef7f5e6780da849d7c))
* **css:** scope progress selectors under .MMM-HomeConnect2 ([6e74d0e](https://github.com/HeikoGr/MMM-HomeConnect2/commit/6e74d0ee527dd4a5bd1b5d894db98faae15bd852))
* **device-service:** apply fetched status/settings to the live device ([0927e50](https://github.com/HeikoGr/MMM-HomeConnect2/commit/0927e50f77b295dea22aeef5d85918bdc72786c5))
* **device:** handle stale progress reporting after program completion ([c6d58fc](https://github.com/HeikoGr/MMM-HomeConnect2/commit/c6d58fcc7704217a36694d662a6f0a7f9c1cd613))
* **homeconnect-api:** clear token-refresh timer when a client is replaced ([56e2d46](https://github.com/HeikoGr/MMM-HomeConnect2/commit/56e2d46500c05b6b550a3aefc7ba953e8b066d05))
* **node_helper:** guard refresh-token file I/O against process crashes ([b3f9b54](https://github.com/HeikoGr/MMM-HomeConnect2/commit/b3f9b5450f11fd5d1d0c7a02a2a822ecd89d6d73))
* **node_helper:** prune stale client instances from globalSession ([ac5b6e1](https://github.com/HeikoGr/MMM-HomeConnect2/commit/ac5b6e1bd9fed59e27e116b74ad8fd35f1b51ef5))
* **node_helper:** restrict refresh_token.json to owner-only permissions ([099012c](https://github.com/HeikoGr/MMM-HomeConnect2/commit/099012cd2533cc6051aae883c363c9a4e8e89d0d))
* **node_helper:** retry active-program requests dropped by overlap ([c7a1a4a](https://github.com/HeikoGr/MMM-HomeConnect2/commit/c7a1a4a376e9844660aa0cd355965d4ad839d2a0))
* **node_helper:** track and clear pending re-auth retry timers in stop() ([36ab753](https://github.com/HeikoGr/MMM-HomeConnect2/commit/36ab75310a26e726b08d076a45fa55bbbe4f201b))


### 🧱 Refactoring

* consolidate duplicated 429/rate-limit detection logic ([c352c90](https://github.com/HeikoGr/MMM-HomeConnect2/commit/c352c90072f20564758161d757f6d24adb5ff114))
* **homeconnect-api:** consolidate duplicated REST error normalization ([a510f7f](https://github.com/HeikoGr/MMM-HomeConnect2/commit/a510f7fb9251f33734a9991742507d48d71098ab))
* remove unused unsubscribe/setEventSourceRetryConfig/applyProgramResult ([9e9e2e9](https://github.com/HeikoGr/MMM-HomeConnect2/commit/9e9e2e96901d586afa4726a0519e5cdad18ba339))


### 📚 Documentation

* fix stale .env.template header and misleading CI comment ([d9a58fa](https://github.com/HeikoGr/MMM-HomeConnect2/commit/d9a58fa7317ee768f73707449680ea6ec262d892))
* **wiki:** document header, showDeviceIfDoorIsOpen, showDeviceIfFailure ([2ab18e5](https://github.com/HeikoGr/MMM-HomeConnect2/commit/2ab18e5f7ea5132ea3976c8427fba2ff10b58567))

## [1.3.0](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.2.0...v1.3.0) (2026-08-18)


### 🔌 Features

* **device:** handle active program detection from SSE events ([359ef42](https://github.com/HeikoGr/MMM-HomeConnect2/commit/359ef427e670e8a3c4428f29789d25ad0c449a21))

## [1.2.0](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.1.0...v1.2.0) (2026-08-18)


### 🔌 Features

* **device:** enhance device operation state handling in tests ([a042bb6](https://github.com/HeikoGr/MMM-HomeConnect2/commit/a042bb6ea61a706e0f8da239a532d6e912b21bd0))

## [1.1.0](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.0.17...v1.1.0) (2026-08-17)


### 🔌 Features

* **deps:** add support for git submodule updates in Dependabot ([2e1b3b0](https://github.com/HeikoGr/MMM-HomeConnect2/commit/2e1b3b0ff5597c71bcabe8060bc8573197b4fab6))
* **devcontainer:** add postStart.sh for managing host credentials and SSH keys ([415e4cf](https://github.com/HeikoGr/MMM-HomeConnect2/commit/415e4cfce2d0530d61a1917e62470a48d400668c))

## [1.0.17](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.0.16...v1.0.17) (2026-08-16)


### 🧱 Refactoring

* remove spelling test and related dependencies ([8c1fbf8](https://github.com/HeikoGr/MMM-HomeConnect2/commit/8c1fbf835576d17f15cb54bd1a5d02ca73d926ae))

## [1.0.16](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.0.15...v1.0.16) (2026-08-15)


### 🔧 Tooling

* update Node.js version to 22.22.2 in CI workflow ([7ed44a8](https://github.com/HeikoGr/MMM-HomeConnect2/commit/7ed44a867b64db0f1fe8c89c481153c68cdeb517))

## Changelog

All notable changes to this project will be documented in this file.
