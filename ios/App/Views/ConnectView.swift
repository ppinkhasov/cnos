import SwiftUI

/// First screen: point the app at a running cnos server (your Mac's LAN IP).
struct ConnectView: View {
    @EnvironmentObject var settings: AppSettings
    let onConnect: (URL) -> Void

    @State private var text = ""
    @State private var error: String?

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            VStack(spacing: 6) {
                Text("cnos").font(.system(size: 44, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.accent)
                Text("command your fleet of agents")
                    .font(.callout).foregroundStyle(Theme.muted)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("SERVER").font(.caption2.bold()).foregroundStyle(Theme.muted)
                TextField("192.168.1.20:4173", text: $text)
                    .textFieldStyle(.plain)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .padding(12)
                    .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border))
                    .onSubmit(connect)

                if let error {
                    Text(error).font(.caption).foregroundStyle(Theme.danger)
                }

                Button(action: connect) {
                    Text("Connect").frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 10))
                        .foregroundStyle(Color.black).font(.headline)
                }
                Text("Run `npm start` in the cnos repo on your Mac, then enter its LAN address. Voice + agents run on that host; this app is the terminal.")
                    .font(.caption2).foregroundStyle(Theme.muted)
            }
            .padding(18)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.border))
            .frame(maxWidth: 460)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .onAppear { if text.isEmpty { text = settings.serverURLString } }
    }

    private func connect() {
        settings.serverURLString = text
        guard let url = settings.serverURL else {
            error = "Enter host:port, e.g. 192.168.1.20:4173"
            return
        }
        error = nil
        onConnect(url)
    }
}
