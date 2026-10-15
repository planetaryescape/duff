import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Layer, Option, Redacted, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { GitContext, type GitContextSnapshot } from '../git-context/GitContext'
import {
  type GitHostingProvider,
  type OpenPullRequest,
  type ProviderRepository,
  ProviderUnavailable,
  RateLimited,
} from '../pull-requests/GitHostingProvider'
import { makePullRequestsLayer } from '../pull-requests/PullRequests'
import { ReviewSession, type ReviewState } from './ReviewSession'

const identity = { authority: 'example.invalid', key: 'owner/repo', displayName: 'owner/repo' }

const pr = (id: string): OpenPullRequest => ({
  id,
  title: `Change ${id}`,
  url: `https://example.invalid/pr/${id}`,
  draft: false,
  source: { _tag: 'Unavailable' },
  target: { repository: identity, ref: { name: 'refs/heads/main', revision: Option.none() } },
})

const context = (root: string): GitContextSnapshot => ({
  root,
  helpers: [],
  sshCommandConfigured: false,
  remotes: [
    {
      name: 'origin',
      destination: 'https://example.invalid/owner/repo',
      transport: 'https',
      credentials: { _tag: 'NotApplicable' },
    },
  ],
})

const testLayer = (
  list: ProviderRepository['listOpenPullRequests'],
  inspect: GitContext['Service']['inspect'] = (root) => Effect.succeed(context(root)),
) => {
  const provider: GitHostingProvider = {
    identity: { id: 'fixture', displayName: 'Fixture', authenticationSource: 'editor' },
    recognizeRemote: () =>
      Option.some({
        identity,
        inspectAuthentication: () => Effect.succeed({ _tag: 'Unauthenticated' }),
        connectAuthentication: () =>
          Effect.succeed({
            _tag: 'Authenticated',
            account: Option.some({ id: 'fixture', displayName: 'Fixture' }),
          }),
        listOpenPullRequests: list,
      }),
  }

  return ReviewSession.layer.pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(GitContext, { inspect }), makePullRequestsLayer([provider])),
    ),
  )
}

const waitFor = (session: ReviewSession['Service'], predicate: (state: ReviewState) => boolean) =>
  session.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((states) => states[0]),
  )

const settled = (state: ReviewState) =>
  state._tag === 'Active' && state.inspection === 'Ready' && !state.discovering

it.effect('keeps PRs during refresh and explicitly marks them stale after a failed refresh', () =>
  Effect.gen(function* () {
    const refresh = yield* Deferred.make<void>()
    let first = true
    yield* Effect.gen(function* () {
      const session = yield* ReviewSession
      yield* session.selectRepository('/fixture', { discover: true })
      yield* waitFor(session, settled)
      yield* session.selectRepository('/fixture', { discover: true })

      const refreshing = yield* waitFor(
        session,
        (state) => state._tag === 'Active' && state.rows[0]?.content._tag === 'Refreshing',
      )

      expect(refreshing?._tag).toBe('Active')

      if (refreshing?._tag === 'Active' && refreshing.rows[0]?.content._tag === 'Refreshing')
        expect(refreshing.rows[0].content.data.items.map((pr) => pr.id)).toEqual(['17'])
      yield* Deferred.succeed(refresh, undefined)
      const stale = yield* waitFor(session, settled)

      if (stale?._tag !== 'Active' || stale.rows[0]?.content._tag !== 'Stale')
        return yield* Effect.die('Missing stale results')
      expect(stale.rows[0].content.data.items.map((pr) => pr.id)).toEqual(['17'])
      expect(stale.rows[0].content.error).toBeInstanceOf(ProviderUnavailable)
      expect(stale.rows[0].content.data.hasMore).toBe(false)
    }).pipe(
      Effect.provide(
        testLayer(() => {
          if (first) {
            first = false

            return Effect.succeed({ items: [pr('17')], next: Option.some(Redacted.make('cursor')) })
          }

          return Deferred.await(refresh).pipe(Effect.andThen(new ProviderUnavailable()))
        }),
      ),
    )
  }),
)

it.effect('cancels old repository work, clears old PRs, and respects manual-only discovery', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const session = yield* ReviewSession
      yield* session.selectRepository('/old', { discover: true })
      yield* Deferred.await(started)
      yield* session.selectRepository('/new', { discover: false })
      yield* Deferred.await(stopped)
      const next = yield* waitFor(session, settled)

      if (next?._tag !== 'Active') return yield* Effect.die('Missing selected repository')
      expect(next.directory).toBe('/new')
      expect(next.rows).toEqual([])
      expect(Option.map(next.snapshot, (snapshot) => snapshot.root)).toEqual(Option.some('/new'))
      yield* session.clear()
      expect(yield* session.current()).toEqual({ _tag: 'Idle' })
    }).pipe(
      Effect.provide(
        testLayer(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        ),
      ),
    )
  }),
)

it.effect(
  'preserves pages across rate limits and retries only after the Effect-clock cooldown',
  () =>
    Effect.gen(function* () {
      let limited = true
      yield* Effect.gen(function* () {
        const session = yield* ReviewSession
        yield* session.selectRepository('/fixture', { discover: true })
        const first = yield* waitFor(session, settled)

        if (first?._tag !== 'Active' || !first.rows[0]) return yield* Effect.die('Missing group')
        const id = first.rows[0].group.id
        yield* session.loadMore(id)
        yield* waitFor(
          session,
          (state) => state._tag === 'Active' && state.rows[0]?.activity === 'Cooldown',
        )
        yield* session.loadMore(id)
        const waiting = yield* session.current()

        if (waiting._tag !== 'Active') return yield* Effect.die('Missing session')
        expect(waiting.rows[0]?.activity).toBe('Cooldown')
        yield* TestClock.adjust('10 seconds')
        yield* waitFor(
          session,
          (state) => state._tag === 'Active' && state.rows[0]?.activity === 'Idle',
        )
        yield* session.loadMore(id)

        const completed = yield* waitFor(
          session,
          (state) =>
            state._tag === 'Active' &&
            state.rows[0]?.content._tag === 'Ready' &&
            !state.rows[0].content.data.hasMore,
        )

        if (completed?._tag !== 'Active' || completed.rows[0]?.content._tag !== 'Ready')
          return yield* Effect.die('Missing completed page')
        expect(completed.rows[0].content.data.items.map((pr) => pr.id)).toEqual(['17', '23'])
      }).pipe(
        Effect.provide(
          testLayer((input) => {
            if (Option.isNone(input.cursor))
              return Effect.succeed({
                items: [pr('17')],
                next: Option.some(Redacted.make('cursor')),
              })

            if (limited) {
              limited = false

              return new RateLimited({ retryAfterSeconds: Option.some(10) })
            }

            return Effect.succeed({ items: [pr('17'), pr('23')], next: Option.none() })
          }),
        ),
      )
    }),
)

it.effect('releases owned discovery when the session scope closes', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const session = yield* ReviewSession
      yield* session.selectRepository('/fixture', { discover: true })
      yield* Deferred.await(started)
    }).pipe(
      Effect.provide(
        testLayer(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        ),
      ),
    )
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)

it.effect(
  'allows paging a ready group while discovery continues and settles interrupted siblings on failed connection',
  () =>
    Effect.gen(function* () {
      const slowStarted = yield* Deferred.make<void>()
      const slowStopped = yield* Deferred.make<void>()
      const connection = yield* Deferred.make<void>()

      const provider: GitHostingProvider = {
        identity: { id: 'fixture', displayName: 'Fixture', authenticationSource: 'editor' },
        recognizeRemote: (remote) =>
          Option.some({
            identity: { ...identity, key: remote.name, displayName: remote.name },
            inspectAuthentication: () => Effect.succeed({ _tag: 'Unauthenticated' }),
            connectAuthentication: () =>
              Deferred.await(connection).pipe(Effect.andThen(new ProviderUnavailable())),
            listOpenPullRequests: (input) =>
              remote.name === 'slow'
                ? Deferred.succeed(slowStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(slowStopped, undefined)),
                  )
                : Effect.succeed({
                    items: [pr(Option.isNone(input.cursor) ? '17' : '23')],
                    next: Option.isNone(input.cursor)
                      ? Option.some(Redacted.make('cursor'))
                      : Option.none(),
                  }),
          }),
      }

      const layer = ReviewSession.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(GitContext, {
              inspect: (root) =>
                Effect.succeed({
                  ...context(root),
                  remotes: ['fast', 'slow'].map((name) => ({
                    ...context(root).remotes[0],
                    name,
                    destination: `https://example.invalid/${name}`,
                    transport: 'https',
                    credentials: { _tag: 'NotApplicable' },
                  })),
                }),
            }),
            makePullRequestsLayer([provider]),
          ),
        ),
      )

      yield* Effect.gen(function* () {
        const session = yield* ReviewSession
        yield* session.selectRepository('/fixture', { discover: true })
        yield* Deferred.await(slowStarted)

        const partial = yield* waitFor(
          session,
          (state) => state._tag === 'Active' && state.rows[0]?.content._tag === 'Ready',
        )

        if (partial?._tag !== 'Active' || !partial.rows[0])
          return yield* Effect.die('Missing progressive result')
        expect(partial.discovering).toBe(true)
        const id = partial.rows[0].group.id
        yield* session.loadMore(id)

        const paged = yield* waitFor(
          session,
          (state) =>
            state._tag === 'Active' &&
            state.rows[0]?.content._tag === 'Ready' &&
            state.rows[0].content.data.items.length === 2,
        )

        if (paged?._tag !== 'Active') return yield* Effect.die('Missing page')
        expect(paged.discovering).toBe(true)
        yield* session.connect(id)
        yield* Deferred.await(slowStopped)
        const connecting = yield* session.current()

        if (connecting._tag !== 'Active') return yield* Effect.die('Missing connection')
        expect(connecting.rows[0]?.activity).toBe('Connecting')
        expect(connecting.rows[1]?.activity).toBe('Idle')
        expect(connecting.rows[1]?.content._tag).toBe('Failed')
        yield* Deferred.succeed(connection, undefined)

        const failed = yield* waitFor(
          session,
          (state) => state._tag === 'Active' && state.rows[0]?.activity === 'Idle',
        )

        if (failed?._tag !== 'Active' || failed.rows[0]?.content._tag !== 'Stale')
          return yield* Effect.die('Missing stale page')
        expect(failed.rows[0].content.data.items.map((pr) => pr.id)).toEqual(['17', '23'])
        expect(failed.rows[0].content.data.hasMore).toBe(false)
        expect(failed.rows[0].content.error).toBeInstanceOf(ProviderUnavailable)
      }).pipe(Effect.provide(layer))
    }),
)
