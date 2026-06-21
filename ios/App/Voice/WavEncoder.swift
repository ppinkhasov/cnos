import Foundation

// Minimal 16-bit PCM WAV writer. The server's /transcribe runs ffmpeg → 16 kHz
// mono wav for whisper.cpp; sending it a 16 kHz mono wav already is a clean
// pass-through (ffmpeg sniffs content, not the filename).
enum WavEncoder {
    static func encode(samples: [Float], sampleRate: Int = 16_000) -> Data {
        var pcm = [Int16]()
        pcm.reserveCapacity(samples.count)
        for s in samples {
            let v = max(-1, min(1, s))
            pcm.append(Int16(v * 32_767))
        }
        return encode(pcm: pcm, sampleRate: sampleRate)
    }

    static func encode(pcm: [Int16], sampleRate: Int = 16_000, channels: Int = 1) -> Data {
        let bytesPerSample = 2
        let dataBytes = pcm.count * bytesPerSample
        let byteRate = sampleRate * channels * bytesPerSample
        let blockAlign = channels * bytesPerSample

        var d = Data(capacity: 44 + dataBytes)
        func str(_ s: String) { d.append(contentsOf: s.utf8) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }

        str("RIFF"); u32(UInt32(36 + dataBytes)); str("WAVE")
        str("fmt "); u32(16); u16(1)                  // PCM
        u16(UInt16(channels)); u32(UInt32(sampleRate))
        u32(UInt32(byteRate)); u16(UInt16(blockAlign)); u16(16)   // bits per sample
        str("data"); u32(UInt32(dataBytes))
        pcm.withUnsafeBytes { raw in d.append(contentsOf: raw) }
        return d
    }
}
