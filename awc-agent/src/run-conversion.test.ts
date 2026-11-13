// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { runConversion, type ChildLike, type RunDeps } from './run-conversion'

const claim = { id: 4, kind: 'article' as const, contentItemId: 2, sourceUrl: 'https://ex.com/p', attempts: 1, title: 'Item Title', author: 'A', wordCount: 900 }
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolUse = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const success = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'url', episode_title: 'T', credits: 6, error: null } })
const maxTurns = JSON.stringify({ type: 'result', subtype: 'error_max_turns' })

// A fake child. `ignore` = signals it ignores (to simulate a wedged process).
function child(lines: string[], opts: { exit?: { code: number | null; signal: string | null }; hang?: boolean; ignore?: string[] } = {}) {
  let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {}
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
    resolveExit = r
  })
  const kill = vi.fn((signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
    if (!opts.ignore?.includes(signal)) resolveExit({ code: null, signal })
  })
  const stdout = (async function* () {
    for (const l of lines) yield l + '\n'
    if (!opts.hang) resolveExit(opts.exit ?? { code: 0, signal: null })
  })()
  const c: ChildLike = { stdout, exited, kill }
  return c as ChildLike & { kill: typeof kill }
}

function deps(over: Partial<RunDeps> = {}) {
  const chunks: string[] = []
  const d: RunDeps = {
    spawnClaude: vi.fn(() => child([assistant('AWC_STAGE: submitting_url'), assistant('AWC_STAGE: generating'), success])),
    ensureChrome: vi.fn().mockResolvedValue(undefined),
    onStage: vi.fn().mockResolvedValue(undefined),
    onRejectedStage: vi.fn(),
    onNavigationViolation: vi.fn(),
    openTranscript: vi.fn(() => ({ write: (c: string) => { chunks.push(c) }, close: vi.fn().mockResolvedValue(undefined) })),
    args: ['--print'],
    parentEnv: { HOME: '/h', PATH: '/bin', SUPABASE_SERVICE_ROLE_KEY: 'secret' },
    promptText: 'PROMPT',
    cwd: '/work',
    timeoutMs: 1000,
    killGraceMs: 10,
    ...over,
  }
  return Object.assign(d, { chunks })
}

describe('runConversion', () => {
  it('spawns claude with the scrubbed env + prompt on stdin, relays stages, streams the transcript', async () => {
    const d = deps()
    expect(await runConversion(claim, d)).toEqual({ outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 6 })
    expect(d.ensureChrome).toHaveBeenCalled()
    const [, env, stdin, cwd] = vi.mocked(d.spawnClaude).mock.calls[0]
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', TMPDIR: '', USER: '', AWC_ALLOWED_HOSTS: 'app.askwhocasts.com,askwhocasts.com,www.askwhocasts.com,ex.com,www.ex.com' })
    expect(stdin).toBe('PROMPT')
    expect(cwd).toBe('/work')
    expect(vi.mocked(d.onStage).mock.calls.map((c) => c[0])).toEqual(['submitting_url', 'generating'])
    expect(d.chunks.join('')).toContain('"type":"result"')
  })

  it('SIGTERMs a hung session at the timeout and fails it', async () => {
    const hung = child([], { hang: true })
    const d = deps({ spawnClaude: vi.fn(() => hung), timeoutMs: 20 })
    expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: null, error: 'agent timed out' })
    expect(hung.kill).toHaveBeenCalledWith('SIGTERM')
    expect(hung.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('escalates to SIGKILL and still returns when the child ignores every signal', async () => {
    const wedged = child([], { hang: true, ignore: ['SIGTERM', 'SIGKILL'] })
    const d = deps({ spawnClaude: vi.fn(() => wedged), timeoutMs: 20 })
    expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: null, error: 'agent timed out' })
    expect(wedged.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a non-zero exit (or an async spawn error) without a result as a failure', async () => {
    const d = deps({ spawnClaude: vi.fn(() => child([], { exit: { code: 1, signal: null } })) })
    expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: null, error: 'claude exited 1 without a result' })
    const e = deps({ spawnClaude: vi.fn(() => child([], { exit: { code: null, signal: 'spawn error: ENOENT' } })) })
    expect(await runConversion(claim, e)).toEqual({ outcome: 'failed', path: null, error: 'claude exited spawn error: ENOENT without a result' })
  })

  it('fails cleanly when claude cannot be spawned synchronously', async () => {
    const d = deps({ spawnClaude: vi.fn(() => { throw new Error('EACCES') }) })
    expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: null, error: 'agent could not start: EACCES' })
  })

  it('reports rejected stage markers', async () => {
    const d = deps({ spawnClaude: vi.fn(() => child([assistant('AWC_STAGE: done'), success])) })
    await runConversion(claim, d)
    expect(d.onRejectedStage).toHaveBeenCalledWith('done')
    expect(d.onStage).not.toHaveBeenCalled()
  })

  // #363: a failed cmd+c must not paste whatever the owner last copied into AWC.
  describe('clipboard guard', () => {
    const scriptRun = () => child([assistant('AWC_STAGE: submitting_url'), assistant('AWC_STAGE: building_script'), success])
    it('guards when the Script path starts and releases when the run ends', async () => {
      const release = vi.fn().mockResolvedValue(undefined)
      const guardClipboard = vi.fn().mockResolvedValue(release)
      const d = deps({ spawnClaude: vi.fn(scriptRun), guardClipboard })
      await runConversion(claim, d)
      expect(guardClipboard).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
    })
    it('leaves the clipboard alone on the URL path', async () => {
      const guardClipboard = vi.fn()
      await runConversion(claim, deps({ guardClipboard }))
      expect(guardClipboard).not.toHaveBeenCalled()
    })
    it('releases after a timeout too', async () => {
      const release = vi.fn().mockResolvedValue(undefined)
      const hung = child([assistant('AWC_STAGE: building_script')], { hang: true })
      await runConversion(claim, deps({ spawnClaude: vi.fn(() => hung), timeoutMs: 30, guardClipboard: vi.fn().mockResolvedValue(release) }))
      expect(release).toHaveBeenCalledTimes(1)
    })
    // Failing open would leave the clipboard intact for the agent to paste.
    it('stops the run when the clipboard could not be emptied', async () => {
      const running = child([assistant('AWC_STAGE: building_script')], { hang: true })
      const d = deps({ spawnClaude: vi.fn(() => running), guardClipboard: vi.fn().mockRejectedValue(new Error('no pbcopy')) })
      expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: 'script', error: 'could not empty the clipboard — stopped' })
      expect(running.kill).toHaveBeenCalledWith('SIGTERM')
    })
    it('escalates to SIGKILL if the child ignores SIGTERM after a clipboard failure', async () => {
      const wedged = child([assistant('AWC_STAGE: building_script')], { hang: true, ignore: ['SIGTERM'] })
      // A long timeout: the escalation must not wait for it.
      const d = deps({ spawnClaude: vi.fn(() => wedged), timeoutMs: 60_000, guardClipboard: vi.fn().mockRejectedValue(new Error('no pbcopy')) })
      expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: 'script', error: 'could not empty the clipboard — stopped' })
      expect(wedged.kill).toHaveBeenCalledWith('SIGKILL')
    })
    it('never waits forever on the release', async () => {
      const d = deps({ spawnClaude: vi.fn(scriptRun), guardClipboard: vi.fn().mockResolvedValue(() => new Promise<void>(() => {})) })
      expect((await runConversion(claim, d)).outcome).toBe('generating')
    })
    it('still returns the result when only the release fails', async () => {
      const releaseFails = deps({ spawnClaude: vi.fn(scriptRun), guardClipboard: vi.fn().mockResolvedValue(vi.fn().mockRejectedValue(new Error('x'))) })
      expect((await runConversion(claim, releaseFails)).outcome).toBe('generating')
    })
  })

  describe('coverage check (#363)', () => {
    const short = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'script', episode_title: 'T', credits: 5, reported_words: 3542, error: null } })
    it('flags a short episode without failing it: credits are spent and the episode will arrive', async () => {
      const d = deps({ spawnClaude: vi.fn(() => child([short])) })
      expect(await runConversion(claim, d)).toEqual({
        outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 5, reportedWords: 3542,
        warning: 'short episode: 5 credits for about 3,542 words',
      })
    })
    it('uses the claim word count when the agent reported no length', async () => {
      const noLength = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'url', episode_title: 'T', credits: 1, reported_words: null, error: null } })
      const d = deps({ spawnClaude: vi.fn(() => child([noLength])) })
      expect(await runConversion(claim, d)).toEqual({
        outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 1,
        warning: 'short episode: 1 credits for about 900 words',
      })
    })
    it('adds no warning to a run with enough credits', async () => {
      expect(await runConversion(claim, deps())).not.toHaveProperty('warning')
    })
  })

  describe('after Generate was clicked (credits spent)', () => {
    it('records a max-turns stop as generating, never failed (no paid Retry)', async () => {
      const d = deps({ spawnClaude: vi.fn(() => child([assistant('AWC_STAGE: submitting_url'), assistant('AWC_STAGE: building_script'), assistant('AWC_STAGE: generating'), maxTurns])) })
      expect(await runConversion(claim, d)).toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'Item Title', credits: null })
    })
    it('records a timeout after the generating marker as generating on the url path', async () => {
      const hung = child([assistant('AWC_STAGE: submitting_url'), assistant('AWC_STAGE: generating')], { hang: true })
      const d = deps({ spawnClaude: vi.fn(() => hung), timeoutMs: 30 })
      expect(await runConversion(claim, d)).toEqual({ outcome: 'generating', path: 'url', episodeTitle: 'Item Title', credits: null })
    })
  })

  describe('comments runs (#368)', () => {
    const commentsClaim = { ...claim, kind: 'comments' as const, sourceUrl: 'https://www.lesswrong.com/posts/a/b#comments', wordCount: null }
    const session = (over = {}) => ({ fill: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined), ...over })
    const scriptDeps = (prepare = vi.fn().mockResolvedValue(session())) => ({
      script: { episodeTitle: 'Comments: T', words: 9000, prepare },
    })
    const scriptStage = assistant('AWC_STAGE: building_script')

    it('empties the clipboard before Chrome or the agent start, so an early paste finds nothing', async () => {
      const order: string[] = []
      const prepare = vi.fn(async () => { order.push('prepare'); return session() })
      const d = deps({
        ...scriptDeps(prepare),
        ensureChrome: vi.fn(async () => { order.push('chrome') }),
        spawnClaude: vi.fn(() => { order.push('spawn'); return child([success]) }),
      })
      await runConversion(commentsClaim, d)
      expect(order).toEqual(['prepare', 'chrome', 'spawn'])
    })
    it('places the script only at the stage marker, just before the paste', async () => {
      const s = session()
      await runConversion(commentsClaim, deps({ ...scriptDeps(vi.fn().mockResolvedValue(s)), spawnClaude: vi.fn(() => child([success])) }))
      expect(s.fill).not.toHaveBeenCalled()
      const s2 = session()
      await runConversion(commentsClaim, deps({ ...scriptDeps(vi.fn().mockResolvedValue(s2)), spawnClaude: vi.fn(() => child([scriptStage, success])) }))
      expect(s2.fill).toHaveBeenCalledTimes(1)
      expect(s2.release).toHaveBeenCalledTimes(1)
    })
    it('never starts the agent when the clipboard can not be set up', async () => {
      const d = deps(scriptDeps(vi.fn().mockRejectedValue(new Error('no pbcopy'))))
      expect(await runConversion(commentsClaim, d)).toEqual({ outcome: 'failed', path: 'script', error: 'could not use the clipboard — stopped' })
      expect(d.spawnClaude).not.toHaveBeenCalled()
      expect(d.ensureChrome).not.toHaveBeenCalled()
    })
    it('stops the agent when the script can not be placed', async () => {
      const running = child([scriptStage], { hang: true })
      const s = session({ fill: vi.fn().mockRejectedValue(new Error('no pbcopy')) })
      const d = deps({ ...scriptDeps(vi.fn().mockResolvedValue(s)), spawnClaude: vi.fn(() => running) })
      expect(await runConversion(commentsClaim, d)).toEqual({ outcome: 'failed', path: 'script', error: 'could not use the clipboard — stopped' })
      expect(running.kill).toHaveBeenCalledWith('SIGTERM')
      expect(s.release).toHaveBeenCalledTimes(1)
    })
    it('releases after a timeout', async () => {
      const s = session()
      await runConversion(commentsClaim, deps({ ...scriptDeps(vi.fn().mockResolvedValue(s)), spawnClaude: vi.fn(() => child([], { hang: true })), timeoutMs: 20 }))
      expect(s.release).toHaveBeenCalledTimes(1)
    })
    it('leaves stage-triggered guarding to article runs', async () => {
      const guardClipboard = vi.fn()
      await runConversion(commentsClaim, deps({ ...scriptDeps(), guardClipboard, spawnClaude: vi.fn(() => child([scriptStage, success])) }))
      expect(guardClipboard).not.toHaveBeenCalled()
    })
    it('allows navigation to Askwho Casts only', async () => {
      const d = deps(scriptDeps())
      await runConversion(commentsClaim, d)
      expect(vi.mocked(d.spawnClaude).mock.calls[0][1].AWC_ALLOWED_HOSTS).toBe('app.askwhocasts.com,askwhocasts.com,www.askwhocasts.com')
    })
    it('stops a session that navigates to LessWrong', async () => {
      const running = child([toolUse('mcp__claude-in-chrome__navigate', { url: 'https://www.lesswrong.com/' })], { hang: true })
      expect(await runConversion(commentsClaim, deps({ ...scriptDeps(), spawnClaude: vi.fn(() => running) }))).toEqual({
        outcome: 'failed', path: null, error: 'agent tried to open www.lesswrong.com — stopped',
      })
    })
    it('records the comments title when a crash follows Generate', async () => {
      const d = deps({ ...scriptDeps(), spawnClaude: vi.fn(() => child([scriptStage, assistant('AWC_STAGE: generating'), maxTurns])) })
      expect(await runConversion(commentsClaim, d)).toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'Comments: T', credits: null })
    })
    // Step 2 found the episode in the Library, so the marker came without
    // building_script, and then the session died before its result.
    it('records path script when a crash follows an already-in-Library report', async () => {
      const d = deps({ ...scriptDeps(), spawnClaude: vi.fn(() => child([assistant('AWC_STAGE: generating'), maxTurns])) })
      expect(await runConversion(commentsClaim, d)).toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'Comments: T', credits: null })
    })
    // A link-less episode only attaches to a path='script' row, whatever the model said.
    it('records path script whatever the agent reported', async () => {
      const d = deps({ ...scriptDeps(), spawnClaude: vi.fn(() => child([success])) })
      expect(await runConversion(commentsClaim, d)).toMatchObject({ outcome: 'generating', path: 'script' })
    })
    // The session read strangers' comments, and this title decides what attaches.
    it('stores the title the daemon set, and reports a different one from the agent', async () => {
      const onTitleMismatch = vi.fn()
      const d = deps({ ...scriptDeps(), onTitleMismatch, spawnClaude: vi.fn(() => child([success])) })
      expect(await runConversion(commentsClaim, d)).toMatchObject({ episodeTitle: 'Comments: T' })
      expect(onTitleMismatch).toHaveBeenCalledTimes(1)
    })
    it('stays quiet when the agent reports the same title', async () => {
      const same = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'script', episode_title: 'comments: t', credits: 80, reported_words: null, error: null } })
      const onTitleMismatch = vi.fn()
      await runConversion(commentsClaim, deps({ ...scriptDeps(), onTitleMismatch, spawnClaude: vi.fn(() => child([same])) }))
      expect(onTitleMismatch).not.toHaveBeenCalled()
    })
    it('judges a short episode by the script length', async () => {
      const short = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'script', episode_title: 'Comments: T', credits: 5, reported_words: null, error: null } })
      const d = deps({ ...scriptDeps(), spawnClaude: vi.fn(() => child([short])) })
      expect(await runConversion(commentsClaim, d)).toMatchObject({ warning: 'short episode: 5 credits for about 9,000 words' })
    })
  })

  describe('navigation guard', () => {
    it('kills the session when the agent navigates off Askwho Casts / the item host', async () => {
      const running = child([toolUse('mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/' })], { hang: true })
      const d = deps({ spawnClaude: vi.fn(() => running) })
      expect(await runConversion(claim, d)).toEqual({ outcome: 'failed', path: null, error: 'agent tried to open mail.google.com — stopped' })
      expect(running.kill).toHaveBeenCalledWith('SIGTERM')
      expect(d.onNavigationViolation).toHaveBeenCalledWith('mail.google.com')
    })
    it('lets allowed navigations through', async () => {
      const d = deps({ spawnClaude: vi.fn(() => child([
        toolUse('mcp__claude-in-chrome__navigate', { url: 'https://app.askwhocasts.com/' }),
        toolUse('mcp__claude-in-chrome__navigate', { url: 'https://ex.com/p' }),
        success,
      ])) })
      expect((await runConversion(claim, d)).outcome).toBe('generating')
      expect(d.onNavigationViolation).not.toHaveBeenCalled()
    })
  })
})
