import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AttemptId, DraftId } from '@duff/core/discussion'
import { DiscussionDraftStore, Draft, type AttemptIntent } from '@duff/core/discussion-drafts'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect } from 'vitest'

import { makeDiscussionDraftStoreLayer } from './DiscussionDraftStore'
import { discussionFixture } from './DiscussionFixture'

function draftFixture(): Draft {
  const origin = discussionFixture()
  const change = origin.review.files[0]

  if (!change) throw new Error('Missing fixture change')

  return Draft.make({
    id: DraftId.make('draft-1'),
    key: origin.key,
    origin,
    version: 1,
    body: '',
    target: {
      _tag: 'NewThread',
      anchor: {
        comparison: origin.comparison,
        change,
        side: 'head',
        path: change.path,
        commit: origin.review.headCommit,
        range: { start: 1, end: 1 },
      },
    },
  })
}

function intentFixture(draft: Draft, id = 'attempt-1'): AttemptIntent {
  return { id: AttemptId.make(id), key: draft.key, input: { _tag: 'Draft', draft } }
}

describe('private discussion SQLite store', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duff-discussion-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const run = <A, E>(work: Effect.Effect<A, E, DiscussionDraftStore>) =>
    work.pipe(Effect.provide(makeDiscussionDraftStoreLayer(directory)))

  it.effect(
    'does not reacquire an acknowledged Dispatching reservation on late uncertainty',
    Effect.fnUntraced(function* () {
      const sender = yield* run(DiscussionDraftStore.use((store) => Effect.succeed(store)))
      const otherWindow = yield* run(DiscussionDraftStore.use((store) => Effect.succeed(store)))
      const draft = draftFixture()
      yield* sender.create(draft)
      const intent = intentFixture(draft)
      yield* sender.prepare(intent)
      yield* sender.dispatch(intent.id)
      yield* otherWindow.acknowledgeUncertain(intent.id)
      yield* sender.finish({ _tag: 'Uncertain', intent })

      expect(yield* otherWindow.getAttempt(intent.id)).toEqual(
        Option.some({ _tag: 'Uncertain', intent }),
      )
      expect((yield* otherWindow.listAll(Option.none())).attempts).toHaveLength(0)
      const replacement = intentFixture(draft, 'replacement-attempt')
      expect((yield* otherWindow.prepare(replacement))._tag).toBe('Prepared')
    }),
  )

  it.effect(
    'preserves a replacement reservation when the acknowledged sender finishes uncertain',
    Effect.fnUntraced(function* () {
      const sender = yield* run(DiscussionDraftStore.use((store) => Effect.succeed(store)))
      const otherWindow = yield* run(DiscussionDraftStore.use((store) => Effect.succeed(store)))
      const draft = draftFixture()
      yield* sender.create(draft)
      const old = intentFixture(draft)
      yield* sender.prepare(old)
      yield* sender.dispatch(old.id)
      yield* otherWindow.acknowledgeUncertain(old.id)
      const replacement = intentFixture(draft, 'replacement-attempt')
      yield* otherWindow.prepare(replacement)
      yield* sender.finish({ _tag: 'Uncertain', intent: old })

      expect(yield* sender.getAttempt(old.id)).toEqual(
        Option.some({ _tag: 'Uncertain', intent: old }),
      )
      expect((yield* sender.listAll(Option.none())).attempts).toEqual([
        { _tag: 'Prepared', intent: replacement },
      ])
      expect((yield* otherWindow.dispatch(replacement.id))._tag).toBe('Dispatching')
      const third = yield* sender.prepare(intentFixture(draft, 'third-attempt')).pipe(Effect.result)
      expect(third._tag).toBe('Failure')
    }),
  )

  it.effect(
    'rejects an old Prepared sender after acknowledgement and a new reservation',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))
      const old = intentFixture(draft)
      yield* run(DiscussionDraftStore.use((store) => store.prepare(old)))
      yield* run(DiscussionDraftStore.use((store) => store.acknowledgeUncertain(old.id)))
      const next = intentFixture(draft, 'replacement-attempt')
      yield* run(DiscussionDraftStore.use((store) => store.prepare(next)))

      const oldDispatch = yield* run(
        DiscussionDraftStore.use((store) => store.dispatch(old.id)).pipe(Effect.result),
      )

      expect(oldDispatch._tag).toBe('Failure')
      expect(yield* run(DiscussionDraftStore.use((store) => store.getAttempt(old.id)))).toEqual(
        Option.some({ _tag: 'Rejected', intent: old, reason: 'conflict' }),
      )
      expect((yield* run(DiscussionDraftStore.use((store) => store.dispatch(next.id))))._tag).toBe(
        'Dispatching',
      )
    }),
  )

  it.effect(
    'refuses dispatch of a Prepared row without its reservation',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))
      const intent = intentFixture(draft)
      yield* run(DiscussionDraftStore.use((store) => store.prepare(intent)))
      const database = new DatabaseSync(join(directory, 'discussion.sqlite'))
      database.prepare('UPDATE attempts SET reserved = 0 WHERE id = ?').run(intent.id)
      database.close()

      const result = yield* run(
        DiscussionDraftStore.use((store) => store.dispatch(intent.id)).pipe(Effect.result),
      )

      expect(result._tag).toBe('Failure')
    }),
  )

  it.effect(
    'recovers exact text and destination through a new store instance',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))

      const saved = yield* run(
        DiscussionDraftStore.use((store) =>
          store.save({ id: draft.id, expectedVersion: 1, body: 'Exact\nUnicode λ' }),
        ),
      )

      const recovered = yield* run(DiscussionDraftStore.use((store) => store.get(draft.id)))
      expect(recovered).toEqual(Option.some(saved))
      expect(saved.version).toBe(2)
      expect(saved.target).toEqual(draft.target)
      expect(statSync(join(directory, 'discussion.sqlite')).mode & 0o777).toBe(0o600)
      expect(statSync(directory).mode & 0o777).toBe(0o700)
    }),
  )

  it.effect(
    'admits one stale-version writer across independent store instances',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))

      const exits = yield* Effect.all(
        [
          run(
            DiscussionDraftStore.use((store) =>
              store.save({ id: draft.id, expectedVersion: 1, body: 'window A' }),
            ).pipe(Effect.exit),
          ),
          run(
            DiscussionDraftStore.use((store) =>
              store.save({ id: draft.id, expectedVersion: 1, body: 'window B' }),
            ).pipe(Effect.exit),
          ),
        ],
        { concurrency: 2 },
      )

      expect(exits.filter((exit) => exit._tag === 'Success')).toHaveLength(1)
      expect(exits.filter((exit) => exit._tag === 'Failure')).toHaveLength(1)
    }),
  )

  it.effect(
    'reserves one send and retains newer edits after confirmation',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))
      const intent = intentFixture(draft)
      yield* run(DiscussionDraftStore.use((store) => store.prepare(intent)))

      const conflict = yield* run(
        DiscussionDraftStore.use((store) => store.prepare(intentFixture(draft, 'attempt-2'))).pipe(
          Effect.exit,
        ),
      )

      expect(conflict._tag).toBe('Failure')
      yield* run(DiscussionDraftStore.use((store) => store.dispatch(intent.id)))

      const edited = yield* run(
        DiscussionDraftStore.use((store) =>
          store.save({ id: draft.id, expectedVersion: 1, body: 'newer text' }),
        ),
      )

      yield* run(
        DiscussionDraftStore.use((store) =>
          store.finish({
            _tag: 'Confirmed',
            intent,
            receipt: {
              _tag: 'Comment',
              commentId: '123',
              thread: Option.none(),
              providerPage: Option.none(),
              placement: 'verified',
            },
          }),
        ),
      )
      expect(yield* run(DiscussionDraftStore.use((store) => store.get(draft.id)))).toEqual(
        Option.some(edited),
      )
    }),
  )

  it.effect(
    'does not recreate a sent ID from a late save',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))
      const intent = intentFixture(draft)
      yield* run(DiscussionDraftStore.use((store) => store.prepare(intent)))
      yield* run(DiscussionDraftStore.use((store) => store.dispatch(intent.id)))
      yield* run(
        DiscussionDraftStore.use((store) =>
          store.finish({
            _tag: 'Confirmed',
            intent,
            receipt: {
              _tag: 'Comment',
              commentId: '123',
              thread: Option.none(),
              providerPage: Option.none(),
              placement: 'verified',
            },
          }),
        ),
      )
      expect(yield* run(DiscussionDraftStore.use((store) => store.get(draft.id)))).toEqual(
        Option.none(),
      )

      const late = yield* run(
        DiscussionDraftStore.use((store) =>
          store.save({ id: draft.id, expectedVersion: 1, body: 'late text' }),
        ).pipe(Effect.exit),
      )

      expect(late._tag).toBe('Failure')
    }),
  )

  it.effect(
    'keeps dispatch recovery conservative until explicit acknowledgement',
    Effect.fnUntraced(function* () {
      const draft = draftFixture()
      yield* run(DiscussionDraftStore.use((store) => store.create(draft)))
      const intent = intentFixture(draft)
      yield* run(DiscussionDraftStore.use((store) => store.prepare(intent)))
      yield* run(DiscussionDraftStore.use((store) => store.dispatch(intent.id)))

      const page = yield* run(
        DiscussionDraftStore.use((store) => store.list(draft.key, Option.none())),
      )

      expect(page.attempts[0]?._tag).toBe('Dispatching')

      const discard = yield* run(
        DiscussionDraftStore.use((store) =>
          store.discard({ id: draft.id, expectedVersion: 1 }),
        ).pipe(Effect.exit),
      )

      expect(discard._tag).toBe('Failure')
      yield* run(DiscussionDraftStore.use((store) => store.acknowledgeUncertain(intent.id)))
      expect(
        (yield* run(DiscussionDraftStore.use((store) => store.list(draft.key, Option.none()))))
          .attempts,
      ).toHaveLength(0)
      expect(yield* run(DiscussionDraftStore.use((store) => store.getAttempt(intent.id)))).toEqual(
        Option.some({ _tag: 'Dispatching', intent }),
      )
    }),
  )

  it.effect(
    'preserves unknown schemas and corrupted database bytes',
    Effect.fnUntraced(function* () {
      const file = join(directory, 'discussion.sqlite')
      const database = new DatabaseSync(file)
      database.exec('PRAGMA user_version = 99')
      database.close()
      const before = readFileSync(file)

      const unknown = yield* run(
        DiscussionDraftStore.use((store) => store.get(DraftId.make('unknown'))).pipe(Effect.exit),
      )

      expect(unknown._tag).toBe('Failure')
      expect(readFileSync(file)).toEqual(before)
      writeFileSync(file, 'corrupt preserved bytes')

      const corrupt = yield* run(
        DiscussionDraftStore.use((store) => store.get(DraftId.make('unknown'))).pipe(Effect.exit),
      )

      expect(corrupt._tag).toBe('Failure')
      expect(readFileSync(file, 'utf8')).toBe('corrupt preserved bytes')
    }),
  )
})
