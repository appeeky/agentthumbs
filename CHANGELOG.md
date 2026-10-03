# Changelog

All notable changes to agentthumbs. The project follows [Semantic Versioning](https://semver.org); while it is at 0.x, a minor version can change the API.

## 0.2.1

First public release.

### Added

- One package, `@appeeky/agentthumbs`, with `@appeeky/agentthumbs/core` for driver authors and `@appeeky/agentthumbs/remote` for servers.
- Android driver over adb: screenshots, input, Unicode typing through ADBKeyBoard, UI tree elements, app listing and launch, media push.
- iOS driver over WebDriverAgent for iPhones in Developer Mode, with `agentthumbs ios setup` to find the device, pick a signing team, and build and launch WebDriverAgent.
- iOS driver through macOS iPhone Mirroring, with Apple Vision OCR for elements.
- Runtime: numbered elements drawn on every screenshot, coordinate scaling, waiting until the screen settles, one action at a time per device.
- Safety: approval before publish-like taps, per-device rate limits, a JSON Lines action log.
- MCP server over stdio, with approvals through MCP elicitation or a macOS dialog, and an optional tool name prefix.
- CLI for every action, keeping the last observation so element ids work across commands.
- Remote access: `agentthumbs serve` (connector), `agentthumbs relay`, a multi-tenant `RelayHub`, and protocol version 1. `@appeeky/agentthumbs/remote` exports them without drivers or native modules.
- Live view helpers for apps that embed agentthumbs: `frame()`, `tapNative()` and `swipeNative()`.
- Skills: `agentthumbs`, `ios-basics`, `app-store`, `permissions-and-dialogs`, `sign-in`, `app-teardown` and `release-check`.
- App skills: `instagram`, `tiktok` and `threads`, for posting and switching accounts.
- `emulator-farm` skill: sets up Android emulators in Docker with KVM on a Linux server and connects them to agentthumbs.
- Documentation site built with Mintlify, in `docs/`, with a device farm guide for running many phones on your own servers.
- Several iPhones per Mac: `agentthumbs ios setup` starts WebDriverAgent on every ready iPhone, each on its own port, and picks up iPhones plugged in later.
- Releases publish automatically from `main`, versioned from Conventional Commits.
