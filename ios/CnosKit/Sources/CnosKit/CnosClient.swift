import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking   // Linux: URLSession lives here
#endif

/// What the client reports back to whoever owns it (the SwiftUI store, or a test).
public enum CnosEvent: Sendable {
    case connected
    case disconnected(Error?)
    case message(ServerMessage)
}

/// A thin, UI-agnostic client for one cnos server.
///
/// Owns a single WebSocket (auto-reconnecting) for the live fleet stream and
/// exposes async helpers for the REST endpoints (usage, dirs, speaking, transcribe).
/// All higher-level state (the agent list, terminals, orchestration) is assembled
/// by the consumer from the `CnosEvent` stream — this type stays stateless beyond
/// the connection itself, which keeps it trivially testable.
public final class CnosClient: NSObject, @unchecked Sendable {

    /// Server base, e.g. `http://192.168.1.20:4173`.
    public let serverURL: URL
    /// Where `onEvent` is delivered (default main, so SwiftUI can mutate directly).
    public var callbackQueue: DispatchQueue = .main
    /// Event sink. Set before `connect()`.
    public var onEvent: ((CnosEvent) -> Void)?
    public var autoReconnect = true

    public private(set) var isConnected = false

    private lazy var wsSession: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private let restSession = URLSession(configuration: .default)
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var task: URLSessionWebSocketTask?
    private var shouldRun = false
    private var reconnectScheduled = false
    private let reconnectDelay: TimeInterval = 1.5
    private let workQueue = DispatchQueue(label: "cnos.client")

    public init(serverURL: URL) {
        self.serverURL = serverURL
        super.init()
    }

    /// `http(s)://host:port` → `ws(s)://host:port`.
    public var webSocketURL: URL {
        var comps = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        comps.scheme = (serverURL.scheme == "https") ? "wss" : "ws"
        comps.path = ""
        return comps.url!
    }

    // MARK: Connection lifecycle

    public func connect() {
        workQueue.async {
            guard !self.shouldRun else { return }
            self.shouldRun = true
            self.openSocket()
        }
    }

    public func disconnect() {
        workQueue.async {
            self.shouldRun = false
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.isConnected = false
        }
    }

    private func openSocket() {
        let t = wsSession.webSocketTask(with: webSocketURL)
        task = t
        t.resume()
        receiveLoop(on: t)
    }

    private func receiveLoop(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.workQueue.async { self.handleClosed(err) }
            case .success(let message):
                switch message {
                case .string(let s): self.handle(text: s)
                case .data(let d): if let s = String(data: d, encoding: .utf8) { self.handle(text: s) }
                @unknown default: break
                }
                self.receiveLoop(on: t)
            }
        }
    }

    private func handle(text: String) {
        guard let data = text.data(using: .utf8) else { return }
        do {
            let msg = try decoder.decode(ServerMessage.self, from: data)
            emit(.message(msg))
        } catch {
            // Mirror the web client: silently ignore anything we can't parse.
        }
    }

    private func handleClosed(_ error: Error?) {
        guard task != nil || isConnected else { return }   // idempotent: receive-fail + delegate-close
        task = nil
        isConnected = false
        emit(.disconnected(error))
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldRun, autoReconnect, !reconnectScheduled else { return }
        reconnectScheduled = true
        workQueue.asyncAfter(deadline: .now() + reconnectDelay) { [weak self] in
            guard let self, self.shouldRun else { return }
            self.reconnectScheduled = false
            self.openSocket()
        }
    }

    private func emit(_ event: CnosEvent) {
        let cb = onEvent
        callbackQueue.async { cb?(event) }
    }

    // MARK: Sending

    public func send(_ message: ClientMessage) {
        workQueue.async {
            guard let t = self.task, self.isConnected else { return }
            guard let data = try? self.encoder.encode(message),
                  let str = String(data: data, encoding: .utf8) else { return }
            t.send(.string(str)) { _ in }
        }
    }

    // Convenience wrappers around the common messages.
    public func spawn(agentType: String, name: String? = nil, cwd: String? = nil, prompt: String? = nil) {
        send(.spawn(agentType: agentType, name: name, cwd: cwd, prompt: prompt))
    }
    public func input(id: String, _ data: String) { send(.input(id: id, data: data)) }
    public func command(target: String, _ text: String) { send(.command(target: target, text: text)) }
    public func control(_ action: ControlAction, target: String) { send(.control(action: action.rawValue, target: target)) }
    public func resize(id: String, cols: Int, rows: Int) { send(.resize(id: id, cols: cols, rows: rows)) }
    public func kill(id: String) { send(.kill(id: id)) }
    public func rename(id: String, name: String) { send(.rename(id: id, name: name)) }
    public func requestList() { send(.list) }

    // MARK: REST

    private func restURL(_ path: String, query: [URLQueryItem] = []) -> URL {
        var comps = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        comps.path = path
        if !query.isEmpty { comps.queryItems = query }
        return comps.url!
    }

    public func fetchUsage(force: Bool = false) async throws -> UsageData {
        let url = restURL("/api/usage", query: force ? [URLQueryItem(name: "force", value: "1")] : [])
        let (data, _) = try await restSession.data(from: url)
        return try decoder.decode(UsageData.self, from: data)
    }

    public func fetchDirs(path: String?) async throws -> DirListing {
        let url = restURL("/api/dirs", query: [URLQueryItem(name: "path", value: path ?? "")])
        let (data, _) = try await restSession.data(from: url)
        return try decoder.decode(DirListing.self, from: data)
    }

    public func postSpeaking(on: Bool, name: String?) async throws {
        var req = URLRequest(url: restURL("/api/speaking"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["on": on, "name": name as Any])
        _ = try await restSession.data(for: req)
    }

    /// POST a recorded clip to `/transcribe`; returns the recognized text (may be empty).
    public func transcribe(audio: Data, contentType: String = "audio/wav") async throws -> String {
        var req = URLRequest(url: restURL("/transcribe"))
        req.httpMethod = "POST"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = audio
        let (data, _) = try await restSession.data(for: req)
        struct R: Decodable { var text: String?; var error: String? }
        let r = try decoder.decode(R.self, from: data)
        if let e = r.error, (r.text ?? "").isEmpty { throw CnosError.transcribe(e) }
        return (r.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum CnosError: Error, LocalizedError {
    case transcribe(String)
    public var errorDescription: String? {
        switch self { case .transcribe(let m): return "Transcription failed: \(m)" }
    }
}

extension CnosClient: URLSessionWebSocketDelegate {
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        workQueue.async {
            self.isConnected = true
            self.emit(.connected)
        }
    }
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        workQueue.async { self.handleClosed(nil) }
    }
}
