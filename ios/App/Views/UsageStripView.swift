import SwiftUI
import CnosKit

/// The per-provider rate-limit / balance strip (GET /api/usage), horizontally
/// scrollable. Read-only, like the web meter.
struct UsageStripView: View {
    let usage: UsageData

    private let shown = ["claude", "codex", "deepseek"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(providers) { p in chip(p) }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .background(Theme.panel)
    }

    private var providers: [UsageData.Provider] {
        (usage.providers ?? []).filter { shown.contains($0.id) }
    }

    private func chip(_ p: UsageData.Provider) -> some View {
        HStack(spacing: 6) {
            Text(p.label).font(.caption2.bold()).foregroundStyle(Theme.text)
            if let balances = p.balances, !balances.isEmpty {
                ForEach(Array(balances.enumerated()), id: \.offset) { _, b in
                    Text(currency(b.total, b.currency)).font(.caption2).foregroundStyle(Theme.green)
                }
            } else if let windows = p.windows, !windows.isEmpty {
                ForEach(Array(windows.enumerated()), id: \.offset) { _, w in
                    HStack(spacing: 3) {
                        Text(winLabel(w.key)).font(.system(size: 9)).foregroundStyle(Theme.muted)
                        Text("\(Int(w.usedPercent))%")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(level(w.usedPercent))
                    }
                }
                if p.live == true {
                    Text("● live").font(.system(size: 9)).foregroundStyle(Theme.green)
                }
            } else {
                Text(p.reason ?? "n/a").font(.system(size: 9)).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(Theme.panel2, in: Capsule())
        .overlay(Capsule().stroke(Theme.border))
        .opacity(p.available == false ? 0.5 : 1)
    }

    private func winLabel(_ key: String) -> String {
        ["5h": "5h", "7d": "7d", "7d_opus": "opus"][key] ?? key
    }
    private func level(_ pct: Double) -> Color {
        pct >= 80 ? Theme.danger : pct >= 50 ? Theme.yellow : Theme.green
    }
    private func currency(_ v: Double, _ code: String) -> String {
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = code
        return f.string(from: NSNumber(value: v)) ?? "\(v) \(code)"
    }
}
