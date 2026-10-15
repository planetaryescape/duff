import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { GitContext, makeGitContextLayer } from '../git-context/GitContext'
import { BranchReview, makeGitReviewLayer } from './BranchReview'

const execute = promisify(execFile)

const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const gitReviewLayer = makeGitReviewLayer(env)

const repository = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'duff-test-')))
    await execute('git', ['init', '-b', 'main', root], { env })
    await execute('git', ['-C', root, 'config', 'user.name', 'Duff Test'], { env })
    await execute('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'], { env })

    return root
  }),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const command = (root: string, ...args: string[]) =>
  Effect.promise(() => execute('git', ['-C', root, ...args], { env }))

const write = (root: string, path: string, content: string) =>
  Effect.promise(() => writeFile(join(root, path), content))

it.effect(
  'reviews only branch changes since the common ancestor, preserving paths and snapshots',
  () =>
    Effect.gen(function* () {
      const root = yield* repository
      yield* write(root, 'changed.ts', 'export const value = 1;\n')
      yield* write(root, 'deleted.txt', 'removed\n')
      yield* write(root, 'old name.txt', 'rename content\n')
      yield* command(root, 'add', '.')
      yield* command(root, 'commit', '-m', 'Base')
      yield* command(root, 'branch', 'feature')
      yield* write(root, 'base-only.txt', 'base branch diverged\n')
      yield* command(root, 'add', '.')
      yield* command(root, 'commit', '-m', 'Base-only change')
      yield* command(root, 'checkout', 'feature')
      yield* write(root, 'changed.ts', 'export const value = 2;\n')
      yield* write(root, '-new\nname:with space.txt', 'added\n')
      yield* command(root, 'rm', 'deleted.txt')
      yield* command(root, 'mv', 'old name.txt', 'new name.txt')
      yield* command(root, 'add', '.')
      yield* command(root, 'commit', '-m', 'Feature changes')
      yield* write(root, 'changed.ts', 'uncommitted\n')
      const service = yield* BranchReview
      const branches = yield* service.branches(root)
      expect(branches.current).toBe('feature')
      expect(branches.branches).toEqual(['refs/heads/main'])
      const review = yield* service.compare(root, 'refs/heads/main')
      expect(review.files).toEqual([
        { status: 'A', path: '-new\nname:with space.txt' },
        { status: 'M', path: 'changed.ts' },
        { status: 'D', path: 'deleted.txt' },
        { status: 'R', path: 'new name.txt', previousPath: 'old name.txt' },
      ])
      expect(yield* service.read({ root, commit: review.baseCommit, path: 'changed.ts' })).toBe(
        'export const value = 1;\n',
      )
      expect(yield* service.read({ root, commit: review.headCommit, path: 'changed.ts' })).toBe(
        'export const value = 2;\n',
      )
      expect(yield* service.read({ root, commit: review.baseCommit, path: 'old name.txt' })).toBe(
        'rename content\n',
      )
      expect(yield* service.read({ root, commit: review.headCommit })).toBe('')

      const missing = yield* service
        .read({ root, commit: review.headCommit, path: 'deleted.txt' })
        .pipe(Effect.flip)

      expect(missing._tag).toBe('ReviewError')
    }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect('handles detached HEAD and identical branches without inventing changes', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* write(root, 'file.txt', 'same\n')
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'Base')
    yield* command(root, 'checkout', '--detach')
    const service = yield* BranchReview
    expect((yield* service.branches(root)).current).toBe('HEAD')
    expect((yield* service.compare(root, 'refs/heads/main')).files).toEqual([])
  }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect('fails a missing base branch rather than returning an empty review', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* command(root, 'commit', '--allow-empty', '-m', 'Base')
    const service = yield* BranchReview
    const failure = yield* service.compare(root, 'refs/heads/canary-secret').pipe(Effect.flip)
    expect(failure._tag).toBe('ReviewError')
    expect(failure.operation).toBe('rev-parse')
    expect(failure.message).not.toContain('canary-secret')
  }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect('reviews the requested repository despite inherited hook repository variables', () =>
  Effect.gen(function* () {
    const source = yield* repository
    const target = yield* repository
    yield* command(source, 'commit', '--allow-empty', '-m', 'Source')
    yield* command(target, 'commit', '--allow-empty', '-m', 'Target')
    yield* command(target, 'checkout', '-b', 'review-target')
    yield* write(target, 'target.txt', 'target only\n')
    yield* command(target, 'add', '.')
    yield* command(target, 'commit', '-m', 'Target change')
    const before = yield* command(source, 'show-ref')

    const redirected = {
      ...env,
      GIT_DIR: join(source, '.git'),
      GIT_COMMON_DIR: join(source, '.git'),
      GIT_WORK_TREE: source,
      GIT_INDEX_FILE: join(source, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(source, '.git', 'objects'),
    }

    const review = yield* BranchReview.use((service) =>
      service.compare(target, 'refs/heads/main'),
    ).pipe(Effect.provide(makeGitReviewLayer(redirected)))

    expect(review.root).toBe(target)
    expect(review.headBranch).toBe('review-target')
    expect(review.files).toEqual([{ status: 'A', path: 'target.txt' }])

    const context = yield* GitContext.use((service) => service.inspect(target)).pipe(
      Effect.provide(makeGitContextLayer(redirected)),
    )

    expect(context.root).toBe(target)
    expect((yield* command(source, 'show-ref')).stdout).toBe(before.stdout)
    expect((yield* command(source, 'status', '--porcelain')).stdout).toBe('')
  }),
)
