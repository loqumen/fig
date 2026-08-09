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
let LOG_PATH = "/tmp/figd.log"

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

// Node is resolved by one file only: the staged node-resolve.sh the wrappers
// source. The installer asks THAT, instead of keeping a second, narrower copy
// of the search here -- two lists drift, and a disagreement between them is
// exactly how a user ends up told Node is fine while the daemon cannot find it.
func nodeFound() -> Bool {
    let script = support.appendingPathComponent("node-resolve.sh").path
    guard fm.fileExists(atPath: script) else { return false }
    return run("/bin/bash", ["-c", ". '\(script)' && fig_resolve_node"]) == 0
}

func logTail(_ path: String, lines: Int = 12) -> String {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return "" }
    let rows = text.split(separator: "\n", omittingEmptySubsequences: false)
        .map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    return rows.suffix(lines).joined(separator: "\n")
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
for exe in ["fig-host", "figd-run", "node-resolve.sh"] {
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
  <key>StandardOutPath</key><string>\(LOG_PATH)</string>
  <key>StandardErrorPath</key><string>\(LOG_PATH)</string>
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

// Start from an empty log so the tail shown below belongs to this run and not
// to some failure from three installs ago.
try? "".write(toFile: LOG_PATH, atomically: true, encoding: .utf8)

if run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistURL.path]) != 0 {
    run("/bin/launchctl", ["load", "-w", plistURL.path])                 // older macOS
}

// ---- 4. report ------------------------------------------------------------
// Poll instead of sleeping once. The old code waited a flat 1.2s and called it
// a failure, which is shorter than a cold Node start on a slower machine -- so
// a companion that was coming up fine still got reported as broken.
var up = false
for _ in 0..<40 {                                                        // ~12s worst case
    if run("/usr/bin/curl", ["-s", "-o", "/dev/null", "--max-time", "2",
                             "http://127.0.0.1:41414/"]) == 0 { up = true; break }
    Thread.sleep(forTimeInterval: 0.3)
}

let a = NSAlert()
if up {
    a.alertStyle = .informational
    a.messageText = "Fig Companion is running"
    a.informativeText = "Registered with: \(registered.isEmpty ? "no Chromium browser found" : registered.joined(separator: ", "))."
        + "\n\nAdd the Fig extension to your browser, then press ⌥⇧F on any page. There is no token to paste."
} else if !nodeFound() {
    a.alertStyle = .warning
    a.messageText = "Fig Companion is installed, but Node.js was not found"
    a.informativeText = """
        Fig runs on Node 18 or newer, which also ships with Claude Code. \
        Install Claude Code (or Node from nodejs.org), then open Fig Companion again.

        If Node is already installed somewhere unusual, point Fig at it and reopen this app:

            mkdir -p ~/.fig && command -v node > ~/.fig/node-path
        """
} else {
    // Node resolves but nothing answered on the port. Show the log rather than
    // naming a file the user then has to go find, which is what happened the
    // first time this alert shipped.
    let tail = logTail(LOG_PATH)
    a.alertStyle = .warning
    a.messageText = "Fig Companion installed, but did not start"
    a.informativeText = tail.isEmpty
        ? "Nothing was written to \(LOG_PATH), which usually means the background agent never launched. "
          + "Open Fig Companion again; if it repeats, send this to whoever shared Fig with you."
        : "The companion log says:\n\n\(tail)"
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Copy Log")
}
let choice = a.runModal()
if choice == .alertSecondButtonReturn {
    let text = logTail(LOG_PATH, lines: 200)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text.isEmpty ? "(\(LOG_PATH) is empty)" : text, forType: .string)
}
