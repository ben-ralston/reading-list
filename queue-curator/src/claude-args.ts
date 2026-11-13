// claude CLI invocation for one curation run. Same structural lockdown as
// awc-agent/src/claude-args.ts, minus Chrome: the session has no tools at
// all, so feed text in the prompt can at worst skew a ranking.
//   --restricted --tools ""  no built-in tools; user / project / local
//                            settings ignored;
//   --strict-mcp-config      no MCP servers (drops the claude.ai connectors);
//   --no-session-persistence the prompt (the owner's whole queue) is not saved as
//                            a session transcript.
export function buildClaudeArgs(opts: { model: string; schema: object; systemPrompt: string }): string[] {
  return [
    '--print', '--no-session-persistence',
    '--restricted', '--strict-mcp-config', '--tools', '',
    '--model', opts.model,
    '--permission-mode', 'dontAsk',
    '--max-turns', '3',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(opts.schema),
    '--append-system-prompt', opts.systemPrompt,
  ]
}

// Tool-enabled mode: the session can read and search
// its working folder, write there, and use the web. Probe-verified with these
// flags: reads and writes outside the working folder are refused, there is no
// shell, and the tool list is exactly AGENT_TOOLS.
//   --tools            names WebFetch explicitly, which --restricted would
//                      otherwise remove; no Bash or other code-running tool;
//   acceptEdits        writes inside the working folder need no prompt;
//   --allowedTools     the two web tools, which would otherwise be denied in
//                      --print (nobody is there to approve them).
export const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch']

export function buildAgentArgs(opts: { model: string; systemPrompt: string }): string[] {
  return [
    '--print', '--no-session-persistence',
    '--restricted', '--strict-mcp-config', '--tools', AGENT_TOOLS.join(','),
    '--allowedTools', 'WebSearch,WebFetch',
    '--model', opts.model,
    '--permission-mode', 'acceptEdits',
    '--max-turns', '80',
    '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', opts.systemPrompt,
  ]
}

// No secrets reach the child: only what the CLI needs to find its config and
// credentials (HOME, USER), binaries (PATH) and its temp directory.
export function buildChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  return {
    HOME: parent.HOME ?? '',
    PATH: parent.PATH ?? '/usr/bin:/bin',
    TMPDIR: parent.TMPDIR ?? '',
    USER: parent.USER ?? '',
  }
}
