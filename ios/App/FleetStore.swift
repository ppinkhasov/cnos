import Foundation
import Combine
import CnosKit

// FleetStore and AgentModel are plain ObservableObjects (not @MainActor) so they
// build on iOS 16. Correctness rests on one invariant: every mutation happens on
// the main thread. We guarantee that by setting `client.callbackQueue = .main`
// (so the WS event stream arrives on main, in order — critical for terminal
// bytes) and by hopping any async/REST/timer continuations back to main before
// touching @Published state.

/// One agent terminal in the UI. Owns its scrollback (for replay when the card
/// re-appears) and a live byte stream the terminal view subscribes to.
final class AgentModel: ObservableObject, Identifiable {
    let id: String
    @Published var name: String
    @Published var type: String
    @Published var role: String          // worker | lead
    @Published var promptLabel: String
    @Published var cwd: String
    @Published var exited = false
    @Published var routedFlash = false

    private(set) var history = ""
    let liveOutput = PassthroughSubject<String, Never>()
    private let maxHistory = 400_000

    init(_ t: TerminalInfo) {
        id = t.id
        name = t.name
        type = t.agentType ?? "claude"
        role = t.role ?? "worker"
        promptLabel = t.promptLabel ?? ""
        cwd = t.cwd ?? ""
    }

    func update(_ t: TerminalInfo) {
        name = t.name
        if let a = t.agentType { type = a }
        if let r = t.role { role = r }
        if let p = t.promptLabel { promptLabel = p }
        if let c = t.cwd { cwd = c }
    }

    func feed(_ data: String) {
        history += data
        if history.count > maxHistory { history = String(history.suffix(maxHistory)) }
        liveOutput.send(data)
    }

    var badge: String { role == "lead" ? "LEAD" : promptLabel }
    var cwdShort: String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
}

/// The live mirror of one cnos server: connection state, the agent fleet, the
/// orchestration snapshot, and usage — assembled from the CnosKit event stream.
final class FleetStore: ObservableObject {
    let client: CnosClient
    private let settings: AppSettings

    @Published private(set) var connected = false
    @Published private(set) var connecting = true
    @Published private(set) var agents: [AgentModel] = []
    @Published private(set) var orchestration = Orchestration.empty
    @Published private(set) var hello: Hello?
    @Published var usage: UsageData?
    @Published var notice: Notice?
    @Published var target: String = "all"
    @Published private(set) var agentSpeaking = false   // half-duplex hint for voice

    private var index: [String: AgentModel] = [:]
    private var speakingCount = 0
    private var usageTimer: Timer?
    private var pendingSpawnAnnounce = false

    struct Notice: Identifiable, Equatable {
        let id = UUID(); var text: String; var isError: Bool
    }

    init(serverURL: URL, settings: AppSettings) {
        self.settings = settings
        self.client = CnosClient(serverURL: serverURL)
        client.callbackQueue = .main      // events arrive on main, in order
        client.onEvent = { [weak self] event in self?.handle(event) }
    }

    // MARK: Lifecycle

    func connect() {
        connecting = true
        client.connect()
        startUsagePolling()
    }

    func disconnect() {
        usageTimer?.invalidate()
        client.disconnect()
    }

    // MARK: Derived

    var activeNames: [String] { agents.filter { !$0.exited }.map(\.name) }
    var promptAliases: [String: String] {
        var m: [String: String] = [:]
        for p in hello?.prompts ?? [] { for a in p.aliases { m[a] = p.id } }
        return m
    }
    var agentTypes: [String] { hello?.agentTypes ?? ["claude", "codex", "hermes"] }
    var prompts: [PromptInfo] { hello?.prompts ?? [] }
    var currentWorkdir: String? { settings.workdir.isEmpty ? nil : settings.workdir }

    // MARK: Event handling (called on main via callbackQueue)

    private func handle(_ event: CnosEvent) {
        switch event {
        case .connected:
            connected = true; connecting = false
            refreshUsage(force: true)
        case .disconnected:
            connected = false
            notify("connection lost — reconnecting…", isError: true)
        case .message(let m):
            dispatch(m)
        }
    }

    private func dispatch(_ m: ServerMessage) {
        switch m {
        case .hello(let h):
            hello = h
            if target != "all", !activeNames.contains(target) { target = "all" }
        case .list(let ts):
            syncList(ts)
        case .spawned(let t):
            let a = upsert(t)
            if pendingSpawnAnnounce {
                pendingSpawnAnnounce = false
                let r = a.promptLabel.isEmpty ? "" : " (\(a.promptLabel))"
                notify("\(a.type) \(a.name)\(r) ready — say “\(a.name), …”")
            }
        case .output(let id, let data):
            index[id]?.feed(data)
        case .exit(let id, _):
            markExited(id)
        case .routed(let target, _, _):
            flashRouted(target)
        case .spawnError(let msg):
            notify(msg, isError: true)
        case .speaking(let on, _):
            setSpeaking(on)
        case .orchestration(let o):
            orchestration = o
        case .unknown:
            break
        }
    }

    // MARK: Fleet mutation

    private func syncList(_ list: [TerminalInfo]) {
        let keep = Set(list.map(\.id))
        for a in agents where !keep.contains(a.id) { markExited(a.id) }
        for t in list { _ = upsert(t) }
    }

    @discardableResult
    private func upsert(_ t: TerminalInfo) -> AgentModel {
        if let a = index[t.id] { a.update(t); a.exited = false; return a }
        let a = AgentModel(t)
        index[t.id] = a
        agents.append(a)
        return a
    }

    private func markExited(_ id: String) {
        guard let a = index[id], !a.exited else { return }
        a.exited = true
        a.feed("\r\n\u{1b}[2m── agent exited ──\u{1b}[0m\r\n")
        let name = a.name
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.index[id]?.exited == true else { return }
            self.index[id] = nil
            self.agents.removeAll { $0.id == id }
            if self.target == name { self.target = "all" }
        }
    }

    private func flashRouted(_ target: String) {
        let names = (target == "all") ? Set(activeNames) : [target]
        for a in agents where names.contains(a.name) {
            a.routedFlash = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { a.routedFlash = false }
        }
    }

    private func setSpeaking(_ on: Bool) {
        speakingCount = on ? speakingCount + 1 : max(0, speakingCount - 1)
        agentSpeaking = speakingCount > 0
    }

    func notify(_ text: String, isError: Bool = false) {
        notice = Notice(text: text, isError: isError)
    }

    // MARK: Actions (typed UI + voice share these)

    func sendCommand(_ text: String, to target: String? = nil) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        client.command(target: target ?? self.target, text)
    }
    func sendControl(_ action: ControlAction, to target: String? = nil) {
        client.control(action, target: target ?? self.target)
    }
    func sendInput(_ data: String, to id: String) { client.input(id: id, data) }
    func resize(id: String, cols: Int, rows: Int) { client.resize(id: id, cols: cols, rows: rows) }
    func kill(id: String) { client.kill(id: id) }

    func spawn(type: String, prompt: String? = nil, announce: Bool = false) {
        if announce { pendingSpawnAnnounce = true }
        client.spawn(agentType: type, cwd: currentWorkdir, prompt: prompt)
    }

    /// Route a recognized transcript through the shared voice grammar.
    func routeVoice(_ transcript: String) {
        guard let cmd = VoiceGrammar.parse(transcript, activeNames: activeNames, promptAliases: promptAliases) else { return }
        switch cmd {
        case .echo:
            notify("🔇 ignored agent speech")
        case .error:
            notify("heard “\(transcript)” — start with an agent name, “everyone”, or “new terminal”", isError: true)
        case .spawn(let type, let prompt):
            spawn(type: type, prompt: prompt, announce: true)
            notify("heard “\(transcript)” → launching a \(type) agent…")
        case .select(let t):
            target = t
            notify("heard “\(transcript)” → \(label(t)) is now the target")
        case .control(let t, let action):
            target = t
            sendControl(action, to: t)
            notify("heard “\(transcript)” → \(label(t)) \(action.rawValue)")
        case .command(let t, let text):
            target = t
            sendCommand(text, to: t)
            notify("heard “\(transcript)” → \(label(t))")
        }
    }
    private func label(_ t: String) -> String { t == "all" ? "everyone" : t }

    // MARK: Orchestration

    func toggleOrchestration() { client.send(.setOrchestration(enabled: !orchestration.enabled, config: nil)) }
    func pushOrchConfig(_ c: OrchConfig) { client.send(.setOrchestration(enabled: nil, config: c)) }
    func startOrchestration(goal: String, workerType: String, startWorkers: Int, maxAgents: Int) {
        client.send(.orchestrateStart(goal: goal, workerType: workerType, workdir: currentWorkdir,
                                      startWorkers: startWorkers, maxAgents: maxAgents))
    }
    func stopOrchestration() { client.send(.orchestrateStop) }
    func resumeOrchestration() { client.send(.orchestrateResume) }

    // MARK: Usage

    private func startUsagePolling() {
        usageTimer?.invalidate()
        usageTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.refreshUsage()
        }
    }
    func refreshUsage(force: Bool = false) {
        Task { [weak self] in
            guard let self, let u = try? await self.client.fetchUsage(force: force) else { return }
            await MainActor.run { self.usage = u }
        }
    }

    // MARK: Dirs (workdir picker)

    func listDirs(_ path: String?) async -> DirListing? {
        try? await client.fetchDirs(path: path)
    }
}
