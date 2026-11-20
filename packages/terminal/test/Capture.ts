import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TestRendererSetup } from '@opentui/core/testing'
import { Effect } from 'effect'

export const captureEvidence = Effect.fn('TerminalEvidence.capture')(function* (
  directory: string | undefined,
  name: string,
  view: TestRendererSetup,
) {
  if (!directory) return
  yield* Effect.promise(async () => {
    await view.renderOnce()
    const frame = view.captureSpans()

    const captured = {
      cols: frame.cols,
      rows: frame.rows,
      cursor: frame.cursor,
      lines: frame.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          text: span.text,
          width: span.width,
          attributes: span.attributes,
          fg: { r: span.fg.r, g: span.fg.g, b: span.fg.b, a: span.fg.a },
          bg: { r: span.bg.r, g: span.bg.g, b: span.bg.b, a: span.bg.a },
        })),
      })),
    }

    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name}.json`), JSON.stringify(captured))
    await writeFile(join(directory, `${name}.txt`), view.captureCharFrame())
  })
})
