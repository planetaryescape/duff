import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SavedReview, SavedReviewCatalog, SavedReviews } from '@duff/core/saved-reviews'
import { expect, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'

import { makeSavedReviewStoreLayer } from './FileSavedReviews'

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'duff-storage-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

const empty = SavedReviewCatalog.make({
  version: 1,
  active: Option.none(),
  sessions: [],
  pendingRelease: [],
})

const openStore = Effect.fn('Test.openStore')(function* (path: string | undefined) {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const context = yield* Layer.buildWithScope(makeSavedReviewStoreLayer(path), scope)

  return { service: Context.get(context, SavedReviews), close: Scope.close(scope, Exit.void) }
})

function session(owner: string) {
  const root = '/repository'
  const repository = { authority: 'github.com', key: 'owner/repo', displayName: 'repo' }

  const key = createHash('sha256')
    .update(JSON.stringify([root, 'github', repository.authority, repository.key, '1']))
    .digest('hex')

  const commit = 'a'.repeat(40)
  const ref = { name: 'refs/heads/main', revision: Option.some(commit) }
  const revision = { commit, ref: ref.name, remote: Option.none() }

  return SavedReview.make({
    key,
    selection: { provider: 'github', repository, id: '1', label: 'PR 1' },
    resolved: {
      pullRequest: {
        id: '1',
        title: 'PR',
        url: 'https://example.invalid/pr/1',
        draft: false,
        source: { _tag: 'Available', repository, ref },
        target: { repository, ref },
      },
      revisions: { source: revision, target: revision },
    },
    review: {
      root,
      baseBranch: ref.name,
      headBranch: ref.name,
      baseCommit: commit,
      headCommit: commit,
      files: [],
    },
    comparisons: [],
    viewed: [],
    lastFile: Option.none(),
    updatedAt: 1,
    retention: `refs/duff/sessions/${owner}/${key}/${'b'.repeat(64)}`,
  })
}

it.effect('round-trips nonempty sessions and Option codecs', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const first = yield* openStore(path)
    const saved = session(first.service.owner)

    const catalog = SavedReviewCatalog.make({
      ...empty,
      active: Option.some(saved.key),
      sessions: [saved],
    })

    yield* first.service.save(catalog)
    yield* first.close
    const second = yield* openStore(path)

    expect(yield* second.service.load()).toEqual(catalog)
  }),
)

it.effect('rejects contradictory persisted identities without changing their bytes', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const initial = yield* openStore(path)
    const saved = session(initial.service.owner)

    yield* initial.close

    const invalid = [
      SavedReviewCatalog.make({ ...empty, active: Option.some('missing') }),
      SavedReviewCatalog.make({ ...empty, sessions: [saved, saved] }),
      SavedReviewCatalog.make({ ...empty, sessions: [{ ...saved, key: 'c'.repeat(64) }] }),
      SavedReviewCatalog.make({
        ...empty,
        sessions: [{ ...saved, review: { ...saved.review, root: '/another' } }],
      }),
      SavedReviewCatalog.make({
        ...empty,
        sessions: [{ ...saved, review: { ...saved.review, headCommit: 'c'.repeat(40) } }],
      }),
      SavedReviewCatalog.make({
        ...empty,
        sessions: [
          {
            ...saved,
            retention: `refs/duff/sessions/${'c'.repeat(64)}/${saved.key}/${'b'.repeat(64)}`,
          },
        ],
      }),
    ]

    for (const catalog of invalid) {
      const text = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(SavedReviewCatalog)),
      )(catalog)

      yield* Effect.promise(() => writeFile(join(path, 'reviews.json'), text))
      const current = yield* openStore(path)

      expect(yield* Effect.result(current.service.load())).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'invalid' },
      })
      expect(yield* Effect.result(current.service.save(empty))).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'invalid' },
      })
      expect(yield* Effect.promise(() => readFile(join(path, 'reviews.json'), 'utf8'))).toBe(text)
      yield* current.close
    }
  }),
)

it.effect('persists before disposal and reopens in a fresh scope', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const first = yield* openStore(path)

    expect(yield* first.service.load()).toEqual(empty)
    expect(yield* Effect.promise(() => readdir(path))).not.toContain('reviews.json')
    yield* first.service.save(empty)
    expect(
      JSON.parse(yield* Effect.promise(() => readFile(join(path, 'reviews.json'), 'utf8'))),
    ).toEqual({ version: 1, active: { _tag: 'None' }, sessions: [], pendingRelease: [] })
    yield* first.close
    const second = yield* openStore(path)

    expect(yield* second.service.load()).toEqual(empty)
  }),
)

it.effect('competing owners are busy until the scoped owner releases', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const first = yield* openStore(path)
    const second = yield* openStore(path)

    yield* first.service.load()
    expect(yield* Effect.result(second.service.load())).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'busy' },
    })
    expect(yield* Effect.result(second.service.save(empty))).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'busy' },
    })
    yield* first.close
    yield* second.service.save(empty)
  }),
)

it.effect('corrupt storage cannot be overwritten by save, including without load', () =>
  Effect.gen(function* () {
    const path = yield* directory

    yield* Effect.promise(() => writeFile(join(path, 'reviews.json'), '{truncated'))
    const store = yield* openStore(path)

    expect(yield* Effect.result(store.service.save(empty))).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'invalid' },
    })
    expect(yield* Effect.promise(() => readFile(join(path, 'reviews.json'), 'utf8'))).toBe(
      '{truncated',
    )
  }),
)

it.effect('a failed replacement never truncates the destination and fails closed', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const store = yield* openStore(path)

    yield* store.service.load()
    yield* Effect.promise(() => mkdir(join(path, 'reviews.json')))
    yield* Effect.promise(() => writeFile(join(path, 'reviews.json', 'sentinel'), 'preserved'))
    expect(yield* Effect.result(store.service.save(empty))).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'write-failed' },
    })
    expect(
      yield* Effect.promise(() => readFile(join(path, 'reviews.json', 'sentinel'), 'utf8')),
    ).toBe('preserved')
    expect(yield* Effect.result(store.service.save(empty))).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'write-failed' },
    })
  }),
)

it.effect('undefined storage is an unavailable service, not a layer defect', () =>
  Effect.gen(function* () {
    const store = yield* openStore(undefined)

    expect(yield* Effect.result(store.service.load())).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'unavailable' },
    })
  }),
)

it.effect('an empty ambiguous lease fails busy and is never removed', () =>
  Effect.gen(function* () {
    const path = yield* directory

    yield* Effect.promise(() => mkdir(join(path, 'reviews.lock')))
    const store = yield* openStore(path)

    expect(yield* Effect.result(store.service.load())).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'busy' },
    })
    yield* store.close
    expect(yield* Effect.promise(() => readdir(path))).toEqual(['reviews.lock'])
  }),
)

it.effect(
  'crash recovery retains a retirement fence against delayed contenders and survives restart',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const initial = yield* openStore(path)
      yield* initial.service.save(empty)
      yield* initial.close
      const before = yield* Effect.promise(() => readFile(join(path, 'reviews.json'), 'utf8'))

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              'bun',
              [
                '--eval',
                `
      import { ManagedRuntime, Effect } from 'effect';
      import { SavedReviews } from '@duff/core/saved-reviews';
      import { makeSavedReviewStoreLayer } from '@duff/core/file-saved-reviews';
      const runtime = ManagedRuntime.make(makeSavedReviewStoreLayer(${JSON.stringify(path)}));
      await runtime.runPromise(Effect.gen(function* () { yield* (yield* SavedReviews).load() }));
      process.kill(process.pid, 'SIGKILL');
    `,
              ],
              { cwd: join(process.cwd(), 'packages/core'), stdio: 'ignore' },
            )

            child.once('error', reject)
            child.once('exit', (_code, signal) =>
              signal === 'SIGKILL'
                ? resolve()
                : reject(new Error('Child did not reach acquired lease')),
            )
          }),
      )
      const observed = yield* Effect.promise(() => readdir(join(path, 'reviews.lock')))
      expect(observed).toHaveLength(1)
      const contenders = yield* Effect.all(Array.from({ length: 8 }, () => openStore(path)))

      const results = yield* Effect.all(
        contenders.map((store) => Effect.result(store.service.load())),
        { concurrency: 8 },
      )

      expect(results.filter((result) => result._tag === 'Success')).toHaveLength(1)
      expect(results.filter((result) => result._tag === 'Failure')).toHaveLength(7)

      for (const result of results) {
        if (result._tag === 'Failure') expect(result.failure.reason).toBe('busy')
      }

      const retired = join(path, `.reviews-stale-${observed[0]}`)
      expect(yield* Effect.promise(() => readdir(retired))).toEqual(observed)

      // A contender paused after observing the dead lease must not move its successor.
      const live = yield* Effect.promise(() => readdir(join(path, 'reviews.lock')))

      const delayed = yield* Effect.result(
        Effect.tryPromise(() => rename(join(path, 'reviews.lock'), retired)),
      )

      expect(delayed._tag).toBe('Failure')
      expect(yield* Effect.promise(() => readdir(join(path, 'reviews.lock')))).toEqual(live)

      for (const store of contenders) yield* store.close

      // This is the disk state after death immediately following atomic retirement:
      // a nonempty retired lease, with no published lease and the original catalog.
      expect(yield* Effect.promise(() => readdir(retired))).toEqual(observed)

      for (let restart = 0; restart < 2; restart++) {
        const store = yield* openStore(path)
        expect(yield* store.service.load()).toEqual(empty)
        expect(yield* Effect.promise(() => readFile(join(path, 'reviews.json'), 'utf8'))).toBe(
          before,
        )
        yield* store.close
      }
    }),
)
