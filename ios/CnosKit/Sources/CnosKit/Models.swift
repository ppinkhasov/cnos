import Foundation

// REST payload models for the server's HTTP endpoints (server.js: /api/usage,
// /api/dirs). Lenient (mostly optional) so a shape tweak never hard-fails decode.

/// `GET /api/usage` — the per-provider rate-limit / balance strip.
public struct UsageData: Codable, Sendable {
    public var providers: [Provider]?

    public struct Provider: Codable, Sendable, Identifiable, Hashable {
        public let id: String
        public var label: String
        public var available: Bool?
        public var live: Bool?
        public var planType: String?
        public var reason: String?
        public var asOf: String?
        public var creditAvailable: Bool?
        public var windows: [Window]?
        public var balances: [Balance]?
    }
    public struct Window: Codable, Sendable, Hashable {
        public var key: String
        public var label: String
        public var usedPercent: Double
        public var resetsAt: String?
    }
    public struct Balance: Codable, Sendable, Hashable {
        public var total: Double
        public var currency: String
    }
}

/// `GET /api/dirs?path=` — one level of the working-directory picker.
public struct DirListing: Codable, Sendable {
    public var path: String
    public var parent: String?
    public var home: String?
    public var dirs: [String]
}
