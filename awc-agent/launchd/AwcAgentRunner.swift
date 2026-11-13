// Stable code-signing identity for awc-agent's macOS permissions (#317):
// ensure-chrome-profile.sh drives System Events, and TCC grants follow the
// signed binary, so launchd
// runs this .app instead of bash directly. Unlike the scheduled runners this
// one is a KeepAlive daemon, so it forwards SIGTERM (launchctl bootout /
// kickstart -k) to the child instead of leaving node running.
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let script = "\(home)/Programming/reading-list-worktrees/reading-list/awc-agent/launchd/run-agent.sh"

let process = Process()
process.executableURL = URL(fileURLWithPath: "/bin/bash")
process.arguments = [script]

var env = ProcessInfo.processInfo.environment
env["HOME"] = home
env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
// Prevent nested Claude session detection
env.removeValue(forKey: "CLAUDECODE")
env.removeValue(forKey: "CLAUDE_CODE")
process.environment = env

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler {
    process.terminate()
}
termSource.resume()

process.terminationHandler = { proc in
    exit(proc.terminationStatus)
}

do {
    try process.run()
} catch {
    fputs("Failed to launch awc-agent: \(error)\n", stderr)
    exit(1)
}
dispatchMain()
