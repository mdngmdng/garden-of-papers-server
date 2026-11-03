import SwiftUI
import WidgetKit

@main
struct GOPServerApp: App {
    var body: some Scene {
        WindowGroup("GOP Server") {
            SetupView()
        }.windowResizability(.contentSize)
    }
}
struct SetupView: View {
    @State private var status = ServerStatus.unknown
    @State private var checking = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("GOP Server", systemImage: "server.rack").font(.title2.weight(.semibold))
            HStack(spacing: 9) {
                Circle().fill(status.connected == true ? Color.green : status.connected == false ? .red : .secondary).frame(width: 8, height: 8)
                Text(checking ? "Checking…" : status.title).font(.title3.weight(.medium))
                Spacer()
                Button("Check now") { Task { await refresh() } }.disabled(checking)
            }
            Divider()
            Text("Add the macOS widget").font(.headline)
            Text("Right-click your desktop → Edit Widgets…\nSearch for GOP Server, then add the small widget.")
                .font(.callout).foregroundStyle(.secondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
            Text("macOS schedules refreshes; checks may be delayed. Results older than 15 minutes show Needs refresh. A failed check can mean a server, tunnel, or network problem.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let checked = status.checkedAt { Text("Last checked: \(checked.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary) }
            HStack {
                Link("Open Garden of Papers ↗", destination: URL(string: "https://gardenofpapers.app/")!)
                Spacer()
                Button("Close") { NSApplication.shared.keyWindow?.close() }
            }.font(.callout)
        }
        .padding(24).frame(width: 380)
        .task { await refresh() }
        .onOpenURL { _ in Task { await refresh() } }
    }
    private func refresh() async {
        guard !checking else { return }
        checking = true
        status = await ServerStatus.check()
        WidgetCenter.shared.reloadTimelines(ofKind: "GOPServerConnection")
        checking = false
    }
}
