import XCTest
@testable import CnosKit

final class VoiceGrammarTests: XCTestCase {
    let names = ["jack", "zulu", "nova"]
    let aliases = ["programmer": "programmer", "loop": "loop", "architect": "architect"]

    func parse(_ s: String) -> VoiceCommand? {
        VoiceGrammar.parse(s, activeNames: names, promptAliases: aliases)
    }

    func testSpawnPlain() {
        XCTAssertEqual(parse("new terminal"), .spawn(agentType: "claude", prompt: nil))
        XCTAssertEqual(parse("new claude terminal"), .spawn(agentType: "claude", prompt: nil))
        XCTAssertEqual(parse("new codex terminal"), .spawn(agentType: "codex", prompt: nil))
        XCTAssertEqual(parse("spawn a hermes agent"), .spawn(agentType: "hermes", prompt: nil))
        XCTAssertEqual(parse("another claude"), .spawn(agentType: "claude", prompt: nil))
    }

    func testSpawnWithRole() {
        XCTAssertEqual(parse("new terminal, programmer"), .spawn(agentType: "claude", prompt: "programmer"))
        XCTAssertEqual(parse("new codex terminal architect"), .spawn(agentType: "codex", prompt: "architect"))
    }

    func testFillerStripped() {
        XCTAssertEqual(parse("hey jack build a login page"), .command(target: "jack", text: "build a login page"))
        XCTAssertEqual(parse("ok everyone run the tests"), .command(target: "all", text: "run the tests"))
    }

    func testBroadcast() {
        XCTAssertEqual(parse("everyone commit your work"), .command(target: "all", text: "commit your work"))
        XCTAssertEqual(parse("fleet status"), .command(target: "all", text: "status"))
    }

    func testControls() {
        XCTAssertEqual(parse("jack stop"), .control(target: "jack", action: .interrupt))
        XCTAssertEqual(parse("jack stop it"), .control(target: "jack", action: .interrupt))
        XCTAssertEqual(parse("everyone clear"), .control(target: "all", action: .clear))
        XCTAssertEqual(parse("zulu scratch that"), .control(target: "zulu", action: .clear))
        XCTAssertEqual(parse("jack go"), .control(target: "jack", action: .enter))
        XCTAssertEqual(parse("nova escape"), .control(target: "nova", action: .escape))
    }

    func testSelectOnly() {
        XCTAssertEqual(parse("jack"), .select(target: "jack"))
        XCTAssertEqual(parse("zulu,"), .select(target: "zulu"))   // punctuation stripped from head
    }

    func testCommandText() {
        XCTAssertEqual(parse("jack, build a login page"), .command(target: "jack", text: "build a login page"))
        XCTAssertEqual(parse("nova what is the weather"), .command(target: "nova", text: "what is the weather"))
    }

    func testUnknownTargetIsError() {
        XCTAssertEqual(parse("bob do something"), .error("bob do something"))
        XCTAssertEqual(parse("random words here"), .error("random words here"))
    }

    func testTtsEchoIgnored() {
        XCTAssertEqual(parse("jack says, hello there"), .echo("jack says, hello there"))
        XCTAssertEqual(parse("Nova says the build passed"), .echo("Nova says the build passed"))
        // a real command must NOT be mistaken for echo
        if case .echo = parse("jack say hello")! { XCTFail("'say' (not 'says') is a real command") }
    }

    func testEmptyAndFillerOnly() {
        XCTAssertNil(parse("   "))
        XCTAssertNil(parse("um uh"))
    }

    func testClean() {
        XCTAssertEqual(VoiceGrammar.clean("Jack,"), "jack")
        XCTAssertEqual(VoiceGrammar.clean("stop it!"), "stopit")
        XCTAssertEqual(VoiceGrammar.clean("Codex-2"), "codex2")
    }
}
