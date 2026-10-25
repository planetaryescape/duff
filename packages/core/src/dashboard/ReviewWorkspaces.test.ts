import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Ref } from 'effect'

import { ResolvedPullRequest } from '../pull-requests/PullRequests'
import { BranchReview, makeGitReviewLayer, ReviewError } from '../review/BranchReview'
import {
  makeReviewWorkspacesLayer,
  reviewWorkspacesLayer,
  ReviewWorkspaces,
} from './ReviewWorkspaces'

const execute = promisify(execFile)

const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

const command = (root: string, ...args: string[]) =>
  Effect.promise(async () => (await execute('git', ['-C', root, ...args], { env })).stdout.trim())

const write = (root: string, path: string, value: string) =>
  Effect.promise(() => writeFile(join(root, path), value))

const read = (root: string, path: string) =>
  Effect.promise(() => readFile(join(root, path), 'utf8'))

const foreignLock = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<ChildProcessWithoutNullStreams, ReviewError>((resume) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.argv[1]);
      database.exec('BEGIN EXCLUSIVE');
      process.stdout.write('ready');
      process.stdin.resume();
    `,
          path,
        ],
        { env },
      )

      child.once('error', () =>
        resume(
          Effect.fail(
            new ReviewError({ operation: 'fixture lock', message: 'Cannot start lock holder.' }),
          ),
        ),
      )
      child.once('exit', () =>
        resume(
          Effect.fail(
            new ReviewError({ operation: 'fixture lock', message: 'Lock holder exited.' }),
          ),
        ),
      )
      child.stdout.once('data', () => resume(Effect.succeed(child)))

      return Effect.sync(() => {
        child.kill('SIGKILL')
      })
    }),
    (child) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.once('close', () => resolve())
            child.kill('SIGKILL')
          }),
      ),
  )

const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), 'duff-workspace-')))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  )

  const target = join(root, 'target')
  const source = join(root, 'fork')
  const data = join(root, 'data')
  yield* Effect.promise(() => mkdir(target))
  yield* command(target, 'init', '-b', 'main')
  yield* command(target, 'config', 'user.name', 'Duff Test')
  yield* command(target, 'config', 'user.email', 'test@example.invalid')
  yield* write(target, 'unchanged.ts', 'export const unchanged = true\n')
  yield* write(target, 'changed.ts', 'export const value = 1\n')
  yield* write(target, '.gitattributes', '*.ts filter=hostile\n')
  yield* write(
    target,
    '.gitmodules',
    '[submodule "never-run"]\npath = submodule\nurl = ext::touch should-not-run\n',
  )
  yield* command(target, 'add', '.')
  yield* command(target, 'commit', '-m', 'Base')
  const base = yield* command(target, 'rev-parse', 'HEAD')
  yield* Effect.promise(() => execute('git', ['clone', target, source], { env }))
  yield* command(source, 'config', 'user.name', 'Duff Test')
  yield* command(source, 'config', 'user.email', 'test@example.invalid')
  yield* command(source, 'checkout', '-b', 'feature')
  yield* write(source, 'changed.ts', 'export const value = 2\n')
  yield* command(source, 'commit', '-am', 'Feature')
  const head = yield* command(source, 'rev-parse', 'HEAD')
  yield* write(target, 'target-only.txt', 'not in fork HEAD\n')
  yield* command(target, 'add', '.')
  yield* command(target, 'commit', '-m', 'Target diverges')
  const targetHead = yield* command(target, 'rev-parse', 'HEAD')
  yield* write(source, 'changed.ts', 'source clone edits stay here\n')
  yield* write(source, 'source-untracked.txt', 'keep\n')

  const repository = (name: string) => ({
    authority: 'github.com',
    key: `owner/${name}`,
    displayName: name,
  })

  const resolved = ResolvedPullRequest.make({
    pullRequest: {
      id: '7',
      title: 'Review fork',
      url: 'https://github.com/owner/target/pull/7',
      draft: false,
      source: {
        _tag: 'Available',
        repository: repository('fork'),
        ref: { name: 'refs/heads/feature', revision: Option.some(head) },
      },
      target: {
        repository: repository('target'),
        ref: { name: 'refs/heads/main', revision: Option.some(targetHead) },
      },
    },
    revisions: {
      source: {
        commit: head,
        ref: 'refs/heads/feature',
        remote: Option.some({ name: 'fork', destination: 'https://github.com/owner/fork.git' }),
      },
      target: {
        commit: targetHead,
        ref: 'refs/heads/main',
        remote: Option.some({ name: 'origin', destination: 'https://github.com/owner/target.git' }),
      },
    },
  })

  return { root, target, source, data, base, head, targetHead, resolved }
})

/** Production denies file transport. Inject only acquisition, populating real Git
 * objects from local fixtures, then use the real BranchReview comparison adapter. */
const fixtureLayer = (
  data: string,
  source: string,
  target: string,
  before: Effect.Effect<void> = Effect.void,
  environment: NodeJS.ProcessEnv = env,
) => {
  const acquisition = Layer.effect(
    BranchReview,
    Effect.gen(function* () {
      const real = yield* BranchReview

      return BranchReview.of({
        ...real,
        prepare: Effect.fn('Fixture.acquire')(function* (root, revisions, permission) {
          expect(permission).toBe('fetch')
          yield* before
          // An executable checkout hook exists, but must never execute.
          yield* Effect.promise(() => mkdir(join(root, '.git/hooks'), { recursive: true }))
          yield* write(
            root,
            '.git/hooks/post-checkout',
            `#!/bin/sh\ntouch '${join(data, 'hook-ran')}'\n`,
          )
          yield* Effect.promise(() => chmod(join(root, '.git/hooks/post-checkout'), 0o755))

          for (const [remote, revision] of [
            [source, revisions.source],
            [target, revisions.target],
          ] as const) {
            yield* Effect.tryPromise({
              try: () =>
                execute(
                  'git',
                  [
                    '-C',
                    root,
                    '-c',
                    'core.hooksPath=/dev/null',
                    'fetch',
                    '--no-recurse-submodules',
                    remote,
                    revision.commit,
                  ],
                  { env },
                ),
              catch: () =>
                new ReviewError({
                  operation: 'fixture acquisition',
                  message: 'Fixture revision unavailable.',
                }),
            })
          }

          return yield* real.prepare(root, revisions, 'local-only')
        }),
      })
    }),
  ).pipe(Layer.provide(makeGitReviewLayer(env)))

  return reviewWorkspacesLayer(data, environment).pipe(Layer.provide(acquisition))
}

it.effect(
  'checks out the complete pinned fork HEAD detached, compares the exact target, and never mutates source clones',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const before = yield* command(f.source, 'status', '--porcelain=v1')

      const prepared = yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces

        return yield* service.prepare(f.resolved)
      }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))

      expect(prepared.review.headCommit).toBe(f.head)
      expect(prepared.review.baseCommit).toBe(f.base)
      expect(prepared.review.baseBranch).toBe('refs/heads/main')
      expect(prepared.review.files).toEqual([{ status: 'M', path: 'changed.ts' }])
      expect(yield* read(prepared.directory, 'unchanged.ts')).toBe(
        'export const unchanged = true\n',
      )
      expect(yield* read(prepared.directory, 'changed.ts')).toBe('export const value = 2\n')
      expect(yield* command(prepared.directory, 'rev-parse', 'HEAD')).toBe(f.head)
      expect(yield* command(prepared.directory, 'branch', '--show-current')).toBe('')
      expect(yield* command(f.source, 'status', '--porcelain=v1')).toBe(before)
      expect(yield* command(f.source, 'rev-parse', 'HEAD')).toBe(f.head)
      expect(yield* command(f.target, 'rev-parse', 'HEAD')).toBe(f.targetHead)
      expect(yield* read(f.source, 'changed.ts')).toBe('source clone edits stay here\n')
      expect(yield* Effect.promise(() => readdir(f.data))).not.toContain('hook-ran')
      expect(yield* Effect.promise(() => readdir(prepared.directory))).not.toContain(
        'workspace.json',
      )
      expect(yield* Effect.promise(() => readdir(dirname(prepared.directory)))).toContain(
        'workspace.json',
      )
    }),
)

it.effect(
  'reopens from durable external metadata without fetching or changing edited/untracked files; new revisions get new directories',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture

      const prepared = yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces

        return yield* service.prepare(f.resolved)
      }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))

      yield* write(prepared.directory, 'changed.ts', 'review edits\n')
      yield* write(prepared.directory, 'my-notes.txt', 'untracked\n')
      // Production factory can restore and reopen offline: acquisition would fail
      // against the deliberately nonexistent remote if reopen tried to fetch.
      yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces
        expect(yield* service.load(prepared.directory)).toEqual(Option.some(prepared))
        expect(yield* service.prepare(f.resolved)).toEqual(prepared)
        expect(yield* service.load(f.source)).toEqual(Option.none())
      }).pipe(Effect.provide(makeReviewWorkspacesLayer(f.data, env)))
      expect(yield* read(prepared.directory, 'changed.ts')).toBe('review edits\n')
      expect(yield* read(prepared.directory, 'my-notes.txt')).toBe('untracked\n')
      yield* command(f.source, 'commit', '-am', 'New head')
      const head = yield* command(f.source, 'rev-parse', 'HEAD')

      const changed = ResolvedPullRequest.make({
        ...f.resolved,
        revisions: {
          ...f.resolved.revisions,
          source: { ...f.resolved.revisions.source, commit: head },
        },
      })

      const newer = yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces

        return yield* service.prepare(changed)
      }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))

      expect(newer.directory).not.toBe(prepared.directory)
      expect(yield* command(newer.directory, 'rev-parse', 'HEAD')).toBe(head)
      expect(yield* read(prepared.directory, 'changed.ts')).toBe('review edits\n')
    }),
)

it.effect('does not publish a failed checkout and releases its lock for a subsequent retry', () =>
  Effect.gen(function* () {
    const f = yield* fixture

    const failed = ResolvedPullRequest.make({
      ...f.resolved,
      revisions: {
        ...f.resolved.revisions,
        source: { ...f.resolved.revisions.source, commit: 'f'.repeat(40) },
      },
    })

    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces
      expect((yield* service.prepare(failed).pipe(Effect.flip))._tag).toBe('ReviewError')
      expect(
        (yield* Effect.promise(() => readdir(join(f.data, 'review-workspaces')))).every((name) =>
          name.endsWith('.sqlite'),
        ),
      ).toBe(true)
      expect((yield* service.prepare(f.resolved)).review.headCommit).toBe(f.head)
    }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))
  }),
)

it.effect('cancels acquisition without publishing broken state or leaving a stale lock', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const started = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces
      const fiber = yield* service.prepare(f.resolved).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }).pipe(
      Effect.provide(
        fixtureLayer(
          f.data,
          f.source,
          f.target,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    )
    expect(
      (yield* Effect.promise(() => readdir(join(f.data, 'review-workspaces')))).every((name) =>
        name.endsWith('.sqlite'),
      ),
    ).toBe(true)
    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces
      expect((yield* service.prepare(f.resolved)).review.headCommit).toBe(f.head)
    }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))
  }),
)

it.effect('refuses a changed checkout identity and preserves files instead of resetting', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces
      const prepared = yield* service.prepare(f.resolved)
      yield* write(prepared.directory, 'changed.ts', 'keep edits\n')
      yield* command(prepared.directory, 'update-ref', 'HEAD', f.base)
      expect((yield* service.prepare(f.resolved).pipe(Effect.flip)).operation).toBe(
        'load workspace',
      )
      expect(yield* command(prepared.directory, 'rev-parse', 'HEAD')).toBe(f.base)
      expect(yield* read(prepared.directory, 'changed.ts')).toBe('keep edits\n')
    }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))
  }),
)

it.live('serializes concurrent preparations and acquires the revisions only once', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const count = yield* Ref.make(0)
    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces

      const results = yield* Effect.all(
        [service.prepare(f.resolved), service.prepare(f.resolved)],
        { concurrency: 'unbounded' },
      )

      expect(results[0]).toEqual(results[1])
      expect(yield* Ref.get(count)).toBe(1)
    }).pipe(
      Effect.provide(
        fixtureLayer(
          f.data,
          f.source,
          f.target,
          Ref.update(count, (value) => value + 1),
        ),
      ),
    )
  }).pipe(Effect.scoped),
)

it.live(
  'honors another process lock, cancels lock waiting, and recovers after the lock holder crashes',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces
        const prepared = yield* service.prepare(f.resolved)
        yield* Effect.gen(function* () {
          yield* foreignLock(`${dirname(prepared.directory)}.sqlite`)

          const waiting = yield* service
            .prepare(f.resolved)
            .pipe(Effect.timeoutOption('100 millis'))

          expect(waiting).toEqual(Option.none())
        }).pipe(Effect.scoped)
        // SIGKILL did not run the child's cleanup, so this proves the lock is owned
        // by the OS rather than a permanent stale lock file or expiring lease.
        expect(yield* service.prepare(f.resolved)).toEqual(prepared)
      }).pipe(Effect.provide(fixtureLayer(f.data, f.source, f.target)))
    }).pipe(Effect.scoped),
)

it.effect(
  'rejects unsafe transports and credential-bearing destinations without leaking private values',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture

      for (const destination of [
        'file:///tmp/secret-token',
        'ext::touch secret-token',
        'https://user:secret-token@github.com/owner/fork.git',
        'https://github.com/owner/fork.git?token=secret-token',
      ]) {
        const input = ResolvedPullRequest.make({
          ...f.resolved,
          revisions: {
            ...f.resolved.revisions,
            source: {
              ...f.resolved.revisions.source,
              remote: Option.some({ name: 'source', destination }),
            },
          },
        })

        yield* Effect.gen(function* () {
          const service = yield* ReviewWorkspaces
          const error = yield* service.prepare(input).pipe(Effect.flip)
          expect(error._tag).toBe('ReviewError')
          expect(JSON.stringify(error)).not.toContain('secret-token')
        }).pipe(Effect.provide(makeReviewWorkspacesLayer(f.data, env)))
      }

      expect(
        (yield* Effect.promise(() => readdir(join(f.data, 'review-workspaces')))).every((name) =>
          name.endsWith('.sqlite'),
        ),
      ).toBe(true)
    }),
)

it.effect('ignores inherited Git configuration, filter commands and executable templates', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const hooks = join(f.root, 'hostile-hooks')
    const template = join(f.root, 'template')
    const marker = join(f.root, 'executed')
    const global = join(f.root, 'global.gitconfig')
    yield* Effect.promise(() => mkdir(hooks))
    yield* Effect.promise(() => mkdir(join(template, 'hooks'), { recursive: true }))
    const script = `#!/bin/sh\ntouch '${marker}'\n`
    yield* write(hooks, 'post-checkout', script)
    yield* write(template, 'hooks/post-checkout', script)
    yield* Effect.promise(() => chmod(join(hooks, 'post-checkout'), 0o755))
    yield* Effect.promise(() => chmod(join(template, 'hooks/post-checkout'), 0o755))
    yield* write(
      f.root,
      'global.gitconfig',
      `[core]\nhooksPath = ${hooks}\n[filter "hostile"]\nsmudge = touch '${marker}'\nrequired = true\n`,
    )
    yield* Effect.gen(function* () {
      const service = yield* ReviewWorkspaces
      const prepared = yield* service.prepare(f.resolved)
      expect(yield* read(prepared.directory, 'unchanged.ts')).toBe(
        'export const unchanged = true\n',
      )
      expect(yield* command(prepared.directory, 'config', '--local', 'core.hooksPath')).toBe(
        '/dev/null',
      )
    }).pipe(
      Effect.provide(
        fixtureLayer(f.data, f.source, f.target, Effect.void, {
          ...env,
          GIT_CONFIG_GLOBAL: global,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'filter.hostile.smudge',
          GIT_CONFIG_VALUE_0: `touch '${marker}'`,
          GIT_TEMPLATE_DIR: template,
          GIT_DIR: join(f.source, '.git'),
          GIT_WORK_TREE: f.source,
        }),
      ),
    )
    expect(yield* Effect.promise(() => readdir(f.root))).not.toContain('executed')
    expect(yield* command(f.source, 'rev-parse', 'HEAD')).toBe(f.head)
  }),
)

it.effect(
  'forwards only trusted credential configuration while keeping checkout filters isolated',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const bin = join(f.root, 'bin')
      const helper = join(f.root, 'credential-helper')
      const used = join(f.root, 'helper-used')
      const hostile = join(f.root, 'hostile-ran')
      const global = join(f.root, 'credentials.gitconfig')
      const system = join(f.root, 'system.gitconfig')
      const included = join(f.root, 'included.gitconfig')

      const realGit = (yield* Effect.promise(() =>
        execute('which', ['git'], { env }),
      )).stdout.trim()

      yield* Effect.promise(() => mkdir(bin))
      yield* write(
        f.root,
        'credential-helper',
        `#!/bin/sh\ntouch '${used}'\nprintf 'username=fixture-user\\npassword=fixture-password\\n'\n`,
      )
      yield* Effect.promise(() => chmod(helper, 0o755))
      // The test wrapper probes the actual Git credential machinery with the exact
      // isolated checkout environment. No external network or real secret is used.
      yield* write(
        bin,
        'git',
        `#!/bin/sh\nfor arg do\n  if [ "$arg" = checkout ]; then\n    printf 'protocol=https\\nhost=github.com\\n\\n' | "$DUFF_TEST_REAL_GIT" credential fill >/dev/null || exit 91\n  fi\ndone\nexec "$DUFF_TEST_REAL_GIT" "$@"\n`,
      )
      yield* Effect.promise(() => chmod(join(bin, 'git'), 0o755))
      yield* write(f.root, 'system.gitconfig', `[credential]\nhelper = !touch '${hostile}'\n`)
      yield* write(
        f.root,
        'credentials.gitconfig',
        `[credential]\nhelper =\n[include]\npath = ${included}\n[filter "hostile"]\nsmudge = touch '${hostile}'\nrequired = true\n`,
      )
      yield* write(
        f.root,
        'included.gitconfig',
        `[credential "https://github.com"]\nhelper = ${helper}\nuseHttpPath = true\n`,
      )
      yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces
        const prepared = yield* service.prepare(f.resolved)
        expect(yield* read(prepared.directory, 'changed.ts')).toBe('export const value = 2\n')
        expect(yield* Effect.promise(() => readdir(f.root))).toContain('helper-used')
        expect(yield* Effect.promise(() => readdir(f.root))).not.toContain('hostile-ran')
        const metadata = yield* read(dirname(prepared.directory), 'workspace.json')
        const config = yield* read(prepared.directory, '.git/config')

        for (const privateValue of [helper, 'fixture-password']) {
          expect(metadata).not.toContain(privateValue)
          expect(config).not.toContain(privateValue)
        }
      }).pipe(
        Effect.provide(
          fixtureLayer(f.data, f.source, f.target, Effect.void, {
            ...env,
            PATH: `${bin}:${env.PATH ?? ''}`,
            DUFF_TEST_REAL_GIT: realGit,
            GIT_CONFIG_GLOBAL: global,
            GIT_CONFIG_SYSTEM: system,
            GIT_CONFIG_NOSYSTEM: '0',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: `!touch '${hostile}'`,
          }),
        ),
      )
    }),
)

it.effect(
  'reports credential configuration read failures without exposing configuration contents',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const global = join(f.root, 'invalid.gitconfig')
      yield* write(f.root, 'invalid.gitconfig', '[private-credential-canary\n')
      yield* Effect.gen(function* () {
        const service = yield* ReviewWorkspaces
        const error = yield* service.prepare(f.resolved).pipe(Effect.flip)
        expect(error.operation).toBe('read Git credential configuration')
        expect(JSON.stringify(error)).not.toContain('private-credential-canary')
        expect(JSON.stringify(error)).not.toContain(global)
      }).pipe(
        Effect.provide(makeReviewWorkspacesLayer(f.data, { ...env, GIT_CONFIG_GLOBAL: global })),
      )
      expect(yield* Effect.promise(() => readdir(f.root))).not.toContain('data')
    }),
)
