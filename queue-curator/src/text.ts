// One clean line from text that feeds or the model control. Strips ASCII and
// C1 control characters (terminal escapes), bidi overrides and zero-width
// characters, then collapses whitespace. Used for anything printed or shown.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g

export function oneLine(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
}
