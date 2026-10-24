import { expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Fiber, Option, Redacted, Stream } from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import {
  type GitHostingProvider,
  type ProviderRepository,
  ProviderUnavailable,
  type Remote,
} from './GitHostingProvider'
import { makePullRequestsLayer, PullRequests } from './PullRequests'

const remote = (name: string): Remote => ({
  name,
  destination: `https://example.invalid/${name}`,
  transport: 'https',
  credentials: { _tag: 'NotApplicable' },
})

const snapshot = (names: string[]): GitContextSnapshot => ({
  root: '/fixture',
  remotes: names.map(remote),
  helpers: [],
  sshCommandConfigured: false,
})

const repository = (
  key: string,
  list: ProviderRepository['listPullRequests'],
): ProviderRepository => ({
  identity: { authority: 'example.invalid', key, displayName: key },
  inspectAuthentication: () => Effect.succeed({ _tag: 'Unauthenticated' }),
  connectAuthentication: () =>
    Effect.succeed({
      _tag: 'Authenticated',
      account: Option.some({ id: 'fixture', displayName: 'Fixture' }),
    }),
  listPullRequests: list,
  getPullRequest: () => new ProviderUnavailable(),
})

const provider = (
  id: string,
  recognizeRemote: GitHostingProvider['recognizeRemote'],
): GitHostingProvider => ({
  identity: { id, displayName: id, authenticationSource: 'editor' },
  recognizeRemote,
})

it.effect('groups equivalent remotes while preserving unsupported and ambiguous notices', () =>
  Effect.gen(function* () {
    const first = provider('first', (remote) =>
      remote.name === 'unsupported'
        ? Option.none()
        : Option.some(
            repository(remote.name === 'alias' ? 'origin' : remote.name, () =>
              remote.name === 'failed'
                ? new ProviderUnavailable()
                : Effect.succeed({ items: [], next: Option.none() }),
            ),
          ),
    )

    const second = provider('second', (remote) =>
      remote.name === 'ambiguous'
        ? Option.some(repository('overlap', () => Effect.die('Ambiguous route performed I/O')))
        : Option.none(),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests

      const events = yield* Stream.runCollect(
        service.discover(snapshot(['origin', 'alias', 'unsupported', 'failed', 'ambiguous'])),
      )

      const start = events[0]
      expect(start?._tag).toBe('Started')

      if (start?._tag === 'Started') {
        expect(start.groups.map((group) => group.remoteNames)).toEqual([
          ['origin', 'alias'],
          ['failed'],
        ])
        expect(start.notices.map((notice) => notice._tag)).toEqual(['Unsupported', 'Ambiguous'])
      }

      expect(
        events
          .filter((event) => event._tag === 'Updated')
          .map((event) => event.result._tag)
          .sort(),
      ).toEqual(['Failed', 'Ready'])
    }).pipe(Effect.provide(makePullRequestsLayer([first, second])))
  }),
)

it.effect('emits fast repositories without waiting for the first slow repository', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, () =>
          remote.name === 'slow'
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ items: [], next: Option.none() }),
        ),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests

      const fiber = yield* service
        .discover(snapshot(['slow', 'fast']))
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* Deferred.await(started)
      const events = yield* Fiber.join(fiber)
      const update = events[1]
      expect(update?._tag).toBe('Updated')

      if (update?._tag === 'Updated') expect(update.result.group.repository.key).toBe('fast')
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)

it.effect('owns continuation retries, rejects cycles and retires group identities on refresh', () =>
  Effect.gen(function* () {
    const cursor = Redacted.make('private-cursor')
    let transient = true

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, (input) => {
          if (Option.isNone(input.cursor))
            return Effect.succeed({ items: [], next: Option.some(cursor) })

          if (transient) {
            transient = false

            return new ProviderUnavailable()
          }

          return Effect.succeed({ items: [], next: Option.some(Redacted.make('private-cursor')) })
        }),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests
      const events = yield* Stream.runCollect(service.discover(snapshot(['origin'])))
      const start = events[0]

      if (start?._tag !== 'Started' || !start.groups[0]) return yield* Effect.die('Missing group')
      const id = start.groups[0].id
      const failure = yield* service.loadMore(id)
      expect(failure._tag).toBe('Failed')

      if (failure._tag === 'Failed') expect(failure.error._tag).toBe('ProviderUnavailable')
      const cycle = yield* service.loadMore(id)

      if (cycle._tag !== 'Failed') return yield* Effect.die('Expected cycle rejection')
      expect(cycle.error._tag).toBe('InvalidContinuation')
      yield* Stream.runDrain(service.discover(snapshot([])))
      expect((yield* service.loadMore(id).pipe(Effect.flip))._tag).toBe('GroupNotFound')
      expect((yield* service.connect(id).pipe(Effect.flip))._tag).toBe('GroupNotFound')
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)

it.effect('serializes pages within a group without blocking another group', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, (input) =>
          Effect.gen(function* () {
            if (Option.isNone(input.cursor))
              return { items: [], next: Option.some(Redacted.make('page-2')) }

            if (Redacted.value(input.cursor.value) === 'page-2') {
              if (remote.name === 'slow') {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }

              return { items: [], next: Option.some(Redacted.make('page-3')) }
            }

            return { items: [], next: Option.none() }
          }),
        ),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests
      const events = yield* Stream.runCollect(service.discover(snapshot(['slow', 'fast'])))
      const start = events[0]

      if (start?._tag !== 'Started' || !start.groups[0] || !start.groups[1])
        return yield* Effect.die('Missing groups')

      const slow = start.groups[0].id
      const fast = start.groups[1].id
      const first = yield* service.loadMore(slow).pipe(Effect.forkScoped)
      yield* Deferred.await(started)

      const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(service.loadMore(slow)),
        Effect.forkScoped,
      )

      yield* Deferred.await(secondStarted)
      yield* Effect.yieldNow

      const independent = yield* service.loadMore(fast)
      expect(independent._tag).toBe('Ready')
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Deferred.succeed(release, undefined)

      const pages = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(pages.map((page) => page._tag)).toEqual(['Ready', 'Ready'])
      expect(pages.map((page) => page._tag === 'Ready' && page.hasMore)).toEqual([true, false])
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)

it.effect('keeps connection invalidation after an in-flight page finishes', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const connecting = yield* Deferred.make<void>()

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, (input) =>
          Effect.gen(function* () {
            if (Option.isNone(input.cursor))
              return { items: [], next: Option.some(Redacted.make('page-2')) }

            if (Redacted.value(input.cursor.value) === 'page-2') {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)

              return { items: [], next: Option.some(Redacted.make('page-3')) }
            }

            return { items: [], next: Option.none() }
          }),
        ),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests
      const events = yield* Stream.runCollect(service.discover(snapshot(['origin'])))
      const start = events[0]

      if (start?._tag !== 'Started' || !start.groups[0]) return yield* Effect.die('Missing group')

      const id = start.groups[0].id
      const page = yield* service.loadMore(id).pipe(Effect.forkScoped)
      yield* Deferred.await(started)

      const connection = yield* Deferred.succeed(connecting, undefined).pipe(
        Effect.andThen(service.connect(id)),
        Effect.forkScoped,
      )

      yield* Deferred.await(connecting)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(page))._tag).toBe('Ready')
      expect((yield* Fiber.join(connection))._tag).toBe('Authenticated')

      const after = yield* service.loadMore(id)
      expect(after._tag).toBe('Failed')

      if (after._tag === 'Failed') expect(after.error._tag).toBe('InvalidContinuation')
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)

it.effect('retires queued group actions and releases their wait on interruption', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const queued = yield* Deferred.make<void>()

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, (input) =>
          Option.isNone(input.cursor)
            ? Effect.succeed({ items: [], next: Option.some(Redacted.make('page-2')) })
            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests
      const events = yield* Stream.runCollect(service.discover(snapshot(['origin'])))
      const start = events[0]

      if (start?._tag !== 'Started' || !start.groups[0]) return yield* Effect.die('Missing group')

      const id = start.groups[0].id
      const page = yield* service.loadMore(id).pipe(Effect.forkScoped)
      yield* Deferred.await(started)

      const waiting = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          Effect.all([Effect.result(service.loadMore(id)), Effect.result(service.connect(id))], {
            concurrency: 2,
          }),
        ),
        Effect.forkScoped,
      )

      yield* Deferred.await(queued)
      yield* Effect.yieldNow
      yield* Stream.runDrain(service.discover(snapshot([])))
      yield* Fiber.interrupt(page)

      const results = yield* Fiber.join(waiting)
      expect(results.map((result) => result._tag)).toEqual(['Failure', 'Failure'])
      expect(results.map((result) => result._tag === 'Failure' && result.failure._tag)).toEqual([
        'GroupNotFound',
        'GroupNotFound',
      ])
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)

it.effect('interrupts provider work without converting cancellation into a failed result', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()

    const instance = provider('fixture', (remote) =>
      Option.some(
        repository(remote.name, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    )

    yield* Effect.gen(function* () {
      const service = yield* PullRequests

      const fiber = yield* service
        .discover(snapshot(['origin']))
        .pipe(Stream.runDrain, Effect.forkScoped)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe('Failure')

      if (exit._tag === 'Failure') expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }).pipe(Effect.provide(makePullRequestsLayer([instance])))
  }),
)
