import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Option, Schedule, Schema } from 'effect'

import { GitContext, makeGitContextLayer } from '../git-context/GitContext'
import { azureSshDestination } from '../pull-requests/azure-devops/AzureDevOpsHttp'
import { BranchReview, FetchRequired, makeGitReviewLayer, ReviewRevisions } from './BranchReview'

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

it.effect('never changes repository identity or retries a moved Azure branch over SSH', () =>
  Effect.gen(function* () {
    const source = yield* repository
    const root = yield* repository
    yield* write(source, 'file.txt', 'base\n')
    yield* command(source, 'add', '.')
    yield* command(source, 'commit', '-m', 'Base')
    const base = (yield* command(source, 'rev-parse', 'HEAD')).stdout.trim()
    yield* command(root, 'fetch', source, 'main')
    yield* command(root, 'reset', '--hard', 'FETCH_HEAD')
    yield* command(source, 'checkout', '-b', 'topic')
    yield* write(source, 'file.txt', 'pinned\n')
    yield* command(source, 'commit', '-am', 'Pinned')
    const head = (yield* command(source, 'rev-parse', 'HEAD')).stdout.trim()
    const primary = yield* repository
    yield* command(primary, 'fetch', source, 'main')
    yield* command(primary, 'checkout', '-b', 'topic', 'FETCH_HEAD')
    yield* write(primary, 'file.txt', 'moved\n')
    yield* command(primary, 'commit', '-am', 'Moved')
    const bin = join(root, 'bin')
    yield* Effect.promise(() => mkdir(bin))
    const realGit = (yield* Effect.promise(() => execute('which', ['git'], { env }))).stdout.trim()
    yield* write(
      bin,
      'git',
      `#!/bin/sh\nfetching=false\nprimary=false\nfor arg do\n  if [ "$arg" = fetch ]; then fetching=true; fi\n  if "$fetching" && [ "$arg" = origin ]; then primary=true; fi\n  last="$arg"\ndone\nif "$primary"; then\n  case "$DUFF_TEST_MODE" in\n    moved) exec '${realGit}' -c protocol.file.allow=always fetch --no-write-fetch-head --refmap= -- '${primary}' "$last" ;;\n    *) exit 128 ;;\n  esac\nfi\nexec '${realGit}' "$@"\n`,
    )
    const ssh = join(root, 'test-ssh')
    yield* write(root, 'test-ssh', `#!/bin/sh\nexec git-upload-pack '${source}'\n`)
    yield* Effect.promise(() => chmod(join(bin, 'git'), 0o755))
    yield* Effect.promise(() => chmod(ssh, 0o755))
    const azure = 'https://dev.azure.com/org/project/_git/repo'
    yield* command(root, 'remote', 'add', 'origin', azure)

    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      ['https://dev.azure.com/org/project/_git/other', azure, 'denied', 'configuration changed'],
      [
        'https://github.com/owner/repo.git',
        'https://github.com/owner/repo.git',
        'denied',
        'could not acquire',
      ],
      [
        'https://dev.azure.com/org/my%2Fproject/_git/repo',
        'https://dev.azure.com/org/my%2Fproject/_git/repo',
        'denied',
        'could not acquire',
      ],
      [
        'https://dev.azure.com/org/%ZZ/_git/repo',
        'https://dev.azure.com/org/%ZZ/_git/repo',
        'denied',
        'could not acquire',
      ],
      [azure, azure, 'moved', 'branch moved'],
    ]

    for (const [actual, expected, mode, message] of cases) {
      yield* command(root, 'remote', 'set-url', 'origin', actual)

      const error = yield* Effect.gen(function* () {
        const service = yield* BranchReview

        return yield* service
          .prepare(
            root,
            {
              source: {
                commit: head,
                ref: 'refs/heads/topic',
                remote: Option.some({ name: 'origin', destination: expected }),
              },
              target: { commit: base, ref: 'refs/heads/main', remote: Option.none() },
            },
            'fetch',
          )
          .pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          makeGitReviewLayer(
            {
              ...env,
              PATH: `${bin}:${env.PATH ?? ''}`,
              GIT_SSH_COMMAND: ssh,
              GIT_SSH_VARIANT: 'simple',
              DUFF_TEST_MODE: mode,
            },
            azureSshDestination,
          ),
        ),
      )

      expect(error._tag).toBe('ReviewError')

      if (error._tag === 'ReviewError') expect(error.message).toContain(message)
      expect(yield* Effect.promise(() => readFile(join(root, 'file.txt'), 'utf8'))).toBe('base\n')
    }
  }),
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

it.effect('preserves snapshot BOMs and decodes incomplete trailing UTF-8 as replacement text', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* Effect.promise(() =>
      writeFile(join(root, 'encoded.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xc3])),
    )
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'Encoded snapshot')
    const commit = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    const service = yield* BranchReview

    expect(yield* service.read({ root, commit, path: 'encoded.txt' })).toBe('\uFEFFa\uFFFD')
  }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect('reads UTF-8 snapshots up to the capture budget and rejects larger content safely', () =>
  Effect.gen(function* () {
    const root = yield* repository
    const content = 'é'.repeat(8 * 1024 * 1024)
    yield* write(root, 'large.txt', content)
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'At capture limit')
    const atLimit = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    const service = yield* BranchReview
    expect(yield* service.read({ root, commit: atLimit, path: 'large.txt' })).toBe(content)

    yield* write(root, 'large.txt', `${content}x`)
    yield* command(root, 'commit', '-am', 'Above capture limit')
    const aboveLimit = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()

    const failure = yield* service
      .read({ root, commit: aboveLimit, path: 'large.txt' })
      .pipe(Effect.flip)

    expect(failure._tag).toBe('ReviewError')
    expect(failure.operation).toBe('show')
    expect(failure.message).not.toContain('large.txt')
    expect(failure.message).not.toContain('é')
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

it.effect('pins both PR commits independently of HEAD, branch names, index and working files', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* write(root, 'file.txt', 'base\n')
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'Base')
    const base = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* command(root, 'checkout', '-b', 'fork-topic')
    yield* write(root, 'file.txt', 'fork revision\n')
    yield* command(root, 'commit', '-am', 'Fork change')
    const head = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* command(root, 'checkout', 'main')
    yield* write(root, 'unrelated.txt', 'target-only change\n')
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'Target divergence')
    const target = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* write(root, 'file.txt', 'staged\n')
    yield* command(root, 'add', 'file.txt')
    yield* write(root, 'file.txt', 'working\n')
    const before = yield* command(root, 'diff', '--binary', 'HEAD')
    const index = yield* Effect.promise(() => readFile(join(root, '.git/index')))
    const service = yield* BranchReview

    const review = yield* service.prepare(
      root,
      ReviewRevisions.make({
        source: { commit: head, ref: 'refs/heads/same-name', remote: Option.none() },
        target: { commit: target, ref: 'refs/heads/same-name', remote: Option.none() },
      }),
      'local-only',
    )

    expect(review.baseCommit).toBe(base)
    expect(review.headCommit).toBe(head)
    expect(review.files).toEqual([{ status: 'M', path: 'file.txt' }])
    expect(yield* service.read({ root, commit: head, path: 'file.txt' })).toBe('fork revision\n')
    expect((yield* command(root, 'diff', '--binary', 'HEAD')).stdout).toBe(before.stdout)
    expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(index)
    expect((yield* command(root, 'branch', '--show-current')).stdout.trim()).toBe('main')
  }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect(
  'requires consent, fetches exact fork revisions into bounded refs and rejects moved fallback refs',
  () =>
    Effect.gen(function* () {
      const source = yield* repository
      const root = yield* repository
      yield* write(source, 'fork.txt', 'base\n')
      yield* command(source, 'add', '.')
      yield* command(source, 'commit', '-m', 'Base')
      const base = (yield* command(source, 'rev-parse', 'HEAD')).stdout.trim()
      yield* command(root, 'fetch', source, 'main')
      yield* command(root, 'reset', '--hard', 'FETCH_HEAD')
      yield* command(source, 'checkout', '-b', 'topic')
      yield* write(source, 'fork.txt', 'fork content\n')
      yield* command(source, 'commit', '-am', 'Fork change')
      const head = (yield* command(source, 'rev-parse', 'HEAD')).stdout.trim()
      const ssh = join(root, 'test-ssh')
      yield* Effect.promise(() =>
        writeFile(ssh, '#!/bin/sh\nexec git-upload-pack "$DUFF_SOURCE"\n'),
      )
      yield* Effect.promise(() => chmod(ssh, 0o700))
      yield* command(root, 'remote', 'add', 'fork', 'git@github.com:fork/repo.git')
      yield* command(root, 'config', 'fetch.prune', 'true')
      yield* command(root, 'config', 'fetch.pruneTags', 'true')
      yield* command(root, 'update-ref', 'refs/remotes/fork/keep', base)
      yield* write(root, 'fork.txt', 'staged\n')
      yield* command(root, 'add', 'fork.txt')
      yield* write(root, 'fork.txt', 'working\n')
      const index = yield* Effect.promise(() => readFile(join(root, '.git/index')))
      const fetchHead = yield* Effect.promise(() => readFile(join(root, '.git/FETCH_HEAD')))
      const refs = (yield* command(root, 'show-ref')).stdout

      const revisions = ReviewRevisions.make({
        source: {
          commit: head,
          ref: 'refs/heads/topic',
          remote: Option.some({ name: 'fork', destination: 'github.com:fork/repo.git' }),
        },
        target: { commit: base, ref: 'refs/heads/main', remote: Option.none() },
      })

      yield* Effect.gen(function* () {
        const service = yield* BranchReview
        expect(
          yield* service.prepare(root, revisions, 'local-only').pipe(Effect.flip),
        ).toBeInstanceOf(FetchRequired)
        expect((yield* command(root, 'show-ref')).stdout).toBe(refs)
        const review = yield* service.prepare(root, revisions, 'fetch')
        expect(review.headCommit).toBe(head)
        expect(yield* service.read({ root, commit: head, path: 'fork.txt' })).toBe('fork content\n')
        expect(
          (yield* command(root, 'for-each-ref', '--format=%(refname)', 'refs/duff')).stdout.trim(),
        ).toBe('refs/duff/reviews/source')
        expect(
          (yield* command(root, 'show-ref')).stdout
            .split('\n')
            .filter((line) => !line.includes('refs/duff/'))
            .join('\n'),
        ).toBe(refs)

        const moved = ReviewRevisions.make({
          source: { ...revisions.source, commit: 'f'.repeat(40) },
          target: revisions.target,
        })

        const failure = yield* service.prepare(root, moved, 'fetch').pipe(Effect.flip)
        expect(failure._tag).toBe('ReviewError')

        if (failure._tag === 'ReviewError') expect(failure.message).toContain('branch moved')
        expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(index)
        expect(yield* Effect.promise(() => readFile(join(root, '.git/FETCH_HEAD')))).toEqual(
          fetchHead,
        )
        expect(yield* Effect.promise(() => readFile(join(root, 'fork.txt'), 'utf8'))).toBe(
          'working\n',
        )
        expect((yield* command(root, 'branch', '--show-current')).stdout.trim()).toBe('main')
      }).pipe(
        Effect.provide(
          makeGitReviewLayer({
            ...env,
            GIT_SSH_COMMAND: ssh,
            GIT_SSH_VARIANT: 'simple',
            DUFF_SOURCE: source,
          }),
        ),
      )
    }),
)

it.effect(
  'fails unavailable history and multiple merge bases without choosing an arbitrary base',
  () =>
    Effect.gen(function* () {
      const root = yield* repository
      yield* command(root, 'commit', '--allow-empty', '-m', 'Base')
      const base = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
      yield* command(root, 'checkout', '--orphan', 'unrelated')
      yield* command(root, 'commit', '--allow-empty', '-m', 'Unrelated')
      const unrelated = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
      const service = yield* BranchReview

      const revisions = (head: string, target: string) =>
        ReviewRevisions.make({
          source: { commit: head, ref: 'refs/heads/source', remote: Option.none() },
          target: { commit: target, ref: 'refs/heads/target', remote: Option.none() },
        })

      const failure = yield* service
        .prepare(root, revisions(unrelated, base), 'local-only')
        .pipe(Effect.flip)

      expect(failure._tag).toBe('ReviewError')
      const tree = (yield* command(root, 'rev-parse', `${base}^{tree}`)).stdout.trim()
      const a = (yield* command(root, 'commit-tree', tree, '-p', base, '-m', 'A')).stdout.trim()
      const b = (yield* command(root, 'commit-tree', tree, '-p', base, '-m', 'B')).stdout.trim()

      const left = (yield* command(
        root,
        'commit-tree',
        tree,
        '-p',
        a,
        '-p',
        b,
        '-m',
        'Left',
      )).stdout.trim()

      const right = (yield* command(
        root,
        'commit-tree',
        tree,
        '-p',
        b,
        '-p',
        a,
        '-m',
        'Right',
      )).stdout.trim()

      const ambiguous = yield* service
        .prepare(root, revisions(left, right), 'local-only')
        .pipe(Effect.flip)

      expect(ambiguous._tag).toBe('ReviewError')

      if (ambiguous._tag === 'ReviewError')
        expect(ambiguous.message).toContain('unique common ancestor')

      yield* write(root, '.git/shallow', `${left}\n`)

      const shallow = yield* service
        .prepare(root, revisions(left, base), 'local-only')
        .pipe(Effect.flip)

      expect(shallow._tag).toBe('ReviewError')

      if (shallow._tag === 'ReviewError') expect(shallow.message).toContain('shallow')
      expect(yield* Effect.promise(() => readFile(join(root, '.git/shallow'), 'utf8'))).toBe(
        `${left}\n`,
      )
    }).pipe(Effect.provide(gitReviewLayer)),
)

it.effect('rejects shallow ancestry even when Git reports a unique but older merge base', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* command(root, 'commit', '--allow-empty', '-m', 'A')
    const a = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* write(root, 'target.txt', 'target only\n')
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'B')
    const b = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* write(root, 'feature.txt', 'source change\n')
    yield* command(root, 'add', '.')
    yield* command(root, 'commit', '-m', 'C')
    const c = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    const tree = (yield* command(root, 'rev-parse', 'HEAD^{tree}')).stdout.trim()

    const source = (yield* command(
      root,
      'commit-tree',
      tree,
      '-p',
      c,
      '-p',
      a,
      '-m',
      'S',
    )).stdout.trim()

    expect((yield* command(root, 'merge-base', '--all', source, b)).stdout.trim()).toBe(b)
    yield* write(root, '.git/shallow', `${c}\n`)
    expect((yield* command(root, 'merge-base', '--all', source, b)).stdout.trim()).toBe(a)
    const service = yield* BranchReview

    const failure = yield* service
      .prepare(
        root,
        {
          source: { commit: source, ref: 'refs/heads/topic', remote: Option.none() },
          target: { commit: b, ref: 'refs/heads/main', remote: Option.none() },
        },
        'local-only',
      )
      .pipe(Effect.flip)

    expect(failure._tag).toBe('ReviewError')

    if (failure._tag === 'ReviewError') expect(failure.message).toContain('Shallow')
  }).pipe(Effect.provide(gitReviewLayer)),
)

it.live('cancelling acquisition terminates its Git transport descendants', () =>
  Effect.gen(function* () {
    const root = yield* repository
    yield* command(root, 'commit', '--allow-empty', '-m', 'Base')
    const base = (yield* command(root, 'rev-parse', 'HEAD')).stdout.trim()
    yield* command(root, 'remote', 'add', 'origin', 'git@github.com:fixture/repo.git')
    const ssh = join(root, 'test-ssh')
    const pidFile = join(root, 'transport.pid')
    // Publish only a complete PID: reading between shell redirection and echo yields "" (PID 0).
    yield* Effect.promise(() =>
      writeFile(
        ssh,
        '#!/bin/sh\nsleep 30 &\necho $! > "$DUFF_PID_FILE.tmp"\nmv "$DUFF_PID_FILE.tmp" "$DUFF_PID_FILE"\nwait\n',
      ),
    )
    yield* Effect.promise(() => chmod(ssh, 0o700))
    yield* Effect.gen(function* () {
      const service = yield* BranchReview

      const fiber = yield* service
        .prepare(
          root,
          {
            source: {
              commit: 'f'.repeat(40),
              ref: 'refs/heads/topic',
              remote: Option.some({ name: 'origin', destination: 'github.com:fixture/repo.git' }),
            },
            target: { commit: base, ref: 'refs/heads/main', remote: Option.none() },
          },
          'fetch',
        )
        .pipe(Effect.forkChild)

      const pid = yield* Effect.tryPromise(() => readFile(pidFile, 'utf8')).pipe(
        Effect.retry({ times: 100, schedule: Schedule.spaced('10 millis') }),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
          ),
        ),
      )

      expect(() => process.kill(pid, 0)).not.toThrow()
      yield* Fiber.interrupt(fiber)
      // Git's close event can precede the kernel finishing/reaping its killed descendants.
      // Require ESRCH within one second, well before the fixture's natural 30-second exit.
      yield* Effect.promise(() =>
        expect
          .poll(
            () => {
              try {
                process.kill(pid, 0)
              } catch (error) {
                return error
              }
            },
            { interval: 10, timeout: 1000 },
          )
          .toMatchObject({ code: 'ESRCH' }),
      )
    }).pipe(
      Effect.provide(
        makeGitReviewLayer({
          ...env,
          GIT_SSH_COMMAND: ssh,
          GIT_SSH_VARIANT: 'simple',
          DUFF_PID_FILE: pidFile,
        }),
      ),
    )
  }),
)
