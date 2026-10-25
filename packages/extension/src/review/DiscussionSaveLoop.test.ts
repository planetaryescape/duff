import { it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { describe, expect } from 'vitest'

import { DiscussionSaveLoop, type DraftDocument } from './DiscussionSaveLoop'

describe('draft document save lane', () => {
  it.effect(
    'accepts newer bytes captured by the native save before writeFile starts',
    Effect.fnUntraced(function* () {
      let body = 'before native capture'
      let dirty = true
      let committed = ''

      const document: DraftDocument = {
        get isDirty() {
          return dirty
        },
        version: 1,
        getText: () => body,
        save: async () => {
          body = 'native captured latest'
          committed = body
          dirty = false

          return true
        },
      }

      yield* new DiscussionSaveLoop().flush(document, () => committed)
      expect(committed).toBe(document.getText())
    }),
  )
  it.effect(
    'acknowledges the old bytes before persisting edits made during save',
    Effect.fnUntraced(function* () {
      let announce: (() => void) | undefined

      const started = new Promise<void>((resolve) => {
        announce = resolve
      })

      let body = 'first'
      let version = 1
      let dirty = true
      let committed = ''
      const bodies: string[] = []

      const document: DraftDocument = {
        get isDirty() {
          return dirty
        },
        get version() {
          return version
        },
        getText: () => body,
        save: () => {
          const captured = body
          const capturedVersion = version

          return new Promise<boolean>((resolve) => {
            bodies.push(captured)

            if (bodies.length === 1) {
              announce?.()

              const complete = () => {
                committed = captured
                dirty = version !== capturedVersion
                resolve(true)
              }

              completion = complete
            } else {
              committed = captured
              dirty = version !== capturedVersion
              resolve(true)
            }
          })
        },
      }

      let completion: (() => void) | undefined
      const lane = new DiscussionSaveLoop()
      const saving = yield* lane.flush(document, () => committed).pipe(Effect.forkChild)
      yield* Effect.promise(() => started)
      body = 'newest'
      version++
      completion?.()
      yield* Fiber.join(saving)
      expect(bodies).toEqual(['first', 'newest'])
      expect(committed).toBe('newest')
      expect(dirty).toBe(false)
    }),
  )
  it.effect(
    'keeps a failed document dirty and rejects Send flushing',
    Effect.fnUntraced(function* () {
      const document: DraftDocument = {
        isDirty: true,
        version: 1,
        getText: () => 'unsaved',
        save: async () => false,
      }

      const exit = yield* new DiscussionSaveLoop().flush(document, () => '').pipe(Effect.exit)
      expect(exit._tag).toBe('Failure')
      expect(document.isDirty).toBe(true)
    }),
  )
})
