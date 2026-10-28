# Changelog

## [0.4.0](https://github.com/planetaryescape/duff/compare/v0.3.0...v0.4.0) (2026-10-28)


### Features

* **dashboard:** filter pull requests by author ([493b812](https://github.com/planetaryescape/duff/commit/493b812b53d8518c4edc77fcd60502597b48d7a3))


### Bug Fixes

* **azure:** compare pinned PR revisions after target advancement ([c25fc7a](https://github.com/planetaryescape/duff/commit/c25fc7a2ffe7f47f5215293c24743587498caccb))
* **azure:** recover managed review acquisition over SSH ([c10ba8b](https://github.com/planetaryescape/duff/commit/c10ba8bb99dd1ffc79b1f794ff2e23c30a89e65a))
* **azure:** restore PR review acquisition and statistics ([5c92b09](https://github.com/planetaryescape/duff/commit/5c92b0970eaad4cb2c513bfe9b7c6bb5b888a51d))

## [0.3.0](https://github.com/planetaryescape/duff/compare/v0.2.1...v0.3.0) (2026-10-26)


### Features

* **dashboard:** cache lazy PR statistics and refresh on focus ([46537f2](https://github.com/planetaryescape/duff/commit/46537f295c6f229776daa72161a618dbdc1b56ce))
* **dashboard:** cache lazy PR statistics and refresh on focus ([845d23b](https://github.com/planetaryescape/duff/commit/845d23b3b1e9e5174a80d9bfc93fcaee79fdaaf0))
* **dashboard:** open cross-repository reviews in isolated windows ([#20](https://github.com/planetaryescape/duff/issues/20)) ([48f0ec2](https://github.com/planetaryescape/duff/commit/48f0ec23708ad547303b9c51a51e008b5c5901c8))
* **dashboard:** persist custom repository labels ([9fabe5a](https://github.com/planetaryescape/duff/commit/9fabe5af8cd657b9ec957ade79b617b8d317dbc9))
* **dashboard:** persist repository order and view preferences ([107d8d6](https://github.com/planetaryescape/duff/commit/107d8d60e5f9b9d7881451956f6732a449396163))
* **dashboard:** rename watched repositories ([12fa0e0](https://github.com/planetaryescape/duff/commit/12fa0e0b17c1c8e4e3be793d37be319b4faaeaf5))
* **dashboard:** render safe Markdown in PR descriptions ([b3fa833](https://github.com/planetaryescape/duff/commit/b3fa833d766f22051a49f119f36d3a4dd2f348d7))
* **dashboard:** reorder repositories and restore dashboard sessions ([065dac3](https://github.com/planetaryescape/duff/commit/065dac3dde6b4e05a41491f18fe0eb48facc21f7))
* **dashboard:** resize and remember column widths ([061e3af](https://github.com/planetaryescape/duff/commit/061e3af4f688b94dd94597e2fb086ccb4e56bebd))
* **dashboard:** show PR details and preserve column scrolling ([f268249](https://github.com/planetaryescape/duff/commit/f268249799cb40e4e1fda6be7251231ecdf96681))
* **github:** prefer environment and CLI credentials ([#17](https://github.com/planetaryescape/duff/issues/17)) ([256e165](https://github.com/planetaryescape/duff/commit/256e165af19845f068dfb29876ffdbebd98662ab))
* **review:** browse past PRs in a review-first sidebar ([900c915](https://github.com/planetaryescape/duff/commit/900c915542f66ee1429c90b4f188269d77fee1fe))
* **review:** discuss immutable PR diffs with durable drafts ([388de9c](https://github.com/planetaryescape/duff/commit/388de9c1a0953fad920bfd772bcb25b4e8b7fdc8))
* **review:** inline PR discussion with durable drafts ([63d2ecd](https://github.com/planetaryescape/duff/commit/63d2ecdb1c923b77313f01794708043b557538e1))
* **telemetry:** let the installed extension opt in to local export ([b82fab4](https://github.com/planetaryescape/duff/commit/b82fab43be7810148ed3e5c957dec9462d905bc8))
* **telemetry:** route development traces and logs locally ([cc25f96](https://github.com/planetaryescape/duff/commit/cc25f96a4c98e51ce9846b21bc82711fa389fa38))


### Bug Fixes

* **azure:** preserve cached cursors across PR filters ([eca34db](https://github.com/planetaryescape/duff/commit/eca34db4a7069e395488358f377e00d3de44d397))
* **dashboard:** explain provider redirects and end failed loading ([91bdc45](https://github.com/planetaryescape/duff/commit/91bdc4567e49590e5f674b410cea4728575c5521))
* **dashboard:** recover moved GitHub repositories automatically ([6331a74](https://github.com/planetaryescape/duff/commit/6331a74e11d4f1a2d89f5dd535e7353cb16f43d7))

## [0.2.1](https://github.com/planetaryescape/duff/compare/v0.2.0...v0.2.1) (2026-10-24)


### Bug Fixes

* **github:** explain anonymous repository failures ([#15](https://github.com/planetaryescape/duff/issues/15)) ([84268ec](https://github.com/planetaryescape/duff/commit/84268ec428c096ff63b3eac0f1aa3a12c38cc48b))

## [0.2.0](https://github.com/planetaryescape/duff/compare/v0.1.0...v0.2.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* **git:** editors older than 1.123 are no longer supported.

### Features

* **review:** persist independent PR review sessions ([e78782f](https://github.com/planetaryescape/duff/commit/e78782fd84518175337235f2c9abfa2ef6cc6bd3))
* **review:** search PRs, bulk mark folders, and navigate TypeScript diffs ([#8](https://github.com/planetaryescape/duff/issues/8)) ([eba4cc8](https://github.com/planetaryescape/duff/commit/eba4cc8d9f93f54ab82c902d8b6d8ab7154efb7d))


### Code Refactoring

* **git:** replace custom process runners with effected ([d742929](https://github.com/planetaryescape/duff/commit/d74292970b4e33e0762c593621057897f2bda806))

## [0.1.0](https://github.com/planetaryescape/duff/compare/v0.0.1...v0.1.0) (2026-10-23)


### Features

* add release automation and latest-release installer ([#7](https://github.com/planetaryescape/duff/issues/7)) ([edc9a48](https://github.com/planetaryescape/duff/commit/edc9a48a5caa8461ec0bc5109e3a6183e041c214))


### Bug Fixes

* **release:** use the repository workflow token ([#10](https://github.com/planetaryescape/duff/issues/10)) ([a67bc4f](https://github.com/planetaryescape/duff/commit/a67bc4f36d7eafdbdd12f5607fcadce374deeb56))
