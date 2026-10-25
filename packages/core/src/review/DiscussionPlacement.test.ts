import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { DiscussionReview, type Side } from '../pull-requests/Discussion'
import { discussionFixture } from '../pull-requests/testing/DiscussionFixtures'
import { BranchReview, makeGitReviewLayer } from './BranchReview'
import { makeCodeAnchor, validateCodeAnchor, validateDiscussionReview } from './DiscussionPlacement'

const exec = promisify(execFile)

const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const command = (root: string, ...args: string[]) =>
  Effect.promise(() => exec('git', ['-C', root, ...args], { env }))

const repository = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'duff-discussion-')))
    await exec('git', ['init', '-b', 'main', root], { env })
    await exec('git', ['-C', root, 'config', 'user.name', 'Duff Test'], { env })
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'], { env })

    return root
  }),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

it.effect(
  'proves immutable sides, rename paths, content bounds and regular-file modes through real Git',
  () =>
    Effect.gen(function* () {
      const root = yield* repository
      yield* Effect.promise(() => writeFile(join(root, 'old.ts'), 'one\ntwo\n'))
      yield* Effect.promise(() => writeFile(join(root, 'deleted.ts'), 'old\n'))
      yield* command(root, 'add', '.')
      yield* command(root, 'commit', '-m', 'Base')
      const base = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
      yield* command(root, 'checkout', '-b', 'feature')
      yield* command(root, 'mv', 'old.ts', 'new.ts')
      yield* command(root, 'rm', 'deleted.ts')
      yield* Effect.promise(() => writeFile(join(root, 'added.ts'), 'added\n'))
      yield* Effect.promise(() => writeFile(join(root, 'binary'), Buffer.from([0, 1, 2])))
      yield* Effect.promise(() => symlink('new.ts', join(root, 'link')))
      yield* command(root, 'add', '.')
      yield* command(root, 'update-index', '--add', '--cacheinfo', `160000,${base},module`)
      yield* command(root, 'commit', '-m', 'Feature')
      const git = yield* BranchReview
      const review = yield* git.compare(root, 'main')
      const fixture = discussionFixture()

      const input = DiscussionReview.make({
        key: fixture.key,
        selection: fixture.selection,
        comparison: {
          ...fixture.comparison,
          sourceRevision: review.headCommit,
          baseRevision: review.baseCommit,
          targetRevision: base,
        },
        review,
      })

      yield* validateDiscussionReview(input)
      const rename = review.files.find((file) => file.path === 'new.ts')

      if (!rename) return yield* Effect.die('Missing renamed fixture')
      const head = yield* makeCodeAnchor(input, rename, 'head', { start: 1, end: 2 })
      const left = yield* makeCodeAnchor(input, rename, 'base', { start: 2, end: 2 })
      expect(head.path).toBe('new.ts')
      expect(left.path).toBe('old.ts')
      expect(
        (yield* validateCodeAnchor(input, { ...head, commit: base }).pipe(Effect.flip)).reason,
      ).toBe('invalid-anchor')
      expect(
        (yield* makeCodeAnchor(input, rename, 'head', { start: 3, end: 3 }).pipe(Effect.flip))
          .reason,
      ).toBe('invalid-anchor')

      const refused: ReadonlyArray<readonly [string, Side]> = [
        ['added.ts', 'base'],
        ['deleted.ts', 'head'],
        ['binary', 'head'],
        ['link', 'head'],
        ['module', 'head'],
      ]

      for (const [path, side] of refused) {
        const change = review.files.find((file) => file.path === path)

        if (!change) return yield* Effect.die('Missing fixture change')
        expect(
          (yield* makeCodeAnchor(input, change, side, { start: 1, end: 1 }).pipe(Effect.flip))
            .reason,
        ).toBe('invalid-anchor')
      }
    }).pipe(Effect.provide(makeGitReviewLayer(env))),
  { timeout: 20000 },
)
