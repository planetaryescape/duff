import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { AttemptId, DraftId, ThreadId } from '../pull-requests/Discussion'
import { discussionFixture, anchorFixture } from '../pull-requests/testing/DiscussionFixtures'
import {
  AttemptIntent,
  Draft,
  DraftEnvelope,
  transitionAttempt,
  type Attempt,
} from './DiscussionDrafts'

const origin = discussionFixture()

const draft = Draft.make({
  id: DraftId.make('draft'),
  key: origin.key,
  origin,
  target: { _tag: 'NewThread', anchor: anchorFixture(origin) },
  version: 1,
  body: '',
})

it.effect(
  'rejects persisted drafts with a changed destination, invalid version or oversized UTF-8 body',
  () =>
    Effect.gen(function* () {
      for (const input of [
        { ...draft, key: { ...draft.key, pullRequestId: '43' } },
        { ...draft, version: 0 },
        { ...draft, version: Number.MAX_SAFE_INTEGER + 1 },
        { ...draft, body: 'é'.repeat(32769) },
        {
          ...draft,
          target: {
            _tag: 'Reply',
            thread: {
              discussion: { ...origin.key, pullRequestId: '43' },
              id: ThreadId.make('thread'),
            },
          },
        },
      ])
        expect((yield* Schema.decodeUnknownEffect(Draft)(input).pipe(Effect.result))._tag).toBe(
          'Failure',
        )
      const codec = Schema.toCodecJson(DraftEnvelope)
      const encoded = yield* Schema.encodeEffect(codec)({ version: 1, value: draft })
      expect(yield* Schema.decodeUnknownEffect(codec)(encoded)).toEqual({
        version: 1,
        value: draft,
      })
    }),
)

it.effect('requires resolution attempt identity and discussion to match its journal intent', () =>
  Effect.gen(function* () {
    const input = {
      id: AttemptId.make('attempt'),
      key: origin.key,
      input: {
        _tag: 'Resolution',
        command: {
          attempt: AttemptId.make('other-attempt'),
          thread: { discussion: origin.key, id: ThreadId.make('thread') },
          expected: { _tag: 'Open', detail: 'unresolved' },
          desired: 'resolved',
        },
      },
    }

    expect((yield* Schema.decodeUnknownEffect(AttemptIntent)(input).pipe(Effect.result))._tag).toBe(
      'Failure',
    )
  }),
)

it.effect('allows only forward attempt transitions with an unchanged immutable intent', () =>
  Effect.gen(function* () {
    const intent = AttemptIntent.make({
      id: AttemptId.make('attempt'),
      key: origin.key,
      input: { _tag: 'Draft', draft },
    })

    const prepared: Attempt = { _tag: 'Prepared', intent }
    const dispatching: Attempt = { _tag: 'Dispatching', intent }
    expect((yield* transitionAttempt(prepared, dispatching))._tag).toBe('Dispatching')
    expect((yield* transitionAttempt(dispatching, { _tag: 'Uncertain', intent }))._tag).toBe(
      'Uncertain',
    )
    expect(yield* transitionAttempt(dispatching, prepared).pipe(Effect.flip)).toMatchObject({
      reason: 'conflict',
    })
    expect(
      yield* transitionAttempt({ _tag: 'Uncertain', intent }, dispatching).pipe(Effect.flip),
    ).toMatchObject({ reason: 'conflict' })
    expect(
      yield* transitionAttempt(prepared, {
        _tag: 'Dispatching',
        intent: { ...intent, id: AttemptId.make('different') },
      }).pipe(Effect.flip),
    ).toMatchObject({ reason: 'conflict' })
  }),
)
