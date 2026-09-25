# Changelog

## [1.5.4](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.5.3...v1.5.4) (2026-09-25)


### 🐛 Fixes

* honour a rate-limit block during session start and for forced program fetches ([#69](https://github.com/HeikoGr/MMM-HomeConnect2/issues/69)) ([394284d](https://github.com/HeikoGr/MMM-HomeConnect2/commit/394284dc6ac8dfe226e707a3551765d0291e8b70))
* keep an API rate-limit block across restarts and answer every INIT_REQUIRED ([a0d6f49](https://github.com/HeikoGr/MMM-HomeConnect2/commit/a0d6f4995e0742e17d5029cb84735782d5e8469e))
* update screenshot link to use absolute URL ([32156d9](https://github.com/HeikoGr/MMM-HomeConnect2/commit/32156d98df95f1d4dcc8567a05bae74a22a0ffd6))


### 🧱 Refactoring

* **api:** remove the unused single available-program call ([e555010](https://github.com/HeikoGr/MMM-HomeConnect2/commit/e5550102f6d61191b4cfa85abb2f21c6e542c7bf))
* update mmm-shared to c310517 ([b53653d](https://github.com/HeikoGr/MMM-HomeConnect2/commit/b53653d1aefef2f800b6738e63eb81b3d14ac9ac))


### 📚 Documentation

* refresh the screenshot and add one of the appliance states ([6c62f7e](https://github.com/HeikoGr/MMM-HomeConnect2/commit/6c62f7e9d668f1a560f893d898e80ed6538ee1b9))


### 🧪 Testing

* run every tests/*.test.js instead of a hand-kept list ([ffa0ac6](https://github.com/HeikoGr/MMM-HomeConnect2/commit/ffa0ac62706054161ad9f6b27edd3b631baa766e))


### 📦 Build & Dependencies

* **deps:** require MagicMirror's node version ([8a48c6c](https://github.com/HeikoGr/MMM-HomeConnect2/commit/8a48c6cf0e0fc062c5c384f41553f85bd76d6e0b))


### 🔧 Tooling

* describe the pinned node version correctly ([0c2a487](https://github.com/HeikoGr/MMM-HomeConnect2/commit/0c2a487deb6a272a81d8e9962e9be50058b9fb1e))
* develop branch model and PR title check ([0946cc2](https://github.com/HeikoGr/MMM-HomeConnect2/commit/0946cc213e944c99cf489ee39eea57cdabd5c6d8))
* open the release PR to the default branch automatically, use RELEASE_TOKEN ([#70](https://github.com/HeikoGr/MMM-HomeConnect2/issues/70)) ([6cc6e5a](https://github.com/HeikoGr/MMM-HomeConnect2/commit/6cc6e5a2b1f8deef599583cf109bb9c2e90ade6c))
* prepare releases on develop, ship them with one merge to the default branch ([#67](https://github.com/HeikoGr/MMM-HomeConnect2/issues/67)) ([e698d42](https://github.com/HeikoGr/MMM-HomeConnect2/commit/e698d420eb896bc8455541a8962b0c996888a88f))

## [1.5.3](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.5.2...v1.5.3) (2026-09-24)


### 🐛 Fixes

* session language, API call reduction, and code review fixes ([#63](https://github.com/HeikoGr/MMM-HomeConnect2/issues/63)) ([c20e5ee](https://github.com/HeikoGr/MMM-HomeConnect2/commit/c20e5ee0805ea93495e42b8abec319d2623625da))

## [1.5.2](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.5.1...v1.5.2) (2026-09-24)


### 🔧 Tooling

* assign release-please's PR to HeikoGr ([6eabd79](https://github.com/HeikoGr/MMM-HomeConnect2/commit/6eabd798bc9dc96bf0f7e844abc1f97de3cbf2c5))

## [1.5.1](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.5.0...v1.5.1) (2026-09-24)


### 🐛 Fixes

* do not spend rate-limited quota on the SSE watchdog resync or lift an API 429 early ([e263ed7](https://github.com/HeikoGr/MMM-HomeConnect2/commit/e263ed752c08ce9e5712f570fbe68473780f3dcd))

## [1.5.0](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.4.2...v1.5.0) (2026-09-23)


### 🔌 Features

* split the helper, track displays by socket, log through MagicMirror's Log ([4c57988](https://github.com/HeikoGr/MMM-HomeConnect2/commit/4c57988e112c81cce42f1ff326e9fc31147d4454))


### 🧱 Refactoring

* load backend-session.js from the mmm-shared submodule (S5) ([75353a1](https://github.com/HeikoGr/MMM-HomeConnect2/commit/75353a12260f5a2c11f8ce9aca988a5c7cc2a17e))

## [1.4.2](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.4.1...v1.4.2) (2026-09-22)


### 🐛 Fixes

* render the module DOM without innerHTML and surface init failures ([387bca8](https://github.com/HeikoGr/MMM-HomeConnect2/commit/387bca81e2b50db66c249586c41c3e13dbfc3273))

## [1.4.1](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.4.0...v1.4.1) (2026-09-19)


### 🐛 Fixes

* **device:** back off on per-appliance 429s and stop the snapshot burst ([967adcf](https://github.com/HeikoGr/MMM-HomeConnect2/commit/967adcfb2a0fa8c8b9da7fcda7e0000c758ddccd))

## [1.4.0](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.3.3...v1.4.0) (2026-08-20)


### 🔌 Features

* **api:** implement exponential backoff for token refresh and SSE retries ([2530255](https://github.com/HeikoGr/MMM-HomeConnect2/commit/25302552b49d3a509d22f258b89986df8f62c921))


### 🐛 Fixes

* **device:** seed PowerState from /settings for every appliance type ([50f295d](https://github.com/HeikoGr/MMM-HomeConnect2/commit/50f295db4cb4c529304652616085dc0c0d7b1eff))

## [1.3.3](https://github.com/HeikoGr/MMM-HomeConnect2/compare/v1.3.2...v1.3.3) (2026-08-19)


### ⚡ Performance

* **debug:** trim debug stats to timestamps and counters ([5bf421d](https://github.com/HeikoGr/MMM-HomeConnect2/commit/5bf421d1ac53c58d1f8dd0a8bdbb2ac3836cd5fe))


### 🧱 Refactoring

* **config:** drop session-config echo and drift protocol ([8db8530](https://github.com/HeikoGr/MMM-HomeConnect2/commit/8db8530bb60f37ec031bec1ca6bae1888f947e89))
* **device:** store each observable under one key instead of two ([0364a03](https://github.com/HeikoGr/MMM-HomeConnect2/commit/0364a031cb6850b35e3c71a0b089c1a2b0ad8fde))
* **node_helper:** replace session state machine with lifecycle flags ([deddbb4](https://github.com/HeikoGr/MMM-HomeConnect2/commit/deddbb47718c254995f8b2edfd8603e97daa98ef))
* **node_helper:** unify active-program fetch admission control ([5204432](https://github.com/HeikoGr/MMM-HomeConnect2/commit/5204432b0703fd5b530d17a94a3f3d8497bf1dca))

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
