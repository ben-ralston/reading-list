// claude CLI invocation for one conversion (#317).
//
// The agent reads adversarial web pages, so its session is locked down
// structurally rather than by deny-list:
//   --restricted --tools ""  no built-in tools at all (no Bash, file, web,
//                            agent-spawning or scheduling tools) and user /
//                            project / local settings are ignored, so no
//                            global allow rule can leak in;
//   --strict-mcp-config      no MCP servers except the --chrome integration
//                            (drops the claude.ai connectors: mail, Drive…);
//   --allowedTools           only the browser tools the AWC workflow needs.
// javascript_tool is never allowed — the AWC ToS forbids scripting its backend.
// Probe-verified 2026-10-04: with these flags the session's tool list is the
// claude-in-chrome set only, and dontAsk denies everything not allowed.
const CHROME = 'mcp__claude-in-chrome__'

export const ALLOWED_TOOLS = [
  'tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate',
  'read_page', 'get_page_text', 'find', 'computer', 'form_input',
].map((t) => CHROME + t)

export const DISALLOWED_TOOLS = [
  'javascript_tool', 'file_upload', 'upload_image', 'browser_batch', 'gif_creator',
  'shortcuts_execute', 'shortcuts_list', 'read_network_requests', 'read_console_messages',
  'select_browser', 'switch_browser', 'list_connected_browsers', 'resize_window',
].map((t) => CHROME + t)

// --settings is still honored under --restricted (probe-verified): the hook
// denies an off-allowlist navigate BEFORE it executes (src/nav-hook.ts).
export function buildClaudeArgs(opts: { systemPrompt: string; schema: object; navHookCommand: string }): string[] {
  const settings = {
    hooks: {
      // `|| exit 2`: Claude Code only blocks on exit 2, so a hook that fails
      // to start (exit 1/127) would otherwise ALLOW the navigation.
      PreToolUse: [{ matcher: CHROME + 'navigate', hooks: [{ type: 'command', command: `${opts.navHookCommand} || exit 2` }] }],
    },
  }
  return [
    '--print', '--chrome',
    '--restricted', '--strict-mcp-config', '--tools', '',
    '--settings', JSON.stringify(settings),
    '--model', 'opus',
    '--permission-mode', 'dontAsk',
    '--max-turns', '250',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(opts.schema),
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--append-system-prompt', opts.systemPrompt,
  ]
}

// No secrets reach the agent's process: only what the CLI needs to find its
// config/credentials (HOME, USER), binaries (PATH) and the Chrome bridge
// socket, which lives under the per-user TMPDIR (probe-verified: without
// TMPDIR the claude-in-chrome tools never connect).
// AWC_ALLOWED_HOSTS (not secret) feeds the navigation hook.
export function buildChildEnv(parent: NodeJS.ProcessEnv, allowedHosts: Iterable<string>): Record<string, string> {
  return {
    HOME: parent.HOME ?? '',
    PATH: parent.PATH ?? '/usr/bin:/bin',
    TMPDIR: parent.TMPDIR ?? '',
    USER: parent.USER ?? '',
    AWC_ALLOWED_HOSTS: [...allowedHosts].join(','),
  }
}
