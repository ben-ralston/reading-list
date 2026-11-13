// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createClipboardGuard, createScriptClipboard } from './clipboard'

function fakeClipboard(initial: string) {
  let value = initial
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (text: string) => { value = text }),
    current: () => value,
  }
}

describe('createClipboardGuard (#363)', () => {
  it('empties the clipboard, so a failed copy pastes nothing rather than a password', async () => {
    const clip = fakeClipboard('hunter2')
    await createClipboardGuard(clip)()
    expect(clip.current()).toBe('')
  })
  it('puts the original text back when released', async () => {
    const clip = fakeClipboard('hunter2')
    const release = await createClipboardGuard(clip)()
    await clip.write('the whole article')
    await release()
    expect(clip.current()).toBe('hunter2')
  })
})

describe('createScriptClipboard (#368)', () => {
  it('empties first and places the script only when asked', async () => {
    const clip = fakeClipboard('hunter2')
    const session = await createScriptClipboard(clip, 'the script')()
    expect(clip.current()).toBe('')
    await session.fill()
    expect(clip.current()).toBe('the script')
  })
  it('restores the original when the script is still there', async () => {
    const clip = fakeClipboard('hunter2')
    const session = await createScriptClipboard(clip, 'the script')()
    await session.fill()
    await session.release()
    expect(clip.current()).toBe('hunter2')
  })
  it('restores the original when the run never reached the fill', async () => {
    const clip = fakeClipboard('hunter2')
    await (await createScriptClipboard(clip, 'the script')()).release()
    expect(clip.current()).toBe('hunter2')
  })
  it('leaves alone anything copied during the run', async () => {
    const clip = fakeClipboard('hunter2')
    const session = await createScriptClipboard(clip, 'the script')()
    await session.fill()
    await clip.write('copied just now')
    await session.release()
    expect(clip.current()).toBe('copied just now')
  })
})
