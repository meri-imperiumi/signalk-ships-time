# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial plugin: publishes the vessel's timezone via
  `environment.time.timezoneOffset` (and `environment.time.timezoneRegion`
  when known) so clocks aboard show ship's local time. UTC time itself
  remains the domain of `navigation.datetime` / GNSS.
- Manual mode: crew-configured UTC offset with optional IANA region.
- Automatic mode: IANA timezone derived from vessel position via
  tz-lookup, offset computed with DST, republished on change. Lookups
  and position updates requested from the server are throttled to once
  per 10 minutes by default (configurable).
