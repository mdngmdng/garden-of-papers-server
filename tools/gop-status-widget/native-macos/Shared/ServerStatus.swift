import Foundation

struct ServerStatus: Sendable {
    let connected: Bool?
    let checkedAt: Date?
    static let unknown = ServerStatus(connected: nil, checkedAt: nil)
    var title: String { connected.map { $0 ? "Connected" : "Disconnected" } ?? "Not checked" }
    static func check() async -> ServerStatus {
        let url = URL(string: "https://garden-of-papers.ngrok.app/garden-server/health")!
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        struct Health: Decodable {
            struct Capabilities: Decodable {
                struct Workspace: Decodable { let protocolVersion: Int }
                let workspaceSync: Workspace
            }
            let status: String
            let capabilities: Capabilities
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let health = try? JSONDecoder().decode(Health.self, from: data),
                  health.status == "ok", health.capabilities.workspaceSync.protocolVersion == 2 else {
                return ServerStatus(connected: false, checkedAt: Date())
            }
            return ServerStatus(connected: true, checkedAt: Date())
        } catch {
            return ServerStatus(connected: false, checkedAt: Date())
        }
    }
}
