import SwiftUI
import CnosKit

/// Folder browser backed by GET /api/dirs — picks the directory new agents spawn
/// into. Mirrors the web cwd picker; the choice persists via AppSettings.
struct WorkdirPickerView: View {
    @ObservedObject var store: FleetStore
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    @State private var listing: DirListing?
    @State private var typed = ""
    @State private var loading = false
    @State private var message = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    TextField("~/dev/project", text: $typed)
                        .textFieldStyle(.plain).font(.system(.callout, design: .monospaced))
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .padding(9).background(Theme.panel2, in: RoundedRectangle(cornerRadius: 8))
                        .onSubmit { Task { await load(typed) } }
                    Button("Go") { Task { await load(typed) } }
                }
                .padding(12)

                if loading { ProgressView().padding() }
                if !message.isEmpty { Text(message).font(.caption).foregroundStyle(Theme.muted).padding(.bottom, 6) }

                List {
                    if let parent = listing?.parent {
                        Button { Task { await load(parent) } } label: {
                            Label("..", systemImage: "arrow.up").foregroundStyle(Theme.accent)
                        }
                    }
                    ForEach(listing?.dirs ?? [], id: \.self) { name in
                        Button { Task { await load(joined(name)) } } label: {
                            Label(name, systemImage: "folder").foregroundStyle(Theme.text)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Spawn directory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use this folder") { useCurrent() }.bold()
                }
            }
            .task { await load(store.currentWorkdir) }
        }
    }

    private func joined(_ name: String) -> String {
        let base = (listing?.path ?? "").hasSuffix("/") ? String((listing?.path ?? "").dropLast()) : (listing?.path ?? "")
        return base + "/" + name
    }

    private func load(_ path: String?) async {
        loading = true; message = ""
        if let l = await store.listDirs(path) {
            listing = l; typed = l.path
            if l.dirs.isEmpty { message = "(no subfolders here)" }
        } else {
            message = "couldn't open that folder"
        }
        loading = false
    }

    private func useCurrent() {
        let chosen = listing?.path ?? typed.trimmingCharacters(in: .whitespaces)
        settings.workdir = chosen
        store.notify("📁 new agents will spawn in \(chosen.split(separator: "/").last.map(String.init) ?? chosen)")
        dismiss()
    }
}
