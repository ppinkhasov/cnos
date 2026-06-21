import Foundation
import AVFoundation
import Combine
import CnosKit

// Native re-implementation of the web client's voice pipeline (app.js):
//   mic → VAD/segmenting → record clip → POST /transcribe → parse → route.
// A plain ObservableObject (like FleetStore): correctness rests on updating
// @Published state only on the main thread. The audio-thread work lives in
// AudioPipeline. Honors half-duplex muting while an agent is speaking
// (FleetStore.agentSpeaking, relayed from the server's /api/speaking).
final class VoiceController: ObservableObject {
    enum State: Equatable { case off, listening, muted, denied, unavailable }

    @Published private(set) var state: State = .off
    @Published private(set) var level: Double = 0

    private let store: FleetStore
    private let engine = AVAudioEngine()
    private let pipeline = AudioPipeline()

    private var clipSink: AsyncStream<Data>.Continuation?
    private var consumer: Task<Void, Never>?
    private var speakingObserver: AnyCancellable?

    init(store: FleetStore) {
        self.store = store
        pipeline.onLevel = { [weak self] lvl in
            DispatchQueue.main.async { self?.level = lvl }
        }
        // Half-duplex: mute capture while an agent speaks (+ a short tail).
        speakingObserver = store.$agentSpeaking
            .receive(on: RunLoop.main)
            .sink { [weak self] speaking in
                guard let self else { return }
                self.pipeline.setSpeaking(speaking)
                if self.state == .listening && speaking { self.state = .muted }
                else if self.state == .muted && !speaking { self.state = .listening }
            }
    }

    var isOn: Bool { state == .listening || state == .muted }
    var statusText: String {
        switch state {
        case .off: return "Listen"
        case .listening: return "Listening"
        case .muted: return "🔇 muted"
        case .denied: return "Mic blocked"
        case .unavailable: return "No voice"
        }
    }

    func toggle() { isOn ? stop() : start() }

    func start() {
        requestPermission { [weak self] granted in
            // Always resume on main for engine + UI work.
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else { self.state = .denied; return }
                do {
                    self.startConsumer()        // wire the clip sink BEFORE the tap runs
                    try self.startEngine()
                    self.state = .listening
                } catch {
                    self.state = .unavailable
                    self.store.notify("voice unavailable: \(error.localizedDescription)", isError: true)
                }
            }
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        consumer?.cancel(); consumer = nil
        clipSink?.finish(); clipSink = nil
        level = 0
        state = .off
    }

    // MARK: Internals

    private func requestPermission(_ done: @escaping @Sendable (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(done)
        }
    }

    private func startEngine() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        pipeline.configure(inputFormat: inFormat)
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [pipeline] buffer, _ in
            pipeline.process(buffer)            // audio thread
        }
        engine.prepare()
        try engine.start()
    }

    private func startConsumer() {
        // The continuation is captured DIRECTLY by the pipeline callback so the
        // audio thread never reaches back into this object's state.
        let stream = AsyncStream<Data> { cont in
            self.clipSink = cont
            self.pipeline.onClip = { wav in cont.yield(wav) }
        }
        consumer = Task { [weak self] in
            for await wav in stream {
                guard let self else { break }
                let text = (try? await self.store.client.transcribe(audio: wav, contentType: "audio/wav")) ?? ""
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, trimmed.rangeOfCharacter(from: .alphanumerics) != nil else { continue }
                await MainActor.run { self.store.routeVoice(trimmed) }
            }
        }
    }
}
