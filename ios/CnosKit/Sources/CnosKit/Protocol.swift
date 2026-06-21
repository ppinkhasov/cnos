import Foundation

// Wire protocol for the cnos WebSocket. These types mirror, byte-for-byte, the
// JSON the Node server sends and accepts (see server.js: broadcast(), handle()).
// Keep them in sync with that file — the field names are the contract.

// MARK: - Shared payloads

/// One agent terminal, as it appears in `list` items and the `spawned` message.
public struct TerminalInfo: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public var name: String
    public var agentType: String?
    public var promptId: String?
    public var promptLabel: String?
    public var cwd: String?

    public init(id: String, name: String, agentType: String? = nil,
                promptId: String? = nil, promptLabel: String? = nil, cwd: String? = nil) {
        self.id = id; self.name = name; self.agentType = agentType
        self.promptId = promptId; self.promptLabel = promptLabel; self.cwd = cwd
    }
}

/// A role-prompt the server offers (id + label + spoken aliases). From `hello`.
public struct PromptInfo: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let aliases: [String]
}

/// The `hello` handshake the server sends on connect.
public struct Hello: Codable, Sendable {
    public var workdir: String?
    public var home: String?
    public var agentTypes: [String]
    public var prompts: [PromptInfo]
    public var names: [String]
}

// MARK: - Inbound (server → client)

/// Every message the server can push over the socket.
public enum ServerMessage: Sendable {
    case hello(Hello)
    case list([TerminalInfo])
    case spawned(TerminalInfo)
    case output(id: String, data: String)
    case exit(id: String, code: Int?)
    case routed(target: String, text: String, count: Int)
    case spawnError(message: String)
    case speaking(on: Bool, name: String?)
    case unknown(type: String)
}

extension ServerMessage: Decodable {
    private enum Keys: String, CodingKey {
        case type, terminals, id, data, code, target, text, count, message, on, name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(try Hello(from: decoder))
        case "list":
            self = .list(try c.decode([TerminalInfo].self, forKey: .terminals))
        case "spawned":
            // Fields sit at the top level alongside `type`; TerminalInfo ignores `type`.
            self = .spawned(try TerminalInfo(from: decoder))
        case "output":
            self = .output(id: try c.decode(String.self, forKey: .id),
                           data: try c.decodeIfPresent(String.self, forKey: .data) ?? "")
        case "exit":
            self = .exit(id: try c.decode(String.self, forKey: .id),
                         code: try c.decodeIfPresent(Int.self, forKey: .code))
        case "routed":
            self = .routed(target: (try? c.decode(String.self, forKey: .target)) ?? "all",
                           text: (try? c.decode(String.self, forKey: .text)) ?? "",
                           count: (try? c.decode(Int.self, forKey: .count)) ?? 0)
        case "spawn-error":
            self = .spawnError(message: (try? c.decode(String.self, forKey: .message)) ?? "spawn failed")
        case "speaking":
            self = .speaking(on: (try? c.decode(Bool.self, forKey: .on)) ?? false,
                             name: try c.decodeIfPresent(String.self, forKey: .name))
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - Outbound (client → server)

/// Every message the client can send. `encode` produces the exact `{type:…}`
/// shape `handle()` switches on in server.js.
public enum ClientMessage: Encodable, Sendable {
    case spawn(agentType: String?, name: String? = nil, cwd: String? = nil, prompt: String? = nil)
    case input(id: String, data: String)
    case command(target: String, text: String)
    case control(action: String, target: String)
    case resize(id: String, cols: Int, rows: Int)
    case kill(id: String)
    case rename(id: String, name: String)
    case clientlog(msg: String)
    case list

    // Dynamic string keys so we can build each message's exact field set.
    private struct Key: CodingKey {
        var stringValue: String; var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        func put<T: Encodable>(_ v: T, _ k: String) throws { try c.encode(v, forKey: Key(k)) }
        func putIf<T: Encodable>(_ v: T?, _ k: String) throws { if let v { try c.encode(v, forKey: Key(k)) } }

        switch self {
        case let .spawn(agentType, name, cwd, prompt):
            try put("spawn", "type")
            try putIf(agentType, "agentType"); try putIf(name, "name")
            try putIf(cwd, "cwd"); try putIf(prompt, "prompt")
        case let .input(id, data):
            try put("input", "type"); try put(id, "id"); try put(data, "data")
        case let .command(target, text):
            try put("command", "type"); try put(target, "target"); try put(text, "text")
        case let .control(action, target):
            try put("control", "type"); try put(action, "action"); try put(target, "target")
        case let .resize(id, cols, rows):
            try put("resize", "type"); try put(id, "id"); try put(cols, "cols"); try put(rows, "rows")
        case let .kill(id):
            try put("kill", "type"); try put(id, "id")
        case let .rename(id, name):
            try put("rename", "type"); try put(id, "id"); try put(name, "name")
        case let .clientlog(msg):
            try put("clientlog", "type"); try put(msg, "msg")
        case .list:
            try put("list", "type")
        }
    }
}

// MARK: - Control actions (must match CONTROL_SEQ in server.js)

public enum ControlAction: String, Sendable, CaseIterable {
    case interrupt, escape, enter, clear
}
