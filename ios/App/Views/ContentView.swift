import SwiftUI
import CnosKit

struct ContentView: View {
    @ObservedObject var store: FleetStore
    @EnvironmentObject var settings: AppSettings
    @StateObject private var voice: VoiceController

    @State private var showOrchestrator = false
    @State private var showWorkdir = false
    @State private var command = ""

    init(store: FleetStore) {
        self.store = store
        _voice = StateObject(wrappedValue: VoiceController(store: store))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if store.usage?.providers?.isEmpty == false { UsageStripView(usage: store.usage!) }
            Divider().overlay(Theme.border)

            if store.agents.isEmpty {
                emptyState
            } else {
                FleetGridView(store: store, voice: voice)
            }

            CommandBar(store: store, voice: voice, command: $command)
        }
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .top) { noticeBanner }
        .sheet(isPresented: $showOrchestrator) { OrchestratorView(store: store) }
        .sheet(isPresented: $showWorkdir) { WorkdirPickerView(store: store).environmentObject(settings) }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Circle().fill(store.connected ? Theme.green : (store.connecting ? Theme.yellow : Theme.danger))
                    .frame(width: 9, height: 9)
                Text("cnos").font(.system(.headline, design: .monospaced)).foregroundStyle(Theme.accent)
                Text(store.client.serverURL.host ?? "")
                    .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                Spacer()
                micButton
                Button { showOrchestrator = true } label: {
                    Image(systemName: "circle.grid.cross").font(.system(size: 18))
                }.foregroundStyle(store.orchestration.running ? Theme.green : Theme.text)
            }

            HStack(spacing: 8) {
                addMenu
                Button { showWorkdir = true } label: {
                    Label(workdirLabel, systemImage: "folder")
                        .font(.caption).lineLimit(1)
                }
                .buttonStyle(ChipButtonStyle())
                Spacer()
                if store.orchestration.running {
                    Text("orchestrating · \(store.orchestration.status)")
                        .font(.caption2).foregroundStyle(Theme.green).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .background(Theme.panel)
    }

    private var workdirLabel: String {
        if let w = store.currentWorkdir { return w.split(separator: "/").last.map(String.init) ?? "~" }
        return "~"
    }

    private var addMenu: some View {
        Menu {
            ForEach(store.agentTypes, id: \.self) { type in
                Button { store.spawn(type: type) } label: { Label("New \(type)", systemImage: "plus") }
            }
            if !store.prompts.isEmpty {
                Menu("With role…") {
                    ForEach(store.prompts) { p in
                        Button(p.label) { store.spawn(type: store.agentTypes.first ?? "claude", prompt: p.id) }
                    }
                }
            }
        } label: {
            Label("Add", systemImage: "plus.circle.fill").font(.subheadline.bold())
        }
        .buttonStyle(ChipButtonStyle(prominent: true))
    }

    private var micButton: some View {
        Button { voice.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: voice.isOn ? (voice.state == .muted ? "mic.slash.fill" : "mic.fill") : "mic")
                if voice.isOn {
                    LevelMeter(level: voice.level).frame(width: 30, height: 8)
                }
            }
            .font(.system(size: 16))
        }
        .foregroundStyle(voice.state == .denied || voice.state == .unavailable ? Theme.danger
                         : voice.isOn ? Theme.green : Theme.text)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "terminal").font(.system(size: 44)).foregroundStyle(Theme.muted)
            Text("No agents yet").font(.headline).foregroundStyle(Theme.text)
            Text("Tap **Add** to spawn one, or say “new terminal”.")
                .font(.callout).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    @ViewBuilder private var noticeBanner: some View {
        if let n = store.notice {
            Text(n.text)
                .font(.caption).foregroundStyle(n.isError ? Theme.danger : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.panel2, in: Capsule())
                .overlay(Capsule().stroke(Theme.border))
                .padding(.top, 4)
                .shadow(radius: 6, y: 2)
                .transition(.move(edge: .top).combined(with: .opacity))
                .id(n.id)
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                        if store.notice?.id == n.id { withAnimation { store.notice = nil } }
                    }
                }
        }
    }
}

/// Small horizontal audio level bar.
struct LevelMeter: View {
    let level: Double   // 0–100
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.panel2)
                Capsule().fill(Theme.green)
                    .frame(width: max(2, geo.size.width * level / 100))
            }
        }
    }
}

struct ChipButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(prominent ? Theme.accent.opacity(0.18) : Theme.panel2,
                        in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(prominent ? Theme.accent.opacity(0.5) : Theme.border))
            .foregroundStyle(prominent ? Theme.accent : Theme.text)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
