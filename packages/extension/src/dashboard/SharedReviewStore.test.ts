import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SavedReview, SavedReviewCatalog, SavedReviews } from '@duff/core/saved-reviews'
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Scope } from 'effect'

import { makeSharedReviewStoreLayer } from './SharedReviewStore'

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'duff-shared-progress-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

const empty = SavedReviewCatalog.make({
  version: 1,
  active: Option.none(),
  sessions: [],
  pendingRelease: [],
})

const openStore = Effect.fn('Test.openSharedReviewStore')(function* (
  path: string,
  workspace: string,
) {
  const context = yield* Layer.buildWithScope(
    makeSharedReviewStoreLayer(path, workspace),
    yield* Scope.Scope,
  )

  return Context.get(context, SavedReviews)
})

function catalog(owner: string, root: string, updatedAt: number) {
  const repository = { authority: 'github.com', key: 'owner/repo', displayName: 'repo' }

  const key = createHash('sha256')
    .update(JSON.stringify([root, 'github', repository.authority, repository.key, '1']))
    .digest('hex')

  const commit = 'a'.repeat(40)
  const ref = { name: 'refs/heads/main', revision: Option.some(commit) }
  const revision = { commit, ref: ref.name, remote: Option.none() }

  const session = SavedReview.make({
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
    updatedAt,
    retention: `refs/duff/sessions/${owner}/${key}/${'b'.repeat(64)}`,
  })

  return SavedReviewCatalog.make({
    version: 1,
    active: Option.some(key),
    sessions: [session],
    pendingRelease: [],
  })
}

it.effect(
  'shares progress and ownership across adapters and reopen, isolating other checkouts',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const workspace = join(path, 'checkout')
      const first = yield* openStore(path, workspace)
      const second = yield* openStore(path, workspace)
      const other = yield* openStore(path, join(path, 'other'))

      expect(first.owner).toBe(second.owner)
      expect(other.owner).not.toBe(first.owner)
      expect(yield* first.load()).toEqual(empty)
      const saved = catalog(first.owner, workspace, 1)

      yield* first.save(saved)
      expect(yield* second.load()).toEqual(saved)
      expect(yield* other.load()).toEqual(empty)
      const reopened = yield* openStore(path, workspace)

      expect(yield* reopened.load()).toEqual(saved)
    }),
)

it.effect(
  'rejects stale writers, preserves progress, and requires an explicit reload after conflict',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const workspace = join(path, 'checkout')
      const first = yield* openStore(path, workspace)
      const second = yield* openStore(path, workspace)

      yield* first.load()
      yield* second.load()
      const saved = catalog(first.owner, workspace, 1)

      yield* first.save(saved)
      expect((yield* Effect.flip(second.save(empty))).reason).toBe('busy')
      expect((yield* Effect.flip(second.save(empty))).reason).toBe('busy')
      expect(yield* first.load()).toEqual(saved)
      expect(yield* second.load()).toEqual(saved)
      const updated = catalog(second.owner, workspace, 2)

      yield* second.save(updated)
      expect((yield* Effect.flip(first.save(saved))).reason).toBe('busy')
      expect(yield* first.load()).toEqual(updated)
    }),
)

it.effect(
  'allows an initial save only for an empty store and never overwrites unseen progress',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const workspace = join(path, 'checkout')
      const first = yield* openStore(path, workspace)
      const saved = catalog(first.owner, workspace, 1)

      yield* first.save(saved)
      const unseen = yield* openStore(path, workspace)

      expect((yield* Effect.flip(unseen.save(empty))).reason).toBe('busy')
      expect(yield* unseen.load()).toEqual(saved)
    }),
)

it.effect('refuses malformed existing progress before a first save without overwriting it', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const workspace = join(path, 'checkout')
    const first = yield* openStore(path, workspace)

    yield* first.save(empty)
    const files = yield* Effect.promise(() => readdir(path))
    const filename = files.find((name) => name.endsWith('.sqlite'))

    if (filename === undefined) return yield* Effect.die('Expected a SQLite store')
    const database = new DatabaseSync(join(path, filename))

    database.prepare('UPDATE progress SET value = ?').run('{}')
    database.close()
    const unseen = yield* openStore(path, workspace)

    expect((yield* Effect.flip(unseen.save(empty))).reason).toBe('invalid')
    expect((yield* Effect.flip(unseen.load())).reason).toBe('invalid')
    const inspection = new DatabaseSync(join(path, filename))

    try {
      expect(inspection.prepare('SELECT value FROM progress').get()).toEqual({ value: '{}' })
    } finally {
      inspection.close()
    }
  }),
)

it.effect(
  'rejects foreign ownership and workspace identities without modifying valid progress',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const workspace = join(path, 'checkout')
      const store = yield* openStore(path, workspace)

      yield* store.load()
      expect((yield* Effect.flip(store.save(catalog('f'.repeat(64), workspace, 1)))).reason).toBe(
        'invalid',
      )
      expect(
        (yield* Effect.flip(store.save(catalog(store.owner, join(path, 'other'), 1)))).reason,
      ).toBe('invalid')
      expect(yield* store.load()).toEqual(empty)
      yield* store.save(catalog(store.owner, workspace, 2))
      expect(yield* store.load()).toEqual(catalog(store.owner, workspace, 2))
    }),
)

it.effect('fails closed on newer versions and leaves their database bytes intact', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const workspace = join(path, 'checkout')
    const store = yield* openStore(path, workspace)

    yield* store.save(empty)
    const files = yield* Effect.promise(() => readdir(path))
    const filename = files.find((name) => name.endsWith('.sqlite'))

    if (filename === undefined) return yield* Effect.die('Expected a SQLite store')
    const file = join(path, filename)
    const database = new DatabaseSync(file)

    database.exec('PRAGMA user_version = 2')
    database.close()
    const before = yield* Effect.promise(() => readFile(file))

    expect((yield* Effect.flip(store.load())).reason).toBe('invalid')
    expect((yield* Effect.flip(store.save(empty))).reason).toBe('invalid')
    expect(yield* Effect.promise(() => readFile(file))).toEqual(before)
  }),
)
