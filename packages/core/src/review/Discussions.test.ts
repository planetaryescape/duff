import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from 'effect'

import {
  AttemptId,
  DraftId,
  DraftStorageError,
  type ProviderDiscussion,
  ProviderReceipt,
  DiscussionWriteUncertain,
  DiscussionWriteRejected,
  DiscussionReview,
  discussionPolicy,
} from '../pull-requests/Discussion'
import { ProviderUnavailable } from '../pull-requests/GitHostingProvider'
import { PullRequests } from '../pull-requests/PullRequests'
import { anchorFixture, discussionFixture } from '../pull-requests/testing/DiscussionFixtures'
import { BranchReview } from './BranchReview'
import {
  Attempt,
  DiscussionDraftStore,
  DiscussionIds,
  Draft,
  DraftRecoveryPage,
} from './DiscussionDrafts'
import { Discussions } from './Discussions'

const review = discussionFixture()

const draft = Draft.make({
  id: DraftId.make('draft'),
  key: review.key,
  target: { _tag: 'NewThread', anchor: anchorFixture(review) },
  origin: review,
  version: 1,
  body: 'saved body',
})

const receipt = ProviderReceipt.make({
  _tag: 'Comment',
  commentId: '1',
  thread: Option.none(),
  providerPage: Option.none(),
  placement: 'verified',
})

const unexpected = () => Effect.die('Unexpected operation')

const RecoveryCursor = Schema.fromJsonString(
  Schema.Struct({
    offset: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
)

const makeStore = () => {
  const drafts = new Map<DraftId, Draft>([[draft.id, draft]])
  const attempts = new Map<AttemptId, Attempt>()
  const reserved = new Set<string>()

  const target = (attempt: Attempt) =>
    attempt.intent.input._tag === 'Draft'
      ? attempt.intent.input.draft.id
      : attempt.intent.input.command.thread.id

  const store = DiscussionDraftStore.of({
    listAll: (cursor) =>
      Effect.gen(function* () {
        const offset = Option.isSome(cursor)
          ? (yield* Schema.decodeUnknownEffect(RecoveryCursor)(cursor.value).pipe(
              Effect.mapError(() => new DraftStorageError({ reason: 'invalid' })),
            )).offset
          : 0

        const entries: ReadonlyArray<Draft | Attempt> = [
          ...drafts.values(),
          ...[...attempts.values()].filter(
            (attempt) =>
              attempt._tag === 'Prepared' ||
              attempt._tag === 'Dispatching' ||
              attempt._tag === 'Uncertain',
          ),
        ]

        const selected = entries.slice(offset, offset + discussionPolicy.draftPageSize)

        const next =
          entries.length > offset + selected.length
            ? Option.some(
                yield* Schema.encodeEffect(RecoveryCursor)({
                  offset: offset + selected.length,
                }).pipe(Effect.mapError(() => new DraftStorageError({ reason: 'invalid' }))),
              )
            : Option.none<string>()

        return DraftRecoveryPage.make({
          drafts: selected.filter((entry) => 'id' in entry),
          attempts: selected.filter((entry) => 'intent' in entry),
          next,
        })
      }),
    list: () =>
      Effect.sync(() => ({
        drafts: [...drafts.values()],
        attempts: [...attempts.values()].map((attempt) =>
          attempt._tag === 'Dispatching'
            ? Attempt.make({ _tag: 'Uncertain', intent: attempt.intent })
            : attempt,
        ),
        next: Option.none(),
      })),
    get: (id) => Effect.sync(() => Option.fromUndefinedOr(drafts.get(id))),
    create: (value) =>
      Effect.sync(() => {
        drafts.set(value.id, value)

        return value
      }),
    save: (input) =>
      Effect.gen(function* () {
        const value = drafts.get(input.id)

        if (!value || value.version !== input.expectedVersion)
          return yield* new DraftStorageError({ reason: 'conflict' })

        const saved = Draft.make({
          id: value.id,
          key: value.key,
          target: value.target,
          origin: value.origin,
          version: value.version + 1,
          body: input.body,
        })

        drafts.set(saved.id, saved)

        return saved
      }),
    discard: (input) =>
      Effect.gen(function* () {
        const value = drafts.get(input.id)

        if (!value || value.version !== input.expectedVersion || reserved.has(input.id))
          return yield* new DraftStorageError({ reason: 'conflict' })
        drafts.delete(input.id)
      }),
    prepare: (intent) =>
      Effect.gen(function* () {
        const attempt = Attempt.make({ _tag: 'Prepared', intent })
        const key = target(attempt)

        if (reserved.has(key)) return yield* new DraftStorageError({ reason: 'busy' })

        if (
          intent.input._tag === 'Draft' &&
          drafts.get(intent.input.draft.id)?.version !== intent.input.draft.version
        )
          return yield* new DraftStorageError({ reason: 'conflict' })
        reserved.add(key)
        attempts.set(intent.id, attempt)

        return attempt
      }),
    dispatch: (id) =>
      Effect.gen(function* () {
        const value = attempts.get(id)

        if (value?._tag !== 'Prepared') return yield* new DraftStorageError({ reason: 'conflict' })
        const attempt = Attempt.make({ _tag: 'Dispatching', intent: value.intent })
        attempts.set(id, attempt)

        return attempt
      }),
    finish: (attempt) =>
      Effect.gen(function* () {
        const previous = attempts.get(attempt.intent.id)

        if (!previous || !['Prepared', 'Dispatching'].includes(previous._tag))
          return yield* new DraftStorageError({ reason: 'conflict' })
        attempts.set(attempt.intent.id, attempt)

        if (attempt._tag === 'Rejected' || attempt._tag === 'Confirmed')
          reserved.delete(target(attempt))

        if (attempt._tag === 'Confirmed' && attempt.intent.input._tag === 'Draft') {
          const sent = attempt.intent.input.draft

          if (drafts.get(sent.id)?.version === sent.version) drafts.delete(sent.id)
        }
      }),
    getAttempt: (id) => Effect.sync(() => Option.fromUndefinedOr(attempts.get(id))),
    acknowledgeUncertain: (id) =>
      Effect.gen(function* () {
        const attempt = attempts.get(id)

        if (!attempt || !['Dispatching', 'Uncertain'].includes(attempt._tag))
          return yield* new DraftStorageError({ reason: 'conflict' })
        reserved.delete(target(attempt))
      }),
  })

  return { store, attempts, drafts }
}

const makeLayer = (provider: ProviderDiscussion, store: DiscussionDraftStore['Service']) => {
  let count = 0

  return Discussions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          PullRequests,
          PullRequests.of({
            discussion: () => Effect.succeed(provider),
            discover: () => Stream.empty,
            resolve: unexpected,
            loadMore: unexpected,
            connect: unexpected,
          }),
        ),
        Layer.succeed(
          BranchReview,
          BranchReview.of({
            branches: unexpected,
            compare: unexpected,
            prepare: () => Effect.succeed(review.review),
            read: () => Effect.succeed('line\n'),
            comparisons: () =>
              Effect.succeed([
                {
                  change:
                    draft.target._tag === 'NewThread'
                      ? draft.target.anchor.change
                      : { status: 'M', path: 'file.ts' },
                  base: Option.some({ id: review.review.baseCommit, mode: '100644' }),
                  head: Option.some({ id: review.review.headCommit, mode: '100644' }),
                },
              ]),
            retain: unexpected,
            release: unexpected,
          }),
        ),
        Layer.succeed(DiscussionDraftStore, store),
        Layer.succeed(DiscussionIds, {
          draft: () => Effect.succeed(DraftId.make('new-draft')),
          attempt: () => Effect.sync(() => AttemptId.make(`attempt-${++count}`)),
        }),
      ),
    ),
  )
}

const provider = (create: ProviderDiscussion['create']): ProviderDiscussion => ({
  checkCreate: () => Effect.void,
  read: () => Effect.succeed({ key: review.key, threads: [], completeness: { _tag: 'Complete' } }),
  create,
  reply: unexpected,
  setResolution: unexpected,
})

it.effect(
  'recovers orphan drafts and attempts through explicit bounded global pages while inactive',
  () =>
    Effect.gen(function* () {
      const storage = makeStore()

      const orphanOrigin = DiscussionReview.make({
        key: {
          providerId: review.key.providerId,
          repository: review.key.repository,
          pullRequestId: '43',
        },
        selection: {
          provider: review.selection.provider,
          repository: review.selection.repository,
          id: '43',
          label: 'Undiscovered PR',
        },
        comparison: { ...review.comparison, pullRequestId: '43' },
        review: review.review,
      })

      for (let index = 0; index < 101; index++)
        yield* storage.store.create(
          Draft.make({
            id: DraftId.make(`orphan-${index}`),
            key: orphanOrigin.key,
            origin: orphanOrigin,
            target: { _tag: 'NewThread', anchor: anchorFixture(orphanOrigin) },
            version: 1,
            body: `Recovered body ${index}`,
          }),
        )
      yield* storage.store.prepare({
        id: AttemptId.make('prepared-before-restart'),
        key: draft.key,
        input: { _tag: 'Draft', draft },
      })
      let calls = 0

      const store = DiscussionDraftStore.of({
        ...storage.store,
        listAll: (cursor) =>
          Effect.suspend(() => {
            calls++

            return storage.store.listAll(cursor)
          }),
      })

      const remote: ProviderDiscussion = {
        checkCreate: unexpected,
        read: unexpected,
        create: unexpected,
        reply: unexpected,
        setResolution: unexpected,
      }

      yield* Effect.gen(function* () {
        const service = yield* Discussions
        expect(yield* service.current()).toEqual({ _tag: 'Inactive' })
        const first = yield* service.allDrafts(Option.none())
        expect(first.drafts.length + first.attempts.length).toBe(100)
        expect(first.drafts.some((value) => value.key.pullRequestId === '43')).toBe(true)
        expect(calls).toBe(1)
        expect(Option.isSome(first.next)).toBe(true)
        const second = yield* service.allDrafts(first.next)
        expect(second.drafts.length + second.attempts.length).toBe(3)
        expect(second.attempts[0]?._tag).toBe('Prepared')
        expect(Option.isNone(second.next)).toBe(true)
        expect(new Set([...first.drafts, ...second.drafts].map((value) => value.id)).size).toBe(102)
        expect(calls).toBe(2)
        expect(yield* service.current()).toEqual({ _tag: 'Inactive' })
      }).pipe(Effect.provide(makeLayer(remote, store)))
    }),
)

it.effect('rejects oversized recovery pages and terminal attempts presented as unresolved', () =>
  Effect.gen(function* () {
    const storage = makeStore()

    const pages: ReadonlyArray<DraftRecoveryPage> = [
      {
        drafts: Array.from({ length: discussionPolicy.draftPageSize + 1 }, () => draft),
        attempts: [],
        next: Option.none(),
      },
      {
        drafts: [],
        attempts: [
          {
            _tag: 'Confirmed',
            intent: {
              id: AttemptId.make('confirmed'),
              key: draft.key,
              input: { _tag: 'Draft', draft },
            },
            receipt,
          },
        ],
        next: Option.none(),
      },
    ]

    for (const page of pages) {
      const store = DiscussionDraftStore.of({
        ...storage.store,
        listAll: () => Effect.succeed(page),
      })

      yield* Effect.gen(function* () {
        const service = yield* Discussions
        expect(yield* service.allDrafts(Option.none()).pipe(Effect.flip)).toMatchObject({
          reason: 'invalid',
        })
      }).pipe(Effect.provide(makeLayer(provider(unexpected), store)))
    }
  }),
)

it.effect(
  'keeps a newer edit after a confirmed send and does not retarget it on review switch',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<ProviderReceipt>()
      const storage = makeStore()
      let writes = 0

      const remote = provider((input) =>
        Effect.gen(function* () {
          writes++
          expect(input.body).toBe('saved body')
          expect(input.review.key).toEqual(review.key)
          yield* Deferred.succeed(started, undefined)

          return yield* Deferred.await(complete)
        }),
      )

      yield* Effect.gen(function* () {
        const service = yield* Discussions

        const sending = yield* service
          .send({ id: draft.id, expectedVersion: 1 })
          .pipe(Effect.forkChild)

        yield* Deferred.await(started)
        yield* service.save({ id: draft.id, expectedVersion: 1, body: 'newer edit' })
        yield* service.activate(Option.none())
        yield* Deferred.succeed(complete, receipt)
        expect((yield* Fiber.join(sending))._tag).toBe('Confirmed')
        expect(yield* service.draft(draft.id)).toMatchObject({
          value: { version: 2, body: 'newer edit' },
        })
        expect(writes).toBe(1)
      }).pipe(Effect.provide(makeLayer(remote, storage.store)))
    }),
)

it.effect(
  'keeps uncertain sends reserved until explicit acknowledgment without replay on activation',
  () =>
    Effect.gen(function* () {
      const storage = makeStore()
      let writes = 0

      const remote = provider(() => {
        writes++

        return Effect.fail(new DiscussionWriteUncertain({ reason: 'transport' }))
      })

      yield* Effect.gen(function* () {
        const service = yield* Discussions
        const first = yield* service.send({ id: draft.id, expectedVersion: 1 })
        expect(first._tag).toBe('Uncertain')
        expect(
          (yield* service.send({ id: draft.id, expectedVersion: 1 }).pipe(Effect.flip)).reason,
        ).toBe('busy')
        yield* service.activate(Option.none())
        yield* service.drafts(review.key, Option.none())
        expect(writes).toBe(1)
        yield* service.acknowledgeUncertain(first.intent.id)
        yield* service.send({ id: draft.id, expectedVersion: 1 })
        expect(writes).toBe(2)
      }).pipe(Effect.provide(makeLayer(remote, storage.store)))
    }),
)

it.effect(
  'owns a dispatched write beyond caller cancellation and records uncertainty at runtime disposal',
  () =>
    Effect.gen(function* () {
      const storage = makeStore()
      const started = yield* Deferred.make<void>()

      const remote = provider(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )

      yield* Effect.gen(function* () {
        const service = yield* Discussions

        const sending = yield* service
          .send({ id: draft.id, expectedVersion: 1 })
          .pipe(Effect.forkChild)

        yield* Deferred.await(started)
        yield* Fiber.interrupt(sending)
        expect([...storage.attempts.values()][0]?._tag).toBe('Dispatching')
      }).pipe(Effect.provide(makeLayer(remote, storage.store)))
      expect([...storage.attempts.values()][0]?._tag).toBe('Uncertain')
      expect(storage.drafts.get(draft.id)?.body).toBe('saved body')
    }),
)

it.effect('publishes failed first reads and retains stale data on refresh failure', () =>
  Effect.gen(function* () {
    const storage = makeStore()
    const failed = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const stale = yield* Deferred.make<void>()
    let fail = true

    const remote: ProviderDiscussion = {
      ...provider(unexpected),
      read: () =>
        fail
          ? Effect.fail(new ProviderUnavailable())
          : Effect.succeed({ key: review.key, threads: [], completeness: { _tag: 'Complete' } }),
    }

    yield* Effect.gen(function* () {
      const service = yield* Discussions
      yield* service.changes.pipe(
        Stream.runForEach((state) => {
          if (state._tag === 'Failed') return Deferred.succeed(failed, undefined)

          if (state._tag === 'Ready') return Deferred.succeed(ready, undefined)

          if (state._tag === 'Stale') return Deferred.succeed(stale, undefined)

          return Effect.void
        }),
        Effect.forkChild,
      )
      yield* service.activate(Option.some(review))
      yield* Deferred.await(failed)
      expect((yield* service.current())._tag).toBe('Failed')
      fail = false
      yield* service.refresh()
      yield* Deferred.await(ready)
      fail = true
      yield* service.refresh()
      yield* Deferred.await(stale)
      expect(yield* service.current()).toMatchObject({
        _tag: 'Stale',
        snapshot: { completeness: { _tag: 'Complete' } },
        error: { _tag: 'ProviderUnavailable' },
      })
      expect((yield* service.drafts(review.key, Option.none())).drafts[0]?.body).toBe('saved body')
    }).pipe(Effect.provide(makeLayer(remote, storage.store)))
  }),
)

it.effect('leaves dispatch recovery evidence when a successful remote receipt cannot commit', () =>
  Effect.gen(function* () {
    const storage = makeStore()
    let calls = 0

    const remote = provider(() =>
      Effect.sync(() => {
        calls++

        return receipt
      }),
    )

    const failing = DiscussionDraftStore.of({
      ...storage.store,
      finish: () => Effect.fail(new DraftStorageError({ reason: 'write-failed' })),
    })

    yield* Effect.gen(function* () {
      const service = yield* Discussions
      expect(
        yield* service.send({ id: draft.id, expectedVersion: 1 }).pipe(Effect.flip),
      ).toMatchObject({ reason: 'write-failed' })
      expect([...storage.attempts.values()][0]?._tag).toBe('Dispatching')
      expect(yield* service.draft(draft.id)).toMatchObject({ value: { body: 'saved body' } })
      expect(
        yield* service.send({ id: draft.id, expectedVersion: 1 }).pipe(Effect.flip),
      ).toMatchObject({ reason: 'busy' })
      expect(calls).toBe(1)
    }).pipe(Effect.provide(makeLayer(remote, failing)))
  }),
)

it.effect(
  'cancels superseded reads without publishing their late snapshot into the next review',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const storage = makeStore()

      const remote: ProviderDiscussion = {
        ...provider(unexpected),
        read: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          ),
      }

      yield* Effect.gen(function* () {
        const service = yield* Discussions
        yield* service.activate(Option.some(review))
        yield* Deferred.await(started)
        yield* service.activate(Option.none())
        yield* Deferred.await(cancelled)
        expect(yield* service.current()).toEqual({ _tag: 'Inactive' })
        expect(storage.drafts.get(draft.id)?.origin.key).toEqual(review.key)
      }).pipe(Effect.provide(makeLayer(remote, storage.store)))
    }),
)

it.effect('journals known creation preflight rejection from Prepared without dispatching', () =>
  Effect.gen(function* () {
    const storage = makeStore()
    let dispatches = 0

    const store = DiscussionDraftStore.of({
      ...storage.store,
      dispatch: (id) => {
        dispatches++

        return storage.store.dispatch(id)
      },
    })

    const remote: ProviderDiscussion = {
      ...provider(unexpected),
      checkCreate: () => Effect.fail(new DiscussionWriteRejected({ reason: 'comparison-changed' })),
    }

    yield* Effect.gen(function* () {
      const service = yield* Discussions
      expect(yield* service.send({ id: draft.id, expectedVersion: 1 })).toMatchObject({
        _tag: 'Rejected',
        reason: 'comparison-changed',
      })
      expect(dispatches).toBe(0)
      expect(yield* service.draft(draft.id)).toMatchObject({ value: { body: 'saved body' } })
    }).pipe(Effect.provide(makeLayer(remote, store)))
  }),
)
