// Stable code-signing identity for apple-podcasts-sync's macOS permissions
// (#322), mirroring awc-agent/launchd/AwcAgentRunner.swift. TCC blocks a
// launchd-spawned bash from reading the Podcasts app's Group Container
// ("unable to open database file"), and grants follow the signed binary — so
// launchd runs this .app and Full Disk Access is granted to it alone, never
// to /bin/bash. One-shot: runs the wrapper and exits with its status.
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let script = "\(home)/Programming/reading-list-worktrees/reading-list/apple-podcasts-sync/launchd/run-sync.sh"

let process = Process()
process.executableURL = URL(fileURLWithPath: "/bin/bash")
process.arguments = [script]

var env = ProcessInfo.processInfo.environment
env["HOME"] = home
env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
process.environment = env

do {
    try process.run()
} catch {
    fputs("Failed to launch apple-podcasts-sync: \(error)\n", stderr)
    exit(1)
}
process.waitUntilExit()
exit(process.terminationStatus)
