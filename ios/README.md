# cnos — native iOS client

A SwiftUI app that connects to a running [cnos](../README.md) server over its
WebSocket protocol: live agent terminals (SwiftTerm), hands-free voice control,
the orchestrator panel, the working-directory picker, role/loop **Loop Prompt**
launches, and the usage strip — the cnos web UI, native on iOS/iPadOS.

## Layout

- **`CnosKit/`** — Foundation-only core, no UIKit/SwiftUI: the WebSocket client
  (`CnosClient`), the wire protocol (`Protocol` / `Models`, kept in lockstep with
  the server's messages), and the voice layer (`VoiceGrammar` + `VoiceSegmenter`
  VAD). It has no Apple-UI dependencies so it builds and is verified headlessly.
- **`App/`** — the SwiftUI app: `FleetStore` (the live mirror of one server),
  `ContentView` + `Views/` (fleet grid, command bar, orchestrator, workdir picker,
  usage), `Terminal/AgentTerminalView` (SwiftTerm bridge), `Voice/` (mic capture →
  WAV → `/transcribe`). Depends on `CnosKit` + SwiftTerm.
- **`project.yml`** — XcodeGen spec; the source of truth. The `.xcodeproj` is
  generated from it (and git-ignored).

## Build & run (needs full Xcode, not just Command Line Tools)

```sh
cd ios
xcodegen generate        # writes Cnos.xcodeproj from project.yml
open Cnos.xcodeproj       # Xcode resolves the SwiftTerm package, then Run
```

On the **Connect** screen, point the app at your cnos server, e.g.
`http://<your-mac-ip>:4173` (the Mac running `npm start`). Both devices must be on
the same network; the iPhone reaches the laptop by LAN IP.

## Verify the core (no Xcode required)

The protocol, voice grammar, and VAD segmenter are checked by a headless harness
(used because XCTest needs full Xcode):

```sh
cd ios/CnosKit && swift run cnos-verify     # → "ALL N CHECKS PASSED"
```
