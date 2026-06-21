import SwiftUI
import UIKit
import Combine
import SwiftTerm

// Bridges a SwiftTerm `TerminalView` (a real native xterm emulator) into SwiftUI.
// Each agent's output bytes are fed in from the WebSocket; keystrokes typed into
// the terminal are sent back to the agent's PTY as `input` messages, and size
// changes propagate as `resize` so the remote PTY matches what's on screen.
struct AgentTerminalView: UIViewRepresentable {
    @ObservedObject var agent: AgentModel
    let store: FleetStore

    func makeCoordinator() -> Coordinator { Coordinator(agent: agent, store: store) }

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 220))
        tv.terminalDelegate = context.coordinator
        applyTheme(tv)
        tv.backgroundColor = UIColor(Theme.panel)
        // Replay this agent's scrollback so the card shows current state immediately.
        if !agent.history.isEmpty { tv.feed(text: agent.history) }
        context.coordinator.bind(to: tv)
        return tv
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        // Re-bind if SwiftUI handed us a different AgentModel for this slot.
        if context.coordinator.agent !== agent {
            context.coordinator.agent = agent
            context.coordinator.bind(to: uiView)
        }
    }

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        coordinator.cancellable?.cancel()
    }

    private func applyTheme(_ tv: TerminalView) {
        tv.nativeBackgroundColor = UIColor(Theme.panel)
        tv.nativeForegroundColor = UIColor(Theme.text)
        tv.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        var agent: AgentModel
        let store: FleetStore
        var cancellable: AnyCancellable?
        private weak var view: TerminalView?

        init(agent: AgentModel, store: FleetStore) {
            self.agent = agent
            self.store = store
        }

        /// Subscribe the view to this agent's live byte stream.
        func bind(to tv: TerminalView) {
            view = tv
            cancellable?.cancel()
            cancellable = agent.liveOutput
                .receive(on: RunLoop.main)
                .sink { [weak tv] data in tv?.feed(text: data) }
        }

        // MARK: TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            // Keystrokes / paste from the on-screen terminal → the agent's PTY.
            let s = String(decoding: data, as: UTF8.self)
            store.sendInput(s, to: agent.id)
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            store.resize(id: agent.id, cols: newCols, rows: newRows)
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) { UIPasteboard.general.string = s }
        }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
