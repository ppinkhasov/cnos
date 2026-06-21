// A no-XCTest verifier for CnosKit's core logic. Mirrors the XCTest suites so the
// protocol, voice grammar, and segmenter can be exercised with just the Command
// Line Tools:  swift run cnos-verify   (exit 0 = all green, 1 = a check failed).
import Foundation
import CnosKit

var failures = 0
var passes = 0
func check(_ cond: Bool, _ msg: String, line: UInt = #line) {
    if cond { passes += 1 } else { print("  ✗ FAIL (line \(line)): \(msg)"); failures += 1 }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ msg: String, line: UInt = #line) {
    check(a == b, "\(msg)  — got \(a), expected \(b)", line: line)
}
func section(_ s: String) { print("• \(s)") }

let decoder = JSONDecoder()
func decode(_ json: String) -> ServerMessage? { try? decoder.decode(ServerMessage.self, from: Data(json.utf8)) }
func dict(_ m: ClientMessage) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(m))) as? [String: Any] ?? [:]
}

// ---- Voice grammar ----------------------------------------------------------
section("voice grammar")
let names = ["jack", "zulu", "nova"]
let aliases = ["programmer": "programmer", "loop": "loop", "architect": "architect"]
func p(_ s: String) -> VoiceCommand? { VoiceGrammar.parse(s, activeNames: names, promptAliases: aliases) }

eq(p("new terminal"), .spawn(agentType: "claude", prompt: nil), "spawn plain")
eq(p("new codex terminal"), .spawn(agentType: "codex", prompt: nil), "spawn codex")
eq(p("spawn a hermes agent"), .spawn(agentType: "hermes", prompt: nil), "spawn hermes verb/noun")
eq(p("another claude"), .spawn(agentType: "claude", prompt: nil), "spawn 'another claude'")
eq(p("new terminal, programmer"), .spawn(agentType: "claude", prompt: "programmer"), "spawn with role")
eq(p("new codex terminal architect"), .spawn(agentType: "codex", prompt: "architect"), "spawn codex+role")
eq(p("hey jack build a login page"), .command(target: "jack", text: "build a login page"), "filler + command")
eq(p("ok everyone run the tests"), .command(target: "all", text: "run the tests"), "filler + broadcast")
eq(p("everyone commit your work"), .command(target: "all", text: "commit your work"), "broadcast")
eq(p("fleet status"), .command(target: "all", text: "status"), "broadcast 'fleet'")
eq(p("jack stop"), .control(target: "jack", action: .interrupt), "control stop")
eq(p("jack stop it"), .control(target: "jack", action: .interrupt), "control 'stop it'")
eq(p("everyone clear"), .control(target: "all", action: .clear), "control clear broadcast")
eq(p("zulu scratch that"), .control(target: "zulu", action: .clear), "control 'scratch that'")
eq(p("jack go"), .control(target: "jack", action: .enter), "control enter")
eq(p("nova escape"), .control(target: "nova", action: .escape), "control escape")
eq(p("jack"), .select(target: "jack"), "select only")
eq(p("zulu,"), .select(target: "zulu"), "select strips punctuation")
eq(p("jack, build a login page"), .command(target: "jack", text: "build a login page"), "command after comma")
eq(p("nova what is the weather"), .command(target: "nova", text: "what is the weather"), "free-text command")
eq(p("bob do something"), .error("bob do something"), "unknown target → error")
eq(p("jack says, hello there"), .echo("jack says, hello there"), "tts echo ignored")
eq(p("Nova says the build passed"), .echo("Nova says the build passed"), "tts echo case-insensitive")
check({ if case .echo = p("jack say hello") { return false }; return true }(), "'say' is a real command, not echo")
check(p("   ") == nil, "blank → nil")
check(p("um uh") == nil, "filler-only → nil")
eq(VoiceGrammar.clean("Jack,"), "jack", "clean strips punctuation")
eq(VoiceGrammar.clean("stop it!"), "stopit", "clean strips spaces+punct")
eq(VoiceGrammar.clean("Codex-2"), "codex2", "clean strips hyphen")

// ---- Protocol: inbound decode ----------------------------------------------
section("protocol decode")
if case let .hello(h)? = decode(#"{"type":"hello","workdir":"/w","home":"/h","agentTypes":["claude","codex","hermes"],"prompts":[{"id":"loop","label":"Loop","aliases":["loop","iterate"]}],"names":["jack","zulu"]}"#) {
    eq(h.agentTypes, ["claude", "codex", "hermes"], "hello.agentTypes")
    eq(h.prompts.first?.aliases ?? [], ["loop", "iterate"], "hello.prompts[0].aliases")
    eq(h.names, ["jack", "zulu"], "hello.names")
} else { check(false, "decode hello") }

if case let .list(ts)? = decode(#"{"type":"list","terminals":[{"id":"1","name":"jack","agentType":"claude","role":"worker","promptId":null,"promptLabel":"","cwd":"/tmp"}]}"#) {
    eq(ts.count, 1, "list count")
    eq(ts.first?.name ?? "", "jack", "list[0].name")
    check(ts.first?.promptId == nil, "list[0].promptId is null→nil")
} else { check(false, "decode list") }

if case let .spawned(t)? = decode(#"{"type":"spawned","id":"2","name":"zulu","agentType":"codex","role":"lead","promptId":"loop","promptLabel":"Loop","cwd":"/tmp"}"#) {
    eq(t.id, "2", "spawned.id"); eq(t.role ?? "", "lead", "spawned.role"); eq(t.promptLabel ?? "", "Loop", "spawned.promptLabel")
} else { check(false, "decode spawned") }

if case let .output(id, data)? = decode(#"{"type":"output","id":"1","data":"hi\u001b[0m"}"#) {
    eq(id, "1", "output.id"); eq(data, "hi\u{1b}[0m", "output.data keeps ANSI ESC")
} else { check(false, "decode output") }

if case let .exit(id, code)? = decode(#"{"type":"exit","id":"7","code":0}"#) {
    eq(id, "7", "exit.id"); eq(code, 0, "exit.code")
} else { check(false, "decode exit") }

if case let .routed(target, text, count)? = decode(#"{"type":"routed","target":"all","text":"go","count":3}"#) {
    eq(target, "all", "routed.target"); eq(text, "go", "routed.text"); eq(count, 3, "routed.count")
} else { check(false, "decode routed") }

if case let .speaking(on, name)? = decode(#"{"type":"speaking","on":true,"name":"jack"}"#) {
    check(on, "speaking.on"); eq(name ?? "", "jack", "speaking.name")
} else { check(false, "decode speaking") }

if case let .spawnError(msg)? = decode(#"{"type":"spawn-error","message":"codex is not installed"}"#) {
    eq(msg, "codex is not installed", "spawn-error.message")
} else { check(false, "decode spawn-error") }

if case let .orchestration(o)? = decode(#"{"type":"orchestration","enabled":true,"running":true,"resumable":false,"status":"running","goal":"build app","workerType":"claude","workdir":"/tmp","startWorkers":3,"maxAgents":8,"round":2,"agents":4,"fleet":[{"id":"1","name":"jack","role":"lead","agentType":"claude","state":"thinking","task":""}],"log":[{"t":123,"kind":"start","text":"goal set"}]}"#) {
    check(o.running, "orch.running"); eq(o.status, "running", "orch.status")
    eq(o.maxAgents, 8, "orch.maxAgents"); eq(o.fleet.first?.state ?? "", "thinking", "orch.fleet[0].state")
    eq(o.log.first?.kind ?? "", "start", "orch.log[0].kind")
} else { check(false, "decode orchestration") }

if case let .unknown(t)? = decode(#"{"type":"future-thing","x":1}"#) {
    eq(t, "future-thing", "unknown type preserved")
} else { check(false, "decode unknown") }

// ---- Protocol: outbound encode ---------------------------------------------
section("protocol encode")
let sp = dict(.spawn(agentType: "claude", cwd: "/tmp", prompt: "loop"))
eq(sp["type"] as? String, "spawn", "spawn.type"); eq(sp["agentType"] as? String, "claude", "spawn.agentType")
eq(sp["cwd"] as? String, "/tmp", "spawn.cwd"); eq(sp["prompt"] as? String, "loop", "spawn.prompt")
check(sp["name"] == nil, "spawn omits nil name")
eq(dict(.command(target: "jack", text: "hi"))["target"] as? String, "jack", "command.target")
let ctl = dict(.control(action: "interrupt", target: "all"))
eq(ctl["type"] as? String, "control", "control.type"); eq(ctl["action"] as? String, "interrupt", "control.action")
let rz = dict(.resize(id: "1", cols: 80, rows: 24))
eq(rz["cols"] as? Int, 80, "resize.cols"); eq(rz["rows"] as? Int, 24, "resize.rows")
let os = dict(.orchestrateStart(goal: "g", workerType: "codex", workdir: "/w", startWorkers: 3, maxAgents: 8))
eq(os["type"] as? String, "orchestrate-start", "orchStart.type"); eq(os["goal"] as? String, "g", "orchStart.goal")
eq(os["startWorkers"] as? Int, 3, "orchStart.startWorkers")
let setO = dict(.setOrchestration(enabled: true, config: nil))
eq(setO["type"] as? String, "set-orchestration", "setOrch.type"); eq(setO["enabled"] as? Bool, true, "setOrch.enabled")
check(setO["config"] == nil, "setOrch omits nil config")
let cfg = dict(.setOrchestration(config: OrchConfig(goal: "g", workerType: "claude", startWorkers: 2, maxAgents: 6)))
let nested = cfg["config"] as? [String: Any]
eq(nested?["goal"] as? String, "g", "setOrch.config.goal"); eq(nested?["maxAgents"] as? Int, 6, "setOrch.config.maxAgents")
eq(dict(.list)["type"] as? String, "list", "list.type")
eq(dict(.orchestrateStop)["type"] as? String, "orchestrate-stop", "orchStop.type")

// ---- Voice segmenter --------------------------------------------------------
section("voice segmenter")
do {
    let seg = VoiceSegmenter(); seg.beginSegment(now: 0)
    eq(seg.tick(level: 50, now: 100, suppressed: false), .none, "seg speech start")
    eq(seg.tick(level: 50, now: 200, suppressed: false), .none, "seg still speaking")
    check(seg.hasSpeech, "seg hasSpeech")
    eq(seg.tick(level: 5, now: 1100, suppressed: false), .endSegment(emit: true), "seg silence ends+emits")
}
do {
    let seg = VoiceSegmenter(); seg.beginSegment(now: 0)
    eq(seg.tick(level: 3, now: 5000, suppressed: false), .none, "seg idle no-op")
    eq(seg.tick(level: 3, now: 6001, suppressed: false), .endSegment(emit: false), "seg idle recycle no emit")
}
do {
    let seg = VoiceSegmenter(); seg.beginSegment(now: 0)
    eq(seg.tick(level: 80, now: 100, suppressed: true), .none, "seg suppressed holds")
    check(!seg.hasSpeech, "seg suppressed not speech")
    eq(seg.tick(level: 5, now: 200, suppressed: false), .dropSegment, "seg drops TTS tail on unmute")
}
eq(VoiceSegmenter.level(rms: 0), 0, "level 0")
eq(VoiceSegmenter.level(rms: 1.0), 100, "level clamp 100")
eq(VoiceSegmenter.level(rms: 0.1), 30, "level 0.1→30")
check(VoiceSegmenter.level(samples: [Float](repeating: 0, count: 256)) == 0, "level silent samples")
check(VoiceSegmenter.level(samples: [Float](repeating: 0.5, count: 256)) > 50, "level loud samples")

// ---- Optional LIVE integration check (against a running server) -------------
// Enabled by `CNOS_LIVE_URL=http://localhost:PORT swift run cnos-verify`. Proves
// the real WebSocket handshake decodes and a REST endpoint answers end-to-end.
if let liveURL = ProcessInfo.processInfo.environment["CNOS_LIVE_URL"], !liveURL.isEmpty {
    await runLive(liveURL)
}

// ---- Summary ----------------------------------------------------------------
print("")
if failures == 0 {
    print("✅ ALL \(passes) CHECKS PASSED")
    exit(0)
} else {
    print("❌ \(failures) FAILED, \(passes) passed")
    exit(1)
}

// ---- Live integration helpers -----------------------------------------------
actor LiveCollector {
    private(set) var hello: Hello?
    private(set) var sawConnected = false
    private(set) var sawList = false
    private(set) var sawOrchestration = false
    func add(_ ev: CnosEvent) {
        switch ev {
        case .connected: sawConnected = true
        case .message(.hello(let h)): hello = h
        case .message(.list): sawList = true
        case .message(.orchestration): sawOrchestration = true
        default: break
        }
    }
    var hasHello: Bool { hello != nil }
}

func runLive(_ urlStr: String) async {
    section("LIVE server @ \(urlStr)")
    guard let url = URL(string: urlStr) else { check(false, "valid CNOS_LIVE_URL"); return }
    let client = CnosClient(serverURL: url)
    client.callbackQueue = DispatchQueue(label: "live.cb")  // don't depend on main runloop
    let collector = LiveCollector()
    client.onEvent = { ev in Task { await collector.add(ev) } }
    client.connect()

    // Wait up to 6s for the hello handshake.
    var waited = 0
    while waited < 6000 {
        if await collector.hasHello { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
        waited += 100
    }
    let hello = await collector.hello
    check(hello != nil, "received hello from the live server")
    if let h = hello { check(!h.agentTypes.isEmpty, "live hello.agentTypes = \(h.agentTypes)") }
    check(await collector.sawConnected, "WebSocket delegate reported connected")
    check(await collector.sawList, "received initial terminal list")
    check(await collector.sawOrchestration, "received initial orchestration snapshot")

    // A REST round-trip.
    do {
        let dirs = try await client.fetchDirs(path: nil)
        check(!dirs.path.isEmpty, "GET /api/dirs returned path = \(dirs.path)")
    } catch {
        check(false, "GET /api/dirs failed: \(error)")
    }
    client.disconnect()
}
