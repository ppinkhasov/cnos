import SwiftUI
import CnosKit

/// Bottom command bar: pick a target (an agent or everyone) and type a command,
/// mirroring the web client's routing bar. Quick interrupt button included.
struct CommandBar: View {
    @ObservedObject var store: FleetStore
    @ObservedObject var voice: VoiceController
    @Binding var command: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Divider().overlay(Theme.border)
            HStack(spacing: 8) {
                targetMenu

                TextField("message \(label(store.target))…", text: $command)
                    .textFieldStyle(.plain)
                    .font(.system(.body, design: .monospaced))
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.border))

                if command.isEmpty {
                    Button { store.sendControl(.interrupt) } label: {
                        Image(systemName: "stop.fill")
                    }.foregroundStyle(Theme.danger).font(.system(size: 18))
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 24))
                    }.foregroundStyle(Theme.accent)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Theme.panel)
        }
    }

    private var targetMenu: some View {
        Menu {
            Button { store.target = "all" } label: { Label("everyone", systemImage: "person.3") }
            ForEach(store.activeNames, id: \.self) { name in
                Button(name) { store.target = name }
            }
        } label: {
            HStack(spacing: 3) {
                Text(label(store.target)).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .font(.caption.bold())
            .padding(.horizontal, 9).padding(.vertical, 8)
            .background(Theme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
            .foregroundStyle(Theme.accent)
            .frame(maxWidth: 120)
        }
    }

    private func label(_ t: String) -> String { t == "all" ? "everyone" : t }

    private func send() {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.sendCommand(text)
        command = ""
    }
}
