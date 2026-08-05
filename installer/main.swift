import AppKit
import Foundation

// Fig Companion installer/launcher.
//
// One double-click does everything the old Terminal step did: it stages the
// companion into Application Support, registers the native messaging host with
// every Chromium browser found, installs a LaunchAgent so the companion runs at
// login, and starts it. Native messaging is what removes the token step — the
// browser only lets the extension IDs listed below talk to the host.

let EXTENSION_IDS = [
    "lifccpiojocfhbmomkbdobgknhjimhbm"   // stable dev id (load-unpacked)
    // Web Store id is appended here once the listing is published.
]
let HOST_NAME = "com.loqumen.fig"
let AGENT_LABEL = "com.loqumen.figd"

let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let support = home.appendingPathComponent("Library/Application Support/Fig", isDirectory: true)

func die(_ msg: String) -> Never {
    let a = NSAlert()
    a.alertStyle = .critical
    a.messageText = "Fig Companion could not finish setting up"
    a.informativeText = msg
    a.runModal()
    exit(1)
}

func nodeFound() -> Bool {
    let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    if candidates.contains(where: { fm.isExecutableFile(atPath: $0) }) { return true }
    let nvm = home.appendingPathComponent(".nvm/versions/node")
    if let vs = try? fm.contentsOfDirectory(atPath: nvm.path) {
        for v in vs where fm.isExecutableFile(atPath: nvm.appendingPathComponent("\(v)/bin/node").path) { return true }
    }
    return false
}

@discardableResult
func run(_ launch: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launch)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
    return p.terminationStatus
}

// ---- 1. stage the payload -------------------------------------------------
guard let res = Bundle.main.resourceURL?.appendingPathComponent("payload", isDirectory: true),
      fm.fileExists(atPath: res.path) else { die("The app bundle is missing its payload.") }

try? fm.createDirectory(at: support, withIntermediateDirectories: true)
for f in (try? fm.contentsOfDirectory(atPath: res.path)) ?? [] {
    let dst = support.appendingPathComponent(f)
    try? fm.removeItem(at: dst)
    do { try fm.copyItem(at: res.appendingPathComponent(f), to: dst) }
    catch { die("Could not write to \(support.path): \(error.localizedDescription)") }
}
for exe in ["fig-host", "figd-run"] {
    try? fm.setAttributes([.posixPermissions: 0o755],
                          ofItemAtPath: support.appendingPathComponent(exe).path)
}

// ---- 2. register the native messaging host with each browser --------------
let origins = EXTENSION_IDS.map { "\"chrome-extension://\($0)/\"" }.joined(separator: ",\n    ")
let hostManifest = """
{
  "name": "\(HOST_NAME)",
  "description": "Fig companion bridge",
  "path": "\(support.appendingPathComponent("fig-host").path)",
  "type": "stdio",
  "allowed_origins": [
    \(origins)
  ]
}
"""
let browserDirs = [
    "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary",
    "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser-Beta",
    "Microsoft Edge", "Chromium", "Vivaldi", "Arc",
]
var registered: [String] = []
for b in browserDirs {
    let base = home.appendingPathComponent("Library/Application Support/\(b)", isDirectory: true)
    guard fm.fileExists(atPath: base.path) else { continue }   // browser not installed
    let dir = base.appendingPathComponent("NativeMessagingHosts", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let target = dir.appendingPathComponent("\(HOST_NAME).json")
    if (try? hostManifest.write(to: target, atomically: true, encoding: .utf8)) != nil {
        registered.append(b.components(separatedBy: "/").last ?? b)
    }
}

// ---- 3. LaunchAgent so the companion is always running --------------------
let agents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
try? fm.createDirectory(at: agents, withIntermediateDirectories: true)
let plistURL = agents.appendingPathComponent("\(AGENT_LABEL).plist")
let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>\(AGENT_LABEL)</string>
  <key>ProgramArguments</key>
  <array><string>\(support.appendingPathComponent("figd-run").path)</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/figd.log</string>
  <key>StandardErrorPath</key><string>/tmp/figd.log</string>
</dict>
</plist>
"""
try? plist.write(to: plistURL, atomically: true, encoding: .utf8)

let uid = getuid()

// Migrate off any earlier hand-installed agent. Two copies would fight over
// port 41414 and KeepAlive would thrash restarting the loser.
for legacy in ["com.bradytinnin.figd"] {
    run("/bin/launchctl", ["bootout", "gui/\(uid)/\(legacy)"])
    let old = agents.appendingPathComponent("\(legacy).plist")
    if fm.fileExists(atPath: old.path) {
        let parked = agents.appendingPathComponent("\(legacy).plist.replaced-by-fig-companion")
        try? fm.removeItem(at: parked)
        try? fm.moveItem(at: old, to: parked)
    }
}

run("/bin/launchctl", ["bootout", "gui/\(uid)/\(AGENT_LABEL)"])          // ignore if absent
if run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistURL.path]) != 0 {
    run("/bin/launchctl", ["load", "-w", plistURL.path])                 // older macOS
}

// ---- 4. report ------------------------------------------------------------
Thread.sleep(forTimeInterval: 1.2)
let up = run("/usr/bin/curl", ["-s", "-o", "/dev/null", "--max-time", "2", "http://127.0.0.1:41414/"]) == 0

let a = NSAlert()
if !nodeFound() {
    a.alertStyle = .warning
    a.messageText = "Fig Companion is installed, but Node.js was not found"
    a.informativeText = "Fig runs on Node, which also ships with Claude Code. Install Claude Code (or Node 18+), then open Fig Companion again."
} else if up {
    a.alertStyle = .informational
    a.messageText = "Fig Companion is running"
    a.informativeText = "Registered with: \(registered.isEmpty ? "no Chromium browser found" : registered.joined(separator: ", "))."
        + "\n\nAdd the Fig extension to your browser, then press ⌥⇧F on any page. There is no token to paste."
} else {
    a.alertStyle = .warning
    a.messageText = "Fig Companion installed, but did not start"
    a.informativeText = "Check /tmp/figd.log for details, then open Fig Companion again."
}
a.runModal()
