import { it } from '@effect/vitest'
import { Effect, type Schema } from 'effect'
import { describe, expect } from 'vitest'

import { DiscussionVisibilityPreference, type VisibilityMemento } from './DiscussionVisibility'

describe('workspace-backed discussion visibility', () => {
  it.effect(
    'defaults shown and restores only a confirmed saved choice',
    Effect.fnUntraced(function* () {
      let value: Schema.Json | undefined

      const storage: VisibilityMemento = {
        get: () => value,
        update: async (_key, next) => {
          value = next
        },
      }

      const first = new DiscussionVisibilityPreference(storage)
      expect(first.current()).toBe('shown')
      yield* first.toggle()
      expect(first.current()).toBe('hidden')
      expect(new DiscussionVisibilityPreference(storage).current()).toBe('hidden')
    }),
  )
  it.effect(
    'does not claim persistence on failure',
    Effect.fnUntraced(function* () {
      const preference = new DiscussionVisibilityPreference({
        get: () => undefined,
        update: async () => {
          throw new Error('disk unavailable')
        },
      })

      const exit = yield* preference.toggle().pipe(Effect.exit)
      expect(exit._tag).toBe('Failure')
      expect(preference.current()).toBe('shown')
    }),
  )
  it.effect(
    'keeps live windows independent but shares the last remembered workspace choice',
    Effect.fnUntraced(function* () {
      let value: Schema.Json | undefined

      const storage: VisibilityMemento = {
        get: () => value,
        update: async (_key, next) => {
          value = next
        },
      }

      const first = new DiscussionVisibilityPreference(storage)
      const duplicate = new DiscussionVisibilityPreference(storage)
      yield* first.toggle()
      expect(duplicate.current()).toBe('shown')
      expect(new DiscussionVisibilityPreference(storage).current()).toBe('hidden')
    }),
  )
})
