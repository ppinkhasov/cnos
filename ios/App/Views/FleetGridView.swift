import SwiftUI
import CnosKit

/// Scrolling grid of agent cards — one column on a phone, more on iPad.
struct FleetGridView: View {
    @ObservedObject var store: FleetStore
    @ObservedObject var voice: VoiceController

    private let columns = [GridItem(.adaptive(minimum: 360), spacing: 10)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(store.agents) { agent in
                    AgentCardView(agent: agent, store: store)
                }
            }
            .padding(10)
        }
        .background(Theme.bg)
    }
}

struct AgentCardView: View {
    @ObservedObject var agent: AgentModel
    let store: FleetStore

    private var isTarget: Bool { store.target == agent.name }

    var body: some View {
        VStack(spacing: 0) {
            header
            AgentTerminalView(agent: agent, store: store)
                .frame(minHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(8)
                .opacity(agent.exited ? 0.55 : 1)
        }
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(borderColor, lineWidth: agent.routedFlash || isTarget ? 2 : 1)
        )
        .animation(.easeOut(duration: 0.2), value: agent.routedFlash)
        .contentShape(Rectangle())
        .onTapGesture { store.target = agent.name }
    }

    private var borderColor: Color {
        if agent.routedFlash { return Theme.accent }
        if isTarget { return Theme.accent.opacity(0.7) }
        return Theme.border
    }

    private var header: some View {
        HStack(spacing: 7) {
            Text(agent.name).font(.system(.subheadline, design: .monospaced).bold())
                .foregroundStyle(Theme.text)
            Text(agent.type).font(.caption2.bold())
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.typeColor(agent.type).opacity(0.18), in: Capsule())
                .foregroundStyle(Theme.typeColor(agent.type))
            if !agent.badge.isEmpty {
                Text(agent.badge).font(.caption2.bold())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Theme.yellow.opacity(0.18), in: Capsule())
                    .foregroundStyle(Theme.yellow)
            }
            Spacer(minLength: 4)
            controls
        }
        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
    }

    private var controls: some View {
        HStack(spacing: 12) {
            ctrl("stop.fill", Theme.danger) { store.client.control(.interrupt, target: agent.name) }
            ctrl("delete.left", Theme.muted) { store.client.control(.clear, target: agent.name) }
            ctrl("return", Theme.muted) { store.client.control(.enter, target: agent.name) }
            ctrl("xmark.circle", Theme.muted) { store.kill(id: agent.id) }
        }
        .font(.system(size: 15))
    }

    private func ctrl(_ icon: String, _ color: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon) }
            .foregroundStyle(color)
            .buttonStyle(.plain)
    }
}
