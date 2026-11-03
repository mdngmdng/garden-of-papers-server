import SwiftUI
import WidgetKit
import AppIntents

let widgetKind = "GOPServerConnection"
struct ConnectionEntry: TimelineEntry {
    let date: Date
    let status: ServerStatus
    var stale = false
}
struct ConnectionProvider: TimelineProvider {
    func placeholder(in context: Context) -> ConnectionEntry {
        ConnectionEntry(date: Date(), status: .unknown)
    }
    func getSnapshot(in context: Context, completion: @escaping (ConnectionEntry) -> Void) {
        Task { completion(ConnectionEntry(date: Date(), status: await ServerStatus.check())) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ConnectionEntry>) -> Void) {
        Task {
            let status = await ServerStatus.check()
            let now = Date()
            // Future entry expires the result; never predict future availability.
            let entries = [ConnectionEntry(date: now, status: status),
                           ConnectionEntry(date: now.addingTimeInterval(15 * 60), status: status, stale: true)]
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(5 * 60))))
        }
    }
}
struct RefreshConnection: AppIntent {
    static var title: LocalizedStringResource = "Check server connection"
    static var description = IntentDescription("Request a new GOP server connection check.")
    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        return .result()
    }
}
struct ConnectionView: View {
    let entry: ConnectionEntry
    var color: Color {
        if entry.stale || entry.status.connected == nil { return .secondary }
        return entry.status.connected == true ? .green : .red
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("GOP SERVER").font(.system(size: 10, weight: .semibold)).tracking(0.7).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Button(intent: RefreshConnection()) {
                    Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .medium))
                }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Check server connection")
            }
            Spacer(minLength: 12)
            Image(systemName: entry.stale ? "clock" : entry.status.connected == true ? "checkmark.circle.fill" : entry.status.connected == false ? "exclamationmark.circle.fill" : "ellipsis.circle")
                .font(.system(size: 23, weight: .medium)).foregroundStyle(color)
                .widgetAccentable()
            Text(entry.stale ? "Needs refresh" : entry.status.title)
                .font(.system(size: 20, weight: .semibold)).tracking(-0.5)
                .minimumScaleFactor(0.7).lineLimit(1).padding(.top, 8)
            Spacer(minLength: 10)
            if let checked = entry.status.checkedAt {
                HStack(spacing: 4) {
                    Text(entry.stale ? "Last checked" : "Checked")
                    Text(checked, style: .time)
                }.font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            } else {
                Text("Waiting for a check").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "gopstatus://refresh"))
        .accessibilityElement(children: .contain)
    }
}
@main
struct GOPServerWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: widgetKind, provider: ConnectionProvider()) { entry in
            ConnectionView(entry: entry)
        }
        .configurationDisplayName("GOP Server")
        .description("Server connection and last check time. macOS controls refresh timing.")
        .supportedFamilies([.systemSmall])
    }
}
