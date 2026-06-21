import XCTest
@testable import CnosKit

final class VoiceSegmenterTests: XCTestCase {

    func testSpeechThenSilenceEndsSegmentAndEmits() {
        let seg = VoiceSegmenter()
        seg.beginSegment(now: 0)
        XCTAssertEqual(seg.tick(level: 50, now: 100, suppressed: false), .none)   // speech starts
        XCTAssertEqual(seg.tick(level: 50, now: 200, suppressed: false), .none)   // still speaking
        XCTAssertTrue(seg.hasSpeech)
        // 900ms of silence after last speech (>850) closes the clip, with audio to send.
        XCTAssertEqual(seg.tick(level: 5, now: 1100, suppressed: false), .endSegment(emit: true))
    }

    func testIdleRecyclesWithoutEmitting() {
        let seg = VoiceSegmenter()
        seg.beginSegment(now: 0)
        XCTAssertEqual(seg.tick(level: 3, now: 1000, suppressed: false), .none)
        XCTAssertEqual(seg.tick(level: 3, now: 5000, suppressed: false), .none)
        // No speech for >6000ms → recycle the recorder, emit nothing.
        XCTAssertEqual(seg.tick(level: 3, now: 6001, suppressed: false), .endSegment(emit: false))
    }

    func testSuppressionDropsTtsTail() {
        let seg = VoiceSegmenter()
        seg.beginSegment(now: 0)
        // Agent speaking: even loud input is held, not counted as speech.
        XCTAssertEqual(seg.tick(level: 80, now: 100, suppressed: true), .none)
        XCTAssertFalse(seg.hasSpeech)
        // Just un-muted: discard whatever was captured during TTS.
        XCTAssertEqual(seg.tick(level: 5, now: 200, suppressed: false), .dropSegment)
    }

    func testLevelMath() {
        XCTAssertEqual(VoiceSegmenter.level(rms: 0), 0)
        XCTAssertEqual(VoiceSegmenter.level(rms: 1.0), 100)        // clamped
        XCTAssertEqual(VoiceSegmenter.level(rms: 0.1), 30)         // 0.1*300
        // Silent buffer → ~0; loud buffer → high.
        XCTAssertEqual(VoiceSegmenter.level(samples: [Float](repeating: 0, count: 256)), 0)
        XCTAssertGreaterThan(VoiceSegmenter.level(samples: [Float](repeating: 0.5, count: 256)), 50)
    }
}
