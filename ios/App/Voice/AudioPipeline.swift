import Foundation
import AVFoundation
import CnosKit

// The off-main half of voice capture. Everything here runs on the audio render
// thread (the engine tap) and stays self-contained — it never touches main-actor
// state — so there are no isolation violations. It resamples each buffer to
// 16 kHz mono, runs the shared VoiceSegmenter, accumulates the current clip, and
// hands finished clips / level updates back via callbacks.
final class AudioPipeline {
    /// Finished clip ready for /transcribe (called on the audio thread).
    var onClip: ((Data) -> Void)?
    /// Throttled 0–100 level for the meter (called on the audio thread).
    var onLevel: ((Double) -> Void)?

    private let segmenter = VoiceSegmenter()
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var inputSampleRate: Double = 48_000
    private var accumulator: [Float] = []
    private var levelTick = 0

    // Half-duplex flags, written from main under a lock, read on the audio thread.
    private let lock = NSLock()
    private var speaking = false
    private var suppressUntilMs: Double = 0
    private let speakTailMs: Double = 500

    func configure(inputFormat: AVAudioFormat) {
        inputSampleRate = inputFormat.sampleRate > 0 ? inputFormat.sampleRate : 48_000
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)
        targetFormat = target
        converter = target.flatMap { AVAudioConverter(from: inputFormat, to: $0) }
        accumulator.removeAll()
        segmenter.beginSegment(now: Self.nowMs())
    }

    func setSpeaking(_ on: Bool) {
        lock.lock()
        if speaking && !on { suppressUntilMs = Self.nowMs() + speakTailMs }
        speaking = on
        lock.unlock()
    }

    private func suppressed(_ now: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return speaking || now < suppressUntilMs
    }

    /// Feed one engine buffer. Audio thread only.
    func process(_ buffer: AVAudioPCMBuffer) {
        let frames = resampleToMono16k(buffer)
        guard !frames.isEmpty else { return }
        let level = VoiceSegmenter.level(samples: frames)
        let now = Self.nowMs()
        let isMuted = suppressed(now)

        levelTick += 1
        if levelTick % 3 == 0 { onLevel?(isMuted ? 0 : level) }

        let action = segmenter.tick(level: level, now: now, suppressed: isMuted)
        if isMuted { accumulator.removeAll(); return }   // never keep an agent's TTS
        accumulator.append(contentsOf: frames)

        switch action {
        case .none:
            break
        case .endSegment(let emit):
            let clip = accumulator
            accumulator.removeAll()
            segmenter.beginSegment(now: now)
            if emit, clip.count > 16_000 / 8 {           // ≥125 ms
                onClip?(WavEncoder.encode(samples: clip))
            }
        case .dropSegment:
            accumulator.removeAll()
            segmenter.beginSegment(now: now)
        }
    }

    // MARK: Resampling

    private func resampleToMono16k(_ input: AVAudioPCMBuffer) -> [Float] {
        guard let converter, let target = targetFormat else { return Self.monoFloats(input) }
        let inRate = input.format.sampleRate > 0 ? input.format.sampleRate : inputSampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * (16_000.0 / inRate) + 32)
        guard capacity > 0, let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }

        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true; status.pointee = .haveData; return input
        }
        if err != nil { return [] }
        let n = Int(out.frameLength)
        guard n > 0, let ch = out.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: ch[0], count: n))
    }

    private static func monoFloats(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let ch = buffer.floatChannelData else { return [] }
        let n = Int(buffer.frameLength)
        let chans = Int(buffer.format.channelCount)
        if chans == 1 { return Array(UnsafeBufferPointer(start: ch[0], count: n)) }
        var out = [Float](repeating: 0, count: n)
        for c in 0..<chans { for i in 0..<n { out[i] += ch[c][i] } }
        let inv = 1 / Float(chans)
        for i in 0..<n { out[i] *= inv }
        return out
    }

    static func nowMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
}
