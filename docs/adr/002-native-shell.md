# ADR-002 — Independent SwiftUI/WKWebView shell

Status: accepted, 2026-09-13.

Source: [Apple WKWebView API](https://developer.apple.com/documentation/webkit/wkwebview).
SwiftUI with WebKit on macOS 14 is feasible for this shape of app; that does not
prove performance or packaging.

Choose a new Swift package targeting macOS 14+, serving the built Suri web assets
from its separately owned loopback host. Window close/app quit leave host work
alive; explicit Quit Host is separate. Native bridge is limited to picker/open
and bootstrap; no DOM injection of scripts. Startup progress,
connection failure and web-process termination get a native recoverable surface.

Alternatives: Electron would bundle another browser and add a distribution/update
boundary not required by this local app. Tauri adds Rust and another bridge
stack. Browser-only cannot complete the accepted native product. No invented
memory benchmark is used as justification.

Consequences: Node and native SQLite/PTY/locking helper assets must match packaged
architecture and be tested in the .app. The shell builds as a local ad-hoc signed artifact; v0.1 does not install
itself, register launchd or notarize.
WebKit and actual native shell checks both required. Pi is an external verified
runtime selection; bundling/updating it is not a shell responsibility.
