# GOP Status

A small always-on-top desktop widget for macOS and Windows. It checks the public GOP health endpoint **once per minute**, including the ngrok connection. Check now performs an immediate check. Closing/hiding the window leaves monitoring running in the menu bar/system tray; Quit stops it.

The first failed check is amber; two consecutive failed checks are red. A red result means the endpoint is unreachable, not definitive proof that the server process is stopped. Network outages also cause failures. Optional alerts notify once per outage and once on recovery. Checks stop while the computer sleeps and resume on wake. This is not an independent 24-hour monitoring service.

On the server computer, local monitoring checks port 5002 separately to help distinguish public tunnel failure from a local server failure. It is enabled on first launch only if a local GOP server is detected. Remote Windows/Mac users should leave it off. The existing health API verifies the GOP process response; it does not independently verify MongoDB, PDF downloads, or AI jobs.

## Run

- macOS: open `GOP Status.app` from the Mac ZIP.
- Windows x64: extract the **entire** Windows ZIP and run `GOP Status.exe` inside it. Keep the accompanying files in the same folder. No Node.js installation is needed.
- Settings: configure the public HTTPS health endpoint, local monitoring, and connection alerts. Preferences and window position are saved in Electron's per-user app data directory. Credentials are not required.

The builds are currently unsigned/unnotarized development distributions. Signing/notarization for public distribution is not configured. Windows packages can be built on this Mac, but runtime validation requires Windows.

## Develop and package

```sh
npm ci
npm test
npm start
npm run build:mac
npm run build:windows
```

For Intel Macs: `npx electron-builder --mac zip --x64 --publish never`.

The widget is independent of the GOP server runtime. No server restart, server API change, Netlify deployment, or new paid service is required. No automatic login/startup setting is changed.

## Compact version (1.1)

The cross-platform window is now 260 × 128 with neutral light/dark styling. Its primary status is the last public health check (Connected / Disconnected); detailed local status is available on hover. Settings temporarily expands the window. Alerts still require two failures. The native macOS WidgetKit version is in `native-macos/`; it can be added through Edit Widgets but follows macOS refresh scheduling instead of the one-minute desktop-app timer.
