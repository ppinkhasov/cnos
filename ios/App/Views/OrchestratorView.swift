import SwiftUI
import CnosKit

/// The goal-driven orchestrator panel: set a goal, Start, and watch the lead +
/// workers loop. Mirrors the web Orchestrate panel (server.js orch* + app.js).
struct OrchestratorView: View {
    @ObservedObject var store: FleetStore
    @Environment(\.dismiss) private var dismiss

    @State private var goal = ""
    @State private var workerType = "claude"
    @State private var startWorkers = 3
    @State private var maxAgents = 8

    private var o: Orchestration { store.orchestration }
    private var running: Bool { o.running }
    private var resumable: Bool { o.resumable ?? false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    config
                    controls
                    if running || !o.fleet.isEmpty || !o.log.isEmpty { livePanel }
                }
                .padding(16)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Orchestrate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear(perform: seed)
        }
    }

    private var config: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("GOAL").font(.caption2.bold()).foregroundStyle(Theme.muted)
            TextField("e.g. build a tic-tac-toe web app with tests", text: $goal, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.plain)
                .padding(10)
                .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.border))
                .disabled(running)

            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("WORKERS").font(.caption2.bold()).foregroundStyle(Theme.muted)
                    Picker("", selection: $workerType) {
                        ForEach(store.agentTypes, id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.menu).disabled(running)
                }
                Stepper("start \(startWorkers)", value: $startWorkers, in: 1...12).disabled(running)
            }
            Stepper("max agents \(maxAgents)", value: $maxAgents, in: 2...16).disabled(running)
        }
        .font(.callout)
        .onChange(of: workerType) { _ in pushConfig() }
        .onChange(of: startWorkers) { _ in pushConfig() }
        .onChange(of: maxAgents) { _ in pushConfig() }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                if running {
                    bigButton("■ Stop", Theme.danger) { store.stopOrchestration() }
                } else {
                    bigButton(resumable ? "↻ Start fresh" : "▶ Start", Theme.accent) {
                        let g = goal.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !g.isEmpty else { store.notify("enter a goal first", isError: true); return }
                        store.startOrchestration(goal: g, workerType: workerType,
                                                 startWorkers: startWorkers, maxAgents: maxAgents)
                    }
                    if resumable {
                        bigButton("Resume", Theme.green) { store.resumeOrchestration() }
                    }
                }
            }
            Text(statusHint).font(.caption).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var livePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                stat("phase", o.status)
                stat("round", "\(o.round ?? 0)")
                stat("agents", "\(o.agents ?? 0)/\(o.maxAgents ?? 8)")
            }
            if !o.fleet.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("FLEET").font(.caption2.bold()).foregroundStyle(Theme.muted)
                    ForEach(o.fleet) { f in fleetRow(f) }
                }
            }
            if !o.log.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ACTIVITY").font(.caption2.bold()).foregroundStyle(Theme.muted)
                    ForEach(o.log.reversed()) { e in
                        HStack(alignment: .top, spacing: 6) {
                            Text(icon(e.kind)).font(.caption2)
                            Text(e.text).font(.caption2).foregroundStyle(Theme.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
    }

    private func fleetRow(_ f: FleetAgent) -> some View {
        HStack(spacing: 7) {
            Circle().fill(Theme.stateColor(f.state)).frame(width: 8, height: 8)
            Text(f.name).font(.system(.caption, design: .monospaced).bold())
            Text(f.role == "lead" ? "lead" : (f.agentType ?? "worker"))
                .font(.system(size: 9)).foregroundStyle(Theme.muted)
            Text(f.state).font(.system(size: 9)).foregroundStyle(Theme.stateColor(f.state))
            if let task = f.task, !task.isEmpty {
                Text(task).font(.system(size: 9)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9)).foregroundStyle(Theme.muted)
            Text(value).font(.caption.bold()).foregroundStyle(Theme.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bigButton(_ title: String, _ color: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 11)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.5)))
                .foregroundStyle(color).font(.headline)
        }
    }

    private var statusHint: String {
        switch o.status {
        case "briefing": return "spawning agents and briefing the lead…"
        case "running":  return "lead is delegating — agents working…"
        case "done":     return "✓ goal complete"
        case "stopped":  return resumable ? "stopped — Resume to continue (agents still running)" : "stopped"
        case "stalled":  return resumable ? "stalled — Resume to retry, or Start fresh" : "stalled"
        case "error":    return "error — see the activity feed"
        default:         return "set a goal, then Start — spawns a lead + workers and runs the loop"
        }
    }

    private func icon(_ kind: String) -> String {
        ["start": "▶", "resume": "↻", "assign": "➡", "lead": "🧠", "done": "✓",
         "spawn": "＋", "note": "·", "warn": "⚠", "stalled": "■", "stopped": "■", "error": "✕"][kind] ?? "·"
    }

    private func seed() {
        if goal.isEmpty { goal = o.goal ?? "" }
        if let wt = o.workerType { workerType = wt }
        if let sw = o.startWorkers { startWorkers = sw }
        if let ma = o.maxAgents { maxAgents = ma }
    }
    private func pushConfig() {
        guard !running else { return }
        store.pushOrchConfig(OrchConfig(goal: goal, workerType: workerType,
                                        startWorkers: startWorkers, maxAgents: maxAgents))
    }
}
