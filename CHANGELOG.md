# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]
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

[Unreleased]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bitmovin/bitmovin-player-web-integration-cmcd/compare/v0.1.0...v0.2.0
