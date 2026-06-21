import XCTest
@testable import CnosKit

final class ProtocolTests: XCTestCase {
    let decoder = JSONDecoder()

    func decode(_ json: String) throws -> ServerMessage {
        try decoder.decode(ServerMessage.self, from: Data(json.utf8))
    }

    // MARK: Inbound

    func testHello() throws {
        let m = try decode(#"{"type":"hello","workdir":"/w","home":"/h","agentTypes":["claude","codex","hermes"],"prompts":[{"id":"loop","label":"Loop","aliases":["loop","iterate"]}],"names":["jack","zulu"]}"#)
        guard case let .hello(h) = m else { return XCTFail("not hello") }
        XCTAssertEqual(h.agentTypes, ["claude", "codex", "hermes"])
        XCTAssertEqual(h.prompts.first?.aliases, ["loop", "iterate"])
        XCTAssertEqual(h.names, ["jack", "zulu"])
        XCTAssertEqual(h.workdir, "/w")
    }

    func testList() throws {
        let m = try decode(#"{"type":"list","terminals":[{"id":"1","name":"jack","agentType":"claude","role":"worker","promptId":null,"promptLabel":"","cwd":"/tmp"}]}"#)
        guard case let .list(ts) = m else { return XCTFail("not list") }
        XCTAssertEqual(ts.count, 1)
        XCTAssertEqual(ts[0].name, "jack")
        XCTAssertNil(ts[0].promptId)
        XCTAssertEqual(ts[0].cwd, "/tmp")
    }

    func testSpawned() throws {
        let m = try decode(#"{"type":"spawned","id":"2","name":"zulu","agentType":"codex","promptId":"loop","promptLabel":"Loop","cwd":"/tmp"}"#)
        guard case let .spawned(t) = m else { return XCTFail("not spawned") }
        XCTAssertEqual(t.id, "2")
        XCTAssertEqual(t.agentType, "codex")
        XCTAssertEqual(t.promptLabel, "Loop")
    }

    func testOutputExitRouted() throws {
        if case let .output(id, data) = try decode(#"{"type":"output","id":"1","data":"hi\u001b[0m"}"#) {
            XCTAssertEqual(id, "1"); XCTAssertEqual(data, "hi\u{1b}[0m")
        } else { XCTFail("not output") }

        if case let .exit(id, code) = try decode(#"{"type":"exit","id":"7","code":0}"#) {
            XCTAssertEqual(id, "7"); XCTAssertEqual(code, 0)
        } else { XCTFail("not exit") }

        if case let .routed(target, text, count) = try decode(#"{"type":"routed","target":"all","text":"go","count":3}"#) {
            XCTAssertEqual(target, "all"); XCTAssertEqual(text, "go"); XCTAssertEqual(count, 3)
        } else { XCTFail("not routed") }
    }

    func testSpeakingAndSpawnError() throws {
        if case let .speaking(on, name) = try decode(#"{"type":"speaking","on":true,"name":"jack"}"#) {
            XCTAssertTrue(on); XCTAssertEqual(name, "jack")
        } else { XCTFail("not speaking") }

        if case let .spawnError(msg) = try decode(#"{"type":"spawn-error","message":"codex is not installed"}"#) {
            XCTAssertEqual(msg, "codex is not installed")
        } else { XCTFail("not spawn-error") }
    }

    func testUnknownType() throws {
        guard case let .unknown(t) = try decode(#"{"type":"future-thing","x":1}"#) else { return XCTFail() }
        XCTAssertEqual(t, "future-thing")
    }

    // MARK: Outbound — verify exact JSON shape the server's handle() expects

    func dict(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testEncodeSpawnOmitsNilName() throws {
        let d = try dict(.spawn(agentType: "claude", cwd: "/tmp", prompt: "loop"))
        XCTAssertEqual(d["type"] as? String, "spawn")
        XCTAssertEqual(d["agentType"] as? String, "claude")
        XCTAssertEqual(d["cwd"] as? String, "/tmp")
        XCTAssertEqual(d["prompt"] as? String, "loop")
        XCTAssertNil(d["name"])     // nil fields must not be sent
    }

    func testEncodeCommandControlResize() throws {
        XCTAssertEqual(try dict(.command(target: "jack", text: "hi"))["target"] as? String, "jack")
        let ctl = try dict(.control(action: "interrupt", target: "all"))
        XCTAssertEqual(ctl["type"] as? String, "control")
        XCTAssertEqual(ctl["action"] as? String, "interrupt")
        let rz = try dict(.resize(id: "1", cols: 80, rows: 24))
        XCTAssertEqual(rz["cols"] as? Int, 80)
        XCTAssertEqual(rz["rows"] as? Int, 24)
    }

    func testEncodeListAndKill() throws {
        XCTAssertEqual(try dict(.list)["type"] as? String, "list")
        let k = try dict(.kill(id: "9"))
        XCTAssertEqual(k["type"] as? String, "kill")
        XCTAssertEqual(k["id"] as? String, "9")
    }
}
