# Changelog

## [1.4.0](https://github.com/flmesh/hubot/compare/v1.3.0...v1.4.0) (2026-04-29)


### Features

* **mqtt:** implement DM delivery error handling and rollback for account creation ([c2e5ab4](https://github.com/flmesh/hubot/commit/c2e5ab40b2ee8541964162c2f9c8514c189aa8d9))
* **mqtt:** Implement DM delivery error handling and rollback for account creation ([d0e87ab](https://github.com/flmesh/hubot/commit/d0e87ab514687b867838f3bb6c0f2c0e800c5363))

## [1.3.0](https://github.com/flmesh/hubot/compare/v1.2.0...v1.3.0) (2026-04-25)


### Features

* add authz.report.details command to query unique AUTHZ denial tuples ([760236a](https://github.com/flmesh/hubot/commit/760236a62b2567397ba305ec134392a56b4fadde))
* add initial Hubot script with basic commands and runtime info embed ([b3af188](https://github.com/flmesh/hubot/commit/b3af188bba13ac3a6ca94c66347de2df9e350f61))
* enhance embed details in authz report by adding unique pairs and topics fields ([56d8096](https://github.com/flmesh/hubot/commit/56d8096f8d69d3547e944a1fe8c55ebf5ab86642))
* implement Loki query functions and integrate them into node logs and trace scripts ([db3b202](https://github.com/flmesh/hubot/commit/db3b2028383982bde3e9027cb277930ff868236d))
* integrate Redis caching into node logs and trace scripts, and refactor table rendering ([eda357f](https://github.com/flmesh/hubot/commit/eda357ff2da790c68d10295ad96596c307dc7e12))
* **mqtt:** add mqtt.ban, mqtt.unban, and mqtt.ban.list commands ([4bd34a0](https://github.com/flmesh/hubot/commit/4bd34a0136419c2ebb359a568414147e364a94e4))
* **mqtt:** add mqtt.ban, mqtt.unban, and mqtt.ban.list commands ([f060b0b](https://github.com/flmesh/hubot/commit/f060b0ba0c99f8582e8b6fc00664bd82bbb7446b))
* **mqtt:** enrich ban list field values with emoji and reason ([e33d7b3](https://github.com/flmesh/hubot/commit/e33d7b310bee16bc8bcc7444eafd9dae08f9fed7))
* **mqtt:** improve ban list embed formatting ([9344941](https://github.com/flmesh/hubot/commit/9344941b53294c86ef0b39a9ba0439222b529cf3))
* refactor AUTHZ report scripts to utilize shared Loki query functions and constants ([b3ed834](https://github.com/flmesh/hubot/commit/b3ed834697d0ce11a77449c16af583f25b0f1037))
* refactor Loki query functions to improve modularity and reuse ([6b86d5a](https://github.com/flmesh/hubot/commit/6b86d5ac784ad59184934de51e043e141d642ac4))
* update authz.report.details to return embeds with clientid+topic pairs and refactor related tests ([f5ee0f0](https://github.com/flmesh/hubot/commit/f5ee0f0adc941b21ed3ce6d5452161b9d8155282))


### Bug Fixes

* **mqtt:** handle all until formats in ban embed rendering ([7e54008](https://github.com/flmesh/hubot/commit/7e540089cf2258b640b1cf3d4f2ed56d44552a91))
* **mqtt:** show full client ID below truncated display in ban list ([c4d22b8](https://github.com/flmesh/hubot/commit/c4d22b87609a334649cb892cb0527551e607cb41))

## [1.2.0](https://github.com/flmesh/hubot/compare/v1.1.0...v1.2.0) (2026-04-23)


### Features

* **deps:** update googleapis/release-please-action action to v5 ([944207b](https://github.com/flmesh/hubot/commit/944207b09ec2440a6ac6a70b6f2df5cfcc9777bb))
* **deps:** update googleapis/release-please-action action to v5 ([fddde5f](https://github.com/flmesh/hubot/commit/fddde5f5777b41bc054f6fac8aae53091b78ae5d))

## [1.1.0](https://github.com/flmesh/hubot/compare/v1.0.1...v1.1.0) (2026-04-21)


### Features

* **authz:** add scheduled AUTHZ denial summary reporting to Discord ([0e5e73c](https://github.com/flmesh/hubot/commit/0e5e73c3aaaed79d66a85fd081bbfa1bf9dfd1c9))


### Bug Fixes

* **authz:** update embed title for authorization denial summary ([75b5579](https://github.com/flmesh/hubot/commit/75b557981c1ebc0048cb994af2d6ead3a3b8d6cc))

## [1.0.1](https://github.com/flmesh/hubot/compare/v1.0.0...v1.0.1) (2026-04-19)


### Bug Fixes

* **node-trace:** simplify command description for clarity ([8ad963f](https://github.com/flmesh/hubot/commit/8ad963f682ad8990a655efac5e680eecd0fe2bcf))

## 1.0.0 (2026-04-07)


### Features

* Add Hubot Discord adapter project with Docker and GitHub Actions ([b54c216](https://github.com/flmesh/hubot/commit/b54c2162bb91e5c351b071b7a2e0fddbb5aec991))
* Hubot Discord adapter — Docker + GHCR publish via GitHub Actions ([2e56efa](https://github.com/flmesh/hubot/commit/2e56efadac0b3b3423f411dd6949032136877eb1))
