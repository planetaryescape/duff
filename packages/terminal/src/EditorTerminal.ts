import { EmbeddedTerminalRenderable, KeyEvent } from '@opentui/core'

const punctuation = new Map([
  ['[', 'BracketLeft'],
  [']', 'BracketRight'],
  ['\\', 'Backslash'],
  [';', 'Semicolon'],
  ["'", 'Quote'],
  [',', 'Comma'],
  ['.', 'Period'],
  ['/', 'Slash'],
  ['`', 'Backquote'],
  ['-', 'Minus'],
  ['=', 'Equal'],
])

function physicalCode(name: string): string | undefined {
  if (/^[a-z]$/i.test(name)) return `Key${name.toUpperCase()}`

  if (/^[0-9]$/.test(name)) return `Digit${name}`

  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(name)) return name.toUpperCase()

  return punctuation.get(name)
}

export class EditorTerminal extends EmbeddedTerminalRenderable {
  override handleKeyPress(key: KeyEvent): boolean {
    return super.handleKeyPress(
      new KeyEvent({
        name: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        option: key.option,
        sequence: key.sequence,
        number: key.number,
        raw: key.raw,
        eventType: key.eventType,
        source: key.source,
        code: physicalCode(key.name),
        baseCode: key.baseCode,
        super: key.super,
        hyper: key.hyper,
        capsLock: key.capsLock,
        numLock: key.numLock,
        repeated: key.repeated,
      }),
    )
  }
}
