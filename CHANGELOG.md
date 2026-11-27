# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]
### Added
- Opt-in CMCD v2 (CTA-5004-B) Request Mode with `CmcdConfig.version: 2`. Sends `v=2`, inner lists with object type parameters, `pr` in `CMCD-Status`, `cid` of up to 128 characters, and the new keys `sta`, `sn`, `msd`, `pt`, `bsa`, `bsd`, `bsda`, `ec`, `lb`, `tbl`, `pb`, `dfa` and `ltc`. Without `version`, or with `version: 1`, the output is unchanged.
- Opt-in CMCD v2 Event Mode with `CmcdConfig.eventTargets`. Sends `application/cmcd` POST reports per target for the events `ps`, `e`, `t`, `rr`, `c`, `h`, `m`, `um`, `bc`, `abs`, `abe`, `as`, `ae`, `sk` and `ce`, with per-target event and key filters, batching, `Authorization` header, custom keys, URL filter for the `url` key, retry with backoff (respecting `Retry-After`), a request timeout, and `keepalive` for the reports sent when the page or the player ends. Request Mode output is unchanged.
- `CmcdIntegration.sendCustomEvent(name, customKeys?)` to report a custom event (`e=ce`).
- `CmcdIntegration.destroy()` to send pending Event Mode reports and remove all listeners and timers. With Event Mode, it is also called on the player `Destroy` event.

### Deprecated
- `CustomKey.keyValuePairToString`. Encoding is done for all keys of a request at once.

### Fixed
- Encoded bitrate (`br`), object duration (`d`) and top bitrate (`tb`) were not rounded and could be sent as non-integers, e.g. `d=4003.9999999999995`. They are now rounded to integers.
- Content id (`cid`) and session id (`sid`) longer than 64 characters were sent. They are now omitted (with a console warning, once per value) instead of violating the maximum length of CMCD v1.
- Buffer starvation (`bs`) could be encoded as `bs=false`. It is now omitted if `false`.
- `preprocessHttpResponse` threw if the player passed no response (e.g. after a network error), which could prevent the request from being retried. A missing response is now passed on unchanged.
- `preprocessHttpRequest` could throw for values that cannot be encoded, e.g. a lone surrogate in a content id in query mode. The request is now sent without CMCD data and a console warning is logged.
- In HTTP header mode, string values and custom key names that are not printable ASCII (e.g. line breaks or `é`) were sent in the CMCD headers. Such keys are now omitted with a console warning.
- `preprocessHttpRequest` threw if no player was set or a player API threw while collecting the data. The request is now sent without CMCD data and a console warning is logged once.
- Calling `setPlayer` again registered all player event listeners a second time. The listeners of the previous player are now removed.

## [0.6.1] - 2026-11-20
### Fixed
- Measured throughput (`mtp`) was reported in kilobytes per second instead of kilobits per second, making the value 8x too low (and frequently rounding down to 0, so the key was omitted entirely). Throughput is now converted from bytes to bits before scaling to kbps.
- Next object request (`nor`) contained the absolute URL of the next segment. It is now the path relative to the current request, URL encoded as required by the specification. `nor` is omitted if the next segment is on a different origin.
- Measured throughput (`mtp`) was sent as `mtp=0` for throughputs below 50 kbps. The key is now omitted in this case.
- Requested maximum throughput (`rtp`) was never sent. It is now sent for media segment requests outside of startup and buffer starvation, with 5 times the encoded bitrate (`br`), rounded to the nearest 100 kbps.
- Startup (`su`) was sent on all requests until the first seek or stall. It is now cleared when playback starts.
- Audio segment requests used the video segments to determine `nor` and object duration (`d`).
- Object duration (`d`) was sent as `NaN` if the segment duration is unknown.
- Streaming format (`sf`) was determined by the first request of any type, so e.g. an ads manifest or DRM request made `sf=o` stick for the whole session. It is now derived from the DASH, HLS master or Smooth manifest request (a new main manifest replaces the format of the previous source) and omitted while unknown. HLS variant playlists are recognized as HLS if no format is known yet.
- Playback rate (`pr`) was sent as the playback speed while paused or before the first play. It is now `0` if the player is not playing, as required by the specification.
- State of a previous source (streaming format, startup, buffer starvation, encoded bitrate and measured throughput) was reused after loading another source into the same player. It is now reset on `SourceUnloaded`.
- package.json description referred to the wrong product.

## [0.6.0] - 2026-07-29
### Changed
- The published npm package now only ships `dist/js` plus the top-level docs (`README.md`, `CHANGELOG.md`, `LICENSE`) and required package metadata (e.g. `package.json`). Local development files are no longer part of the tarball.

### Fixed
- Query parameters already present on a request URL were re-encoded when `useQueryArgs` is enabled. Only the appended `CMCD` parameter is URL encoded now.

## [0.5.0] - 2026-01-14
### Added
- Option to set the CMCD header type per `CustomKey` to one of the predefined HTTP headers. This is required now for CustomKey's if `useQueryArgs` is set to `false` (HTTP Header mode is used).

## [0.4.0] - 2025-12-01
### Changed
- Dependency versions

### Fixed
- Custom keys were not sorted alphabetically using the prefix due to an initial ambiguity in the specification

## [0.3.0] - 2025-03-26
### Added
- Description in package.json for the project

## [0.2.1] - 2024-12-10
### Fixed
- DASH loading failure when SegmentTimeline with $number format is used (#6)
- Duplicate CMCD query parameters for Live manifest (#5)
- Add `main` property to package.json to enable usage in Jest tests

## [0.2.0] - 2023-10-13
### Added
- Support for adding Custom Keys statically in the configuration

## 0.1.0 - 2023-05-05
### Added
- Initial CMCD release (Beta)

[Unreleased]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.1.0...v0.2.0
