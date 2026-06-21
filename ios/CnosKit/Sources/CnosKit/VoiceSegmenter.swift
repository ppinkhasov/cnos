import Foundation

// Voice-activity detection + utterance segmenting, lifted from vadLoop() in
// public/app.js. Pure state machine: the iOS layer feeds it an audio level each
// buffer and a "suppressed" flag (true while an agent is speaking — half-duplex),
// and it says when to close off a clip and POST it to /transcribe. No audio
// framework here, so the timing logic is unit-testable off-device.

public final class VoiceSegmenter {

    public struct Tuning: Sendable {
        public var speechThreshold: Double = 14    // level (0–100) that counts as speech
        public var silenceMs: Double = 850         // trailing silence that ends an utterance
        public var maxIdleMs: Double = 6000        // recycle the recorder if no speech
        public var minUtterMs: Double = 250        // ignore sub-quarter-second blips
        public init() {}
    }

    public enum Action: Equatable, Sendable {
        case none
        /// Close the current clip. `emit` → it held speech worth transcribing.
        case endSegment(emit: Bool)
        /// Throw away the in-flight clip (it captured an agent's TTS) and start clean.
        case dropSegment
    }

    private let tuning: Tuning
    private var hadSpeech = false
    private var lastSpeechAt = 0.0
    private var segStartAt = 0.0
    private var wasSuppressed = false

    public init(tuning: Tuning = Tuning()) { self.tuning = tuning }

    /// Call when a fresh clip starts recording (re-arm).
    public func beginSegment(now: Double) {
        hadSpeech = false; lastSpeechAt = 0; segStartAt = now
    }

    public var hasSpeech: Bool { hadSpeech }
    public func segmentDuration(now: Double) -> Double { now - segStartAt }

    /// One VAD tick. `level` is 0–100; `now` is a monotonic millisecond clock.
    public func tick(level: Double, now: Double, suppressed: Bool) -> Action {
        if suppressed {
            // Agent is speaking: never count this as speech, hold the clip open so
            // the TTS audio is dropped rather than transcribed.
            hadSpeech = false; lastSpeechAt = 0; segStartAt = now; wasSuppressed = true
            return .none
        }
        if wasSuppressed {              // just un-muted → discard the TTS tail
            wasSuppressed = false
            return .dropSegment
        }
        if level > tuning.speechThreshold { hadSpeech = true; lastSpeechAt = now }
        if hadSpeech, lastSpeechAt > 0, now - lastSpeechAt > tuning.silenceMs {
            let longEnough = (now - segStartAt) > tuning.minUtterMs
            return .endSegment(emit: longEnough)
        }
        if !hadSpeech, now - segStartAt > tuning.maxIdleMs {
            return .endSegment(emit: false)   // idle recycle — nothing to send
        }
        return .none
    }

    // MARK: Level helpers (match app.js: rms * 300, clamped to 100)

    /// RMS of mono float samples already normalized to [-1, 1] (AVAudioEngine taps).
    public static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum = 0.0
        for s in samples { sum += Double(s) * Double(s) }
        return (sum / Double(samples.count)).squareRoot()
    }

    public static func level(rms: Double) -> Double {
        min(100, (rms * 300).rounded())
    }

    public static func level(samples: [Float]) -> Double {
        level(rms: rms(samples))
    }
}
