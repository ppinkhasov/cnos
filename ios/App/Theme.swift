import SwiftUI

// Palette mirrored from public/style.css + the xterm theme in app.js, so the
// native client feels like the web one.
enum Theme {
    static let bg        = Color(hex: 0x0d1017)
    static let panel     = Color(hex: 0x141821)
    static let panel2    = Color(hex: 0x1b212d)
    static let border    = Color(hex: 0x262d3a)
    static let text      = Color(hex: 0xe6e9ef)
    static let muted     = Color(hex: 0x8a93a6)
    static let accent    = Color(hex: 0x7c9cff)   // blue
    static let green     = Color(hex: 0x58d6a6)
    static let danger    = Color(hex: 0xff6b6b)
    static let yellow    = Color(hex: 0xe6c07b)
    static let magenta   = Color(hex: 0xc792ea)

    // Per-agent-type accent (matches the .type chip colors).
    static func typeColor(_ type: String) -> Color {
        switch type {
        case "claude": return accent
        case "codex":  return green
        case "hermes": return magenta
        default:       return muted
        }
    }

    // Orchestrator state dot colors.
    static func stateColor(_ state: String) -> Color {
        switch state {
        case "working", "busy": return green
        case "thinking":        return yellow
        case "idle":            return muted
        default:                return muted
        }
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: alpha)
    }
}
