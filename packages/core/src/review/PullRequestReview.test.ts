import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Stream } from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import {
  PullRequests,
  PullRequestSelection,
  ResolvedPullRequest,
} from '../pull-requests/PullRequests'
import { BranchReview, FetchRequired, Review, ReviewError } from './BranchReview'
import { PullRequestReview, type PreparationState } from './PullRequestReview'
import { ReviewSessions } from './ReviewSessions'
import { SavedReviewCatalog, SavedReviews, ReviewStorageError } from './SavedReviews'

const snapshot: GitContextSnapshot = {
  root: '/fixture',
  remotes: [],
  helpers: [],
  sshCommandConfigured: false,
}

const selection = (id: string) =>
  PullRequestSelection.make({
    provider: 'fixture',
    repository: { authority: 'example.invalid', key: 'repo', displayName: 'repo' },
    id,
    label: id,
  })

const resolved = (id: string) =>
  ResolvedPullRequest.make({
    pullRequest: {
      id,
      title: id,
      url: 'https://example.invalid/pr',
      draft: false,
      source: { _tag: 'Unavailable' },
      target: {
        repository: selection(id).repository,
        ref: { name: 'refs/heads/main', revision: Option.some('a'.repeat(40)) },
      },
    },
    revisions: {
      source: { commit: id.repeat(40), ref: 'refs/heads/topic', remote: Option.none() },
      target: { commit: 'a'.repeat(40), ref: 'refs/heads/main', remote: Option.none() },
    },
  })

const review = (commit: string) =>
  Review.make({
    root: '/fixture',
    baseBranch: 'refs/heads/main',
    headBranch: 'refs/heads/topic',
    baseCommit: 'a'.repeat(40),
    headCommit: commit,
    files: [],
  })

const testLayer = (
  resolve: PullRequests['Service']['resolve'],
  prepare: BranchReview['Service']['prepare'],
  beforeSave: SavedReviews['Service']['save'] = () => Effect.void,
  beforeLoad: () => Effect.Effect<void, ReviewStorageError> = () => Effect.void,
) =>
  PullRequestReview.layer.pipe(
    Layer.provideMerge(ReviewSessions.layer),
    Layer.provide(
      Layer.effect(
        SavedReviews,
        Effect.sync(() => {
          let catalog = SavedReviewCatalog.make({
            version: 1,
            active: Option.none(),
            sessions: [],
            pendingRelease: [],
          })

          return SavedReviews.of({
            owner: 'a'.repeat(64),
            load: () => beforeLoad().pipe(Effect.as(catalog)),
            save: (next) =>
              beforeSave(next).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    catalog = next
                  }),
                ),
              ),
          })
        }),
      ),
    ),
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          PullRequests,
          PullRequests.of({
            resolve,
            discover: () => Stream.empty,
            loadMore: () => Effect.die('unused'),
            connect: () => Effect.die('unused'),
          }),
        ),
        Layer.succeed(
          BranchReview,
          BranchReview.of({
            prepare,
            branches: () => Effect.die('unused'),
            compare: () => Effect.die('unused'),
            read: () => Effect.die('unused'),
            comparisons: () => Effect.succeed([]),
            retain: () => Effect.void,
            release: () => Effect.void,
          }),
        ),
      ),
    ),
  )

const waitFor = (
  service: PullRequestReview['Service'],
  predicate: (state: PreparationState) => boolean,
) => service.changes.pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain)

it.effect(
  'preserves the accepted snapshot on failed/cancelled preparation, and fetch consent uses the already pinned revision',
  () => {
    let current = 'b'
    let needsFetch = false

    return Effect.gen(function* () {
      const service = yield* PullRequestReview
      yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.some(snapshot.root))
      yield* service.start(snapshot, selection('1'))
      yield* waitFor(service, (state) => Option.isSome(state.accepted))
      const previous = (yield* service.current()).accepted
      yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.none())
      expect((yield* service.current()).accepted).toEqual(previous)
      yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.some(snapshot.root))
      needsFetch = true
      current = 'c'
      yield* service.start(snapshot, selection('2'))
      yield* waitFor(service, (state) => state.activity._tag === 'AwaitingFetch')
      expect((yield* service.current()).accepted).toEqual(previous)
      yield* service.cancel()
      expect((yield* service.current()).accepted).toEqual(previous)
      yield* service.start(snapshot, selection('2'))
      yield* waitFor(service, (state) => state.activity._tag === 'AwaitingFetch')
      current = 'd'
      yield* service.allowFetch()
      yield* waitFor(service, (state) => state.activity._tag === 'Idle')
      const accepted = (yield* service.current()).accepted
      expect(Option.map(accepted, (accepted) => accepted.review.headCommit)).toEqual(
        Option.some('c'.repeat(40)),
      )
      yield* service.start(snapshot, selection('failed'))
      yield* waitFor(service, (state) => state.activity._tag === 'Failed')
      expect((yield* service.current()).accepted).toEqual(accepted)
      yield* service.exit()
      expect((yield* service.current()).accepted).toEqual(Option.none())
    }).pipe(
      Effect.provide(
        testLayer(
          (_snapshot, selected) =>
            selected.id === 'failed'
              ? new ReviewError({ operation: 'fixture', message: 'Unavailable' })
              : Effect.succeed(resolved(current)),
          (_root, revisions, permission) =>
            needsFetch && permission === 'local-only'
              ? new FetchRequired()
              : Effect.succeed(review(revisions.source.commit)),
        ),
      ),
    )
  },
)

it.effect(
  'interrupts superseded requests and repository changes so stale results cannot replace a newer review',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const service = yield* PullRequestReview
        yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.some(snapshot.root))
        yield* service.start(snapshot, selection('slow'))
        yield* Deferred.await(started)
        yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.none())
        expect(yield* Deferred.isDone(stopped)).toBe(false)
        expect((yield* service.current()).activity._tag).toBe('Preparing')
        yield* service.repositoryChanged(Option.some('/fixture/nested'), Option.some(snapshot.root))
        yield* service.start(snapshot, selection('b'))
        yield* waitFor(service, (state) => Option.isSome(state.accepted))
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(
          Option.map((yield* service.current()).accepted, (accepted) => accepted.selection.id),
        ).toEqual(Option.some('b'))
        yield* service.repositoryChanged(Option.some('/other/nested'), Option.none())
        yield* service.start(snapshot, selection('c'))
        expect((yield* service.current()).accepted).toEqual(Option.none())
        expect((yield* service.current()).activity._tag).toBe('Idle')
      }).pipe(
        Effect.provide(
          testLayer(
            (_snapshot, selected) =>
              selected.id === 'slow'
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                  )
                : Effect.succeed(resolved(selected.id)),
            (_root, revisions) => Effect.succeed(review(revisions.source.commit)),
          ),
        ),
      )
    }),
)

it.effect(
  'publishes only after durability, and cancellation waits for a committing snapshot to publish',
  () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const service = yield* PullRequestReview
        yield* service.repositoryChanged(Option.some('/fixture'), Option.some(snapshot.root))
        yield* service.start(snapshot, selection('b'))
        yield* Deferred.await(saving)
        expect((yield* service.current()).accepted).toEqual(Option.none())
        const cancellation = yield* service.cancel().pipe(Effect.forkChild)
        yield* Deferred.succeed(proceed, undefined)
        yield* Fiber.join(cancellation)
        expect(
          Option.map((yield* service.current()).accepted, (value) => value.selection.id),
        ).toEqual(Option.some('b'))
        expect((yield* service.current()).activity._tag).toBe('Idle')
      }).pipe(
        Effect.provide(
          testLayer(
            () => Effect.succeed(resolved('b')),
            () => Effect.succeed(review('b'.repeat(40))),
            (next) =>
              next.sessions.length > 0
                ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
                : Effect.void,
          ),
        ),
      )
    }),
)

it.effect('a failed durable update never replaces the accepted snapshot', () => {
  let reject = false

  return Effect.gen(function* () {
    const service = yield* PullRequestReview
    yield* service.repositoryChanged(Option.some('/fixture'), Option.some(snapshot.root))
    yield* service.start(snapshot, selection('b'))
    yield* waitFor(service, (state) => Option.isSome(state.accepted))
    const previous = (yield* service.current()).accepted
    reject = true
    yield* service.start(snapshot, selection('c'))
    yield* waitFor(service, (state) => state.activity._tag === 'Failed')
    expect((yield* service.current()).accepted).toEqual(previous)
  }).pipe(
    Effect.provide(
      testLayer(
        (_snapshot, selected) => Effect.succeed(resolved(selected.id)),
        (_root, revisions) => Effect.succeed(review(revisions.source.commit)),
        (next) =>
          reject && next.sessions.length === 2
            ? Effect.fail(new ReviewStorageError({ reason: 'write-failed' }))
            : Effect.void,
      ),
    ),
  )
})

it.effect('leaving without an accepted PR does not require writable session storage', () =>
  Effect.gen(function* () {
    const service = yield* PullRequestReview
    yield* service.repositoryChanged(Option.some('/fixture'), Option.some(snapshot.root))
    yield* service.exit()
    const state = yield* service.current()
    expect(state.accepted).toEqual(Option.none())
    expect(state.activity._tag).toBe('Idle')
  }).pipe(
    Effect.provide(
      testLayer(
        () => Effect.die('no provider access needed'),
        () => Effect.die('no Git preparation needed'),
        () => Effect.fail(new ReviewStorageError({ reason: 'unavailable' })),
        () => Effect.fail(new ReviewStorageError({ reason: 'unavailable' })),
      ),
    ),
  ),
)

it.effect(
  'a saved resume for a superseded repository cannot change the view or durable selection',
  () =>
    Effect.gen(function* () {
      const service = yield* PullRequestReview
      const sessions = yield* ReviewSessions
      const saved = yield* sessions.accept(selection('b'), resolved('b'), review('b'.repeat(40)))
      yield* sessions.leave()
      yield* service.repositoryChanged(Option.some('/other'), Option.some('/other'))
      yield* service.resume(saved.key)
      expect((yield* service.current()).root).toEqual(Option.some('/other'))
      expect((yield* service.current()).accepted).toEqual(Option.none())
      expect((yield* sessions.list()).active).toEqual(Option.none())
      yield* service.repositoryChanged(Option.some('/fixture'), Option.some('/fixture'))
      yield* service.resume(saved.key)
      expect(Option.map((yield* service.current()).accepted, (value) => value.saved.key)).toEqual(
        Option.some(saved.key),
      )
      expect((yield* sessions.list()).active).toEqual(Option.some(saved.key))
    }).pipe(
      Effect.provide(
        testLayer(
          () => Effect.die('resume must not resolve a provider'),
          () => Effect.die('resume must not prepare new revisions'),
        ),
      ),
    ),
)

it.effect('exit clears durable selection after repository reset without an accepted view', () =>
  Effect.gen(function* () {
    const service = yield* PullRequestReview
    const sessions = yield* ReviewSessions
    const saved = yield* sessions.accept(selection('b'), resolved('b'), review('b'.repeat(40)))
    yield* service.repositoryChanged(Option.some('/fixture'), Option.some('/fixture'))
    yield* service.resume(saved.key)
    yield* service.repositoryChanged(Option.none(), Option.none())
    yield* service.repositoryChanged(Option.some('/fixture'), Option.some('/fixture'))
    expect((yield* service.current()).accepted).toEqual(Option.none())
    yield* service.exit()
    expect((yield* sessions.list()).active).toEqual(Option.none())
    expect((yield* sessions.list()).sessions).toHaveLength(1)
    yield* service.restore('/fixture')
    expect((yield* service.current()).accepted).toEqual(Option.none())
  }).pipe(
    Effect.provide(
      testLayer(
        () => Effect.die('exit must not resolve a provider'),
        () => Effect.die('exit must not prepare revisions'),
      ),
    ),
  ),
)
