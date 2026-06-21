import SwiftUI

@main
struct CnosApp: App {
    @StateObject private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .preferredColorScheme(.dark)
        }
    }
}

/// Persisted connection settings (the server URL the app talks to).
final class AppSettings: ObservableObject {
    @AppStorage("cnos.serverURL") var serverURLString: String = ""
    @AppStorage("cnos.workdir")   var workdir: String = ""   // chosen spawn dir ("" = server default)

    var serverURL: URL? {
        let s = serverURLString.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        // Accept "192.168.1.20:4173" or a full URL; default scheme http, port 4173.
        var str = s
        if !str.contains("://") { str = "http://" + str }
        guard var comps = URLComponents(string: str) else { return nil }
        if comps.port == nil { comps.port = 4173 }
        if comps.scheme == nil { comps.scheme = "http" }
        return comps.url
    }
}

/// Switches between the connect screen and the live fleet, rebuilding the store
/// whenever the target server changes.
struct RootView: View {
    @EnvironmentObject var settings: AppSettings
    @State private var store: FleetStore?

    var body: some View {
        Group {
            if let store {
                ContentView(store: store)
                    .id(store.client.serverURL)   // fresh view tree per server
            } else {
                ConnectView { url in
                    let s = FleetStore(serverURL: url, settings: settings)
                    s.connect()
                    store = s
                }
            }
        }
        .background(Theme.bg.ignoresSafeArea())
    }
}
