import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Layer, Option, Stream } from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import {
  PullRequests,
  PullRequestSelection,
  ResolvedPullRequest,
} from '../pull-requests/PullRequests'
import { BranchReview, FetchRequired, Review, ReviewError } from './BranchReview'
import { PullRequestReview, type PreparationState } from './PullRequestReview'

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
) =>
  PullRequestReview.layer.pipe(
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
      yield* service.repositoryChanged(Option.some(snapshot.root))
      yield* service.start(snapshot, selection('1'))
      yield* waitFor(service, (state) => Option.isSome(state.accepted))
      const previous = (yield* service.current()).accepted
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
        yield* service.repositoryChanged(Option.some(snapshot.root))
        yield* service.start(snapshot, selection('slow'))
        yield* Deferred.await(started)
        yield* service.start(snapshot, selection('b'))
        yield* waitFor(service, (state) => Option.isSome(state.accepted))
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(
          Option.map((yield* service.current()).accepted, (accepted) => accepted.selection.id),
        ).toEqual(Option.some('b'))
        yield* service.repositoryChanged(Option.some('/other'))
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
