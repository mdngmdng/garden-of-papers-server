# GOP Server — native macOS desktop widget

Built with SwiftUI + WidgetKit for macOS 14 or newer (Apple Silicon and Intel).

## Add to the desktop

1. Open `GOP Server.app` once.
2. Right-click an empty area of the desktop → Edit Widgets….
3. Search for **GOP Server** and add the small widget.

It displays the public GOP endpoint status and last check time using the system's widget background, typography and light/dark appearance. The refresh button requests a new check; clicking the widget opens its companion app. The companion app does not need to stay open for WidgetKit to run.

WidgetKit controls refresh scheduling: the extension requests a check after 5 minutes, but macOS may delay it. A scheduled entry marks results older than 15 minutes as **Needs refresh**, instead of presenting an old result as current. This is not a guaranteed one-minute monitor. A failed request can mean server, tunnel, or network failure; this health check does not independently verify MongoDB or AI jobs.

Default endpoint: `https://garden-of-papers.ngrok.app/garden-server/health`.

## Build

Requires Xcode and XcodeGen:

```sh
xcodegen generate
xcodebuild -project GOPStatusNative.xcodeproj -scheme GOPServer -configuration Release -derivedDataPath build CODE_SIGN_IDENTITY=- build
```

Install the resulting `build/Build/Products/Release/GOP Server.app` in `~/Applications`, then open it. The local build uses ad-hoc signing and is not notarized for public distribution. Configure your Apple distribution signing before distributing outside this development machine.
