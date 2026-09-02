# Changelog

All notable changes to this project will be documented here.

## [0.4.0] - 2026-09-02

### Added

- Explicit transcription adapters with one normalized result for whisper.cpp, Music Whisper, and future custom protocols.
- Trusted-local Music Whisper JSON `/transcribe` support with strict caller paths, response normalization, deterministic text-file fallback, bounded errors, cancellation, and timeouts.
- Music Whisper service definitions and adapter-aware external health checks that never lifecycle-manage external processes.

### Changed

- `LocalAIManager.transcribe()` now returns a normalized transcription result while the standalone `WhisperClient` remains backward compatible.
