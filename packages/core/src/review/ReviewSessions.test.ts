import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'

import { PullRequestSelection, ResolvedPullRequest } from '../pull-requests/PullRequests'
import { BranchReview, makeGitReviewLayer, type Review } from './BranchReview'
import { ReviewSessions } from './ReviewSessions'
import { SavedReviewCatalog, SavedReviews, ReviewStorageError } from './SavedReviews'

const execute = promisify(execFile)

const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const command = (root: string, ...args: string[]) =>
  Effect.promise(() => execute('git', ['-C', root, ...args], { env })).pipe(
    Effect.map((result) => result.stdout.trim()),
  )

const write = (root: string, path: string, value: string) =>
  Effect.promise(() => writeFile(join(root, path), value))

const owner = 'a'.repeat(64)

const empty = SavedReviewCatalog.make({
  version: 1,
  active: Option.none(),
  sessions: [],
  pendingRelease: [],
})

const codec = Schema.fromJsonString(Schema.toCodecJson(SavedReviewCatalog))

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'duff-sessions-'))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const selected = (id: string) =>
  PullRequestSelection.make({
    provider: 'fixture',
    repository: { authority: 'example.invalid', key: 'repo', displayName: 'repo' },
    id,
    label: id,
  })

const resolved = (review: Review, id: string) =>
  ResolvedPullRequest.make({
    pullRequest: {
      id,
      title: id,
      url: 'https://example.invalid/pr',
      draft: false,
      source: { _tag: 'Unavailable' },
      target: {
        repository: selected(id).repository,
        ref: { name: 'refs/heads/main', revision: Option.some(review.baseCommit) },
      },
    },
    revisions: {
      source: { commit: review.headCommit, ref: 'refs/heads/topic', remote: Option.none() },
      target: { commit: review.baseCommit, ref: 'refs/heads/main', remote: Option.none() },
    },
  })

const initialize = Effect.fn('Test.initialize')(function* (root: string) {
  yield* command(root, 'init', '-b', 'main')
  yield* command(root, 'config', 'user.name', 'Test')
  yield* command(root, 'config', 'user.email', 'test@example.invalid')
  yield* write(root, 'one', 'base one\n')
  yield* write(root, 'two', 'base two\n')
  yield* command(root, 'add', '.')
  yield* command(root, 'commit', '-m', 'base')
  yield* command(root, 'checkout', '-b', 'topic')
  yield* write(root, 'one', 'changed one\n')
  yield* write(root, 'two', 'changed two\n')
  yield* command(root, 'add', 'one', 'two')
  yield* command(root, 'commit', '-m', 'topic')
})

it.effect(
  'restarts offline with multiple sessions, transfers only full unchanged comparisons, and forgets only its own pins',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture
      yield* initialize(root)
      const catalogPath = join(root, '.git', 'duff-test.json')
      const initial = yield* Schema.encodeEffect(codec)(empty)
      yield* Effect.promise(() => writeFile(catalogPath, initial))

      const store = Layer.succeed(
        SavedReviews,
        SavedReviews.of({
          owner,
          load: () =>
            Effect.promise(() => readFile(catalogPath, 'utf8')).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(codec)),
              Effect.orDie,
            ),
          save: (catalog) =>
            Schema.encodeEffect(codec)(catalog).pipe(
              Effect.orDie,
              Effect.flatMap((encoded) => Effect.promise(() => writeFile(catalogPath, encoded))),
            ),
        }),
      )

      const layer = () =>
        ReviewSessions.layer.pipe(Layer.provide(store), Layer.provideMerge(makeGitReviewLayer(env)))

      const first = yield* Effect.gen(function* () {
        const git = yield* BranchReview
        const sessions = yield* ReviewSessions
        const review = yield* git.compare(root, 'refs/heads/main')
        const saved = yield* sessions.accept(selected('1'), resolved(review, '1'), review)
        yield* Effect.all(
          [
            sessions.progress(saved.key, review, 'one', true),
            sessions.progress(saved.key, review, 'two', true),
          ],
          { concurrency: 2 },
        )
        yield* sessions.opened(saved.key, review, 'two')
        const other = yield* sessions.accept(selected('2'), resolved(review, '2'), review)

        return { saved, other }
      }).pipe(Effect.provide(layer()))

      yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        const git = yield* BranchReview
        expect((yield* sessions.list()).sessions).toHaveLength(2)
        const resumed = yield* sessions.resume(first.saved.key)
        expect(resumed.viewed).toEqual(['one', 'two'])
        expect(resumed.lastFile).toEqual(Option.some('two'))
        yield* write(root, 'two', 'changed again\n')
        yield* command(root, 'add', 'two')
        yield* command(root, 'commit', '-m', 'update')
        const review = yield* git.compare(root, 'refs/heads/main')
        const updated = yield* sessions.accept(selected('1'), resolved(review, '1'), review)
        expect(updated.viewed).toEqual(['one'])
        expect(
          (yield* sessions
            .progress(updated.key, first.saved.review, 'one', false)
            .pipe(Effect.flip))._tag,
        ).toBe('ReviewError')
        expect((yield* sessions.resume(updated.key)).viewed).toEqual(['one'])
        // A second store and similarly named non-session refs are not ours to delete.
        const foreign = first.saved.retention.replace(owner, 'b'.repeat(64))
        yield* git.retain(root, foreign, [review.headCommit])
        yield* command(root, 'update-ref', 'refs/duff/reviews/source', review.headCommit)
        yield* sessions.forget(updated.key)
        expect(
          yield* command(root, 'for-each-ref', '--format=%(refname)', `${updated.retention}/`),
        ).toBe('')
        expect(yield* command(root, 'rev-parse', `${first.other.retention}/0`)).toBe(
          first.other.review.baseCommit,
        )
        expect(yield* command(root, 'rev-parse', `${foreign}/0`)).toBe(review.headCommit)
        expect(yield* command(root, 'rev-parse', 'refs/duff/reviews/source')).toBe(
          review.headCommit,
        )
        expect((yield* git.release(root, 'refs/duff').pipe(Effect.flip))._tag).toBe('ReviewError')
      }).pipe(Effect.provide(layer()))
    }),
)

it.effect(
  'journals before pinning and preserves the previous snapshot when the final write fails',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture
      yield* initialize(root)
      let durable = empty
      let fail = false

      const store = Layer.succeed(
        SavedReviews,
        SavedReviews.of({
          owner,
          load: () => Effect.succeed(durable),
          save: (next) =>
            Effect.gen(function* () {
              if (
                fail &&
                next.sessions.some(
                  (session) => session.review.headCommit !== durable.sessions[0]?.review.headCommit,
                )
              )
                return yield* new ReviewStorageError({ reason: 'write-failed' })
              durable = next
            }),
        }),
      )

      const layer = () =>
        ReviewSessions.layer.pipe(Layer.provide(store), Layer.provideMerge(makeGitReviewLayer(env)))

      const old = yield* Effect.gen(function* () {
        const git = yield* BranchReview
        const sessions = yield* ReviewSessions
        const review = yield* git.compare(root, 'refs/heads/main')
        const saved = yield* sessions.accept(selected('1'), resolved(review, '1'), review)
        yield* write(root, 'two', 'new revision\n')
        yield* command(root, 'add', 'two')
        yield* command(root, 'commit', '-m', 'update')
        const updated = yield* git.compare(root, 'refs/heads/main')
        fail = true
        expect(
          yield* sessions.accept(selected('1'), resolved(updated, '1'), updated).pipe(Effect.flip),
        ).toEqual(new ReviewStorageError({ reason: 'write-failed' }))
        expect(durable.sessions).toEqual([saved])
        expect(durable.pendingRelease).toHaveLength(1)
        const pending = durable.pendingRelease[0]
        expect(pending).toBeDefined()

        if (pending)
          expect(yield* command(root, 'rev-parse', `${pending.prefix}/1`)).toBe(updated.headCommit)

        return saved
      }).pipe(Effect.provide(layer()))

      fail = false
      yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        expect((yield* sessions.list()).pendingRelease).toEqual([])
        expect((yield* sessions.resume(old.key)).review).toEqual(old.review)
        expect(
          yield* command(
            root,
            'for-each-ref',
            '--format=%(refname)',
            `refs/duff/sessions/${owner}`,
          ),
        ).toBe([0, 1, 2].map((index) => `${old.retention}/${index}`).join('\n'))
      }).pipe(Effect.provide(layer()))
    }),
)

it.effect('does not transfer viewed when only the base blob or executable mode changed', () =>
  Effect.gen(function* () {
    const root = yield* fixture
    yield* initialize(root)
    let durable = empty

    const store = Layer.succeed(
      SavedReviews,
      SavedReviews.of({
        owner,
        load: () => Effect.succeed(durable),
        save: (next) =>
          Effect.sync(() => {
            durable = next
          }),
      }),
    )

    yield* Effect.gen(function* () {
      const sessions = yield* ReviewSessions
      const git = yield* BranchReview
      const review = yield* git.compare(root, 'refs/heads/main')
      const first = yield* sessions.accept(selected('1'), resolved(review, '1'), review)
      yield* sessions.progress(first.key, review, 'one', true)
      yield* sessions.progress(first.key, review, 'two', true)
      yield* command(root, 'checkout', 'main')
      yield* write(root, 'one', 'different base\n')
      yield* command(root, 'add', 'one')
      yield* command(root, 'commit', '-m', 'base advanced')
      yield* command(root, 'checkout', '-b', 'replacement')
      yield* write(root, 'one', 'changed one\n')
      yield* write(root, 'two', 'changed two\n')
      yield* command(root, 'add', 'one', 'two')
      yield* command(root, 'update-index', '--chmod=+x', 'two')
      yield* command(root, 'commit', '-m', 'replacement')
      const replacement = yield* git.compare(root, 'refs/heads/main')
      const updated = yield* sessions.accept(selected('1'), resolved(replacement, '1'), replacement)
      expect(updated.viewed).toEqual([])
      expect(Option.map(first.comparisons[0]?.head ?? Option.none(), (value) => value.id)).toEqual(
        Option.map(updated.comparisons[0]?.head ?? Option.none(), (value) => value.id),
      )
      expect(Option.map(first.comparisons[1]?.head ?? Option.none(), (value) => value.id)).toEqual(
        Option.map(updated.comparisons[1]?.head ?? Option.none(), (value) => value.id),
      )
    }).pipe(
      Effect.provide(
        ReviewSessions.layer.pipe(
          Layer.provide(store),
          Layer.provideMerge(makeGitReviewLayer(env)),
        ),
      ),
    )
  }),
)

it.effect(
  'a rejected journal write creates no pins, and foreign cleanup entries cannot release another store',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture
      yield* initialize(root)

      const store = Layer.succeed(
        SavedReviews,
        SavedReviews.of({
          owner,
          load: () => Effect.succeed(empty),
          save: () => Effect.fail(new ReviewStorageError({ reason: 'write-failed' })),
        }),
      )

      yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        const git = yield* BranchReview
        const review = yield* git.compare(root, 'refs/heads/main')
        expect(
          yield* sessions.accept(selected('1'), resolved(review, '1'), review).pipe(Effect.flip),
        ).toEqual(new ReviewStorageError({ reason: 'write-failed' }))
        expect(
          yield* command(root, 'for-each-ref', '--format=%(refname)', 'refs/duff/sessions'),
        ).toBe('')
      }).pipe(
        Effect.provide(
          ReviewSessions.layer.pipe(
            Layer.provide(store),
            Layer.provideMerge(makeGitReviewLayer(env)),
          ),
        ),
      )
      const prefix = `refs/duff/sessions/${'b'.repeat(64)}/${'c'.repeat(64)}/${'d'.repeat(64)}`
      const commit = yield* command(root, 'rev-parse', 'HEAD')
      yield* command(root, 'update-ref', `${prefix}/0`, commit)

      const foreign = Layer.succeed(
        SavedReviews,
        SavedReviews.of({
          owner,
          load: () =>
            Effect.succeed(
              SavedReviewCatalog.make({
                version: 1,
                active: Option.none(),
                sessions: [],
                pendingRelease: [{ root, prefix }],
              }),
            ),
          save: () => Effect.die('must not write foreign catalog'),
        }),
      )

      yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        expect(yield* sessions.list().pipe(Effect.flip)).toEqual(
          new ReviewStorageError({ reason: 'invalid' }),
        )
        expect(yield* command(root, 'rev-parse', `${prefix}/0`)).toBe(commit)
      }).pipe(
        Effect.provide(
          ReviewSessions.layer.pipe(Layer.provide(foreign), Layer.provide(makeGitReviewLayer(env))),
        ),
      )
    }),
)

it.effect(
  'cleanup write failures do not fail a durable forget, and restart retries the journal',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture
      yield* initialize(root)
      let durable = empty
      let rejectCleanup = true

      const store = Layer.succeed(
        SavedReviews,
        SavedReviews.of({
          owner,
          load: () => Effect.succeed(durable),
          save: (next) =>
            Effect.gen(function* () {
              if (
                rejectCleanup &&
                durable.pendingRelease.length > 0 &&
                next.pendingRelease.length === 0 &&
                next.sessions.length === 0
              )
                return yield* new ReviewStorageError({ reason: 'write-failed' })
              durable = next
            }),
        }),
      )

      const layer = () =>
        ReviewSessions.layer.pipe(Layer.provide(store), Layer.provideMerge(makeGitReviewLayer(env)))

      const saved = yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        const git = yield* BranchReview
        const review = yield* git.compare(root, 'refs/heads/main')
        const saved = yield* sessions.accept(selected('1'), resolved(review, '1'), review)
        yield* sessions.forget(saved.key)
        expect(durable.sessions).toEqual([])
        expect(durable.pendingRelease).toHaveLength(1)
        expect(
          yield* command(root, 'for-each-ref', '--format=%(refname)', `${saved.retention}/`),
        ).toBe('')

        return saved
      }).pipe(Effect.provide(layer()))

      rejectCleanup = false
      yield* Effect.gen(function* () {
        const sessions = yield* ReviewSessions
        expect((yield* sessions.list()).pendingRelease).toEqual([])
        expect((yield* sessions.resume(saved.key).pipe(Effect.flip))._tag).toBe('ReviewError')
      }).pipe(Effect.provide(layer()))
    }),
)
