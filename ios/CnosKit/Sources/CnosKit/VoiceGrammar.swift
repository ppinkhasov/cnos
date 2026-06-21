import Foundation

// A faithful port of parseVoice() / routeVoice() from public/app.js. Pure and
// deterministic so it can be unit-tested off-device. The iOS layer captures audio,
// POSTs it to /transcribe, then feeds the returned transcript through `parse`.

/// The interpreted result of one spoken utterance.
public enum VoiceCommand: Equatable, Sendable {
    /// The fleet's own TTS came back through the mic ("<callsign> says, …") — ignore.
    case echo(String)
    /// "new claude terminal, programmer" — launch a new agent, optionally pre-rolled.
    case spawn(agentType: String, prompt: String?)
    /// Named no known agent / "everyone" / "new terminal" — couldn't route.
    case error(String)
    /// Named an agent only ("jack") — just make it the active target.
    case select(target: String)
    /// A routed control word ("jack, stop" / "everyone, clear").
    case control(target: String, action: ControlAction)
    /// A routed free-text command ("jack, build a login page").
    case command(target: String, text: String)
}

public enum VoiceGrammar {
    // Vocabulary — kept identical to app.js.
    static let broadcast: Set<String> = ["everyone", "all", "team", "fleet", "everybody", "guys"]
    static let filler: Set<String> = ["hey", "ok", "okay", "yo", "hi", "hello", "please", "now", "so", "um", "uh"]
    static let control: [ControlAction: Set<String>] = [
        .interrupt: ["stop", "stopit", "stopthat", "stopnow", "stopplease", "halt", "cancel", "cancelthat",
                     "abort", "interrupt", "nevermind", "pause", "wait", "holdon"],
        .escape: ["escape", "dismiss", "goback"],
        .enter: ["enter", "submit", "send", "sendit", "go", "run", "runit", "doit", "confirm", "yes", "proceed"],
        .clear: ["clear", "clearit", "clearthat", "clearinput", "cleartext", "cleartheinput", "clearthetext",
                 "clearthecommand", "erase", "erasethat", "erasethis", "wipe", "wipethat", "wipeit",
                 "scratchthat", "discard", "discardthat", "deletethat"],
    ]
    static let spawnVerb = #"^(new|add|create|spawn|launch|open|start|another)\b"#
    static let spawnNoun = #"\b(terminal|terminals|agent|agents|cli|claude|codex|hermes|window|windows|bot|instance|session)\b"#
    static let agentTypeRE = #"\b(claude|codex|hermes)\b"#
    static let ttsEchoRE = #"^\s*[a-z][a-z0-9-]*\s*,?\s+says\b"#

    /// Lowercase and strip everything but [a-z0-9] — the same `clean()` as app.js.
    public static func clean(_ s: String) -> String {
        s.lowercased().unicodeScalars.filter { ("a"..."z").contains(Character($0)) || ("0"..."9").contains(Character($0)) }
            .map(String.init).joined()
    }

    private static func matches(_ pattern: String, _ text: String, caseInsensitive: Bool = false) -> Bool {
        var opts: String.CompareOptions = [.regularExpression]
        if caseInsensitive { opts.insert(.caseInsensitive) }
        return text.range(of: pattern, options: opts) != nil
    }

    private static func firstMatch(_ pattern: String, _ text: String) -> String? {
        guard let r = text.range(of: pattern, options: .regularExpression) else { return nil }
        return String(text[r])
    }

    /// Interpret a transcript.
    /// - Parameters:
    ///   - activeNames: current live agent call signs (lowercased, as the server names them).
    ///   - promptAliases: spoken alias → role-prompt id (from the `hello` payload).
    public static func parse(_ transcript: String,
                             activeNames: [String],
                             promptAliases: [String: String] = [:]) -> VoiceCommand? {
        // The fleet's TTS echo is the one phrase no real command has as its 2nd word.
        if matches(ttsEchoRE, transcript, caseInsensitive: true) { return .echo(transcript) }

        var tokens = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace }).map(String.init)
        while let first = tokens.first, filler.contains(clean(first)) { tokens.removeFirst() }
        if tokens.isEmpty { return nil }

        let phrase = tokens.joined(separator: " ").lowercased()
        if matches(spawnVerb, phrase) && matches(spawnNoun, phrase) {
            let type = firstMatch(agentTypeRE, phrase) ?? "claude"
            var prompt: String?
            for tok in tokens { if let id = promptAliases[clean(tok)] { prompt = id; break } }
            return .spawn(agentType: type, prompt: prompt)
        }

        let head = clean(tokens[0])
        let target: String
        if broadcast.contains(head) { target = "all" }
        else if activeNames.contains(head) { target = head }
        else { return .error(transcript) }   // must name an agent, "everyone", or "new terminal"

        let body = tokens.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespaces)
        if body.isEmpty { return .select(target: target) }
        let c = clean(body)
        for (action, words) in control where words.contains(c) { return .control(target: target, action: action) }
        return .command(target: target, text: body)
    }
}
