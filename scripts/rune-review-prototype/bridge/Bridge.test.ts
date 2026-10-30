import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { makeBridge, standaloneDataDirectory } from './Bridge'

const exec = promisify(execFile)

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'duff-rune-bridge-'))
    const root = join(directory, 'repository')
    const data = join(directory, 'data')

    await mkdir(root)

    const git = (...args: string[]) =>
      exec('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })

    await git('init', '--initial-branch=main')
    await git('config', 'user.email', 'test@example.invalid')
    await git('config', 'user.name', 'Fixture')
    await writeFile(join(root, 'modified.txt'), 'old\n')
    await writeFile(join(root, 'deleted.txt'), 'deleted\n')
    await writeFile(join(root, 'before.txt'), 'renamed content\n')
    await git('add', '.')
    await git('commit', '-m', 'base')
    await git('branch', 'base')
    await writeFile(join(root, 'modified.txt'), 'new\n')
    await writeFile(join(root, 'added.txt'), 'added\n')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 0]))
    await writeFile(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
    await git('rm', 'deleted.txt')
    await git('mv', 'before.txt', 'after.txt')
    await git('add', '.')
    await git('commit', '-m', 'head')

    return { directory, root, data, git }
  }),
  (fixture) => Effect.promise(() => rm(fixture.directory, { recursive: true, force: true })),
)

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

it.effect(
  'reads real immutable add/delete/rename snapshots and durably resumes viewed and last-file state',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'base'))

      expect(review.files).toEqual(
        expect.arrayContaining([
          { path: 'added.txt', status: 'A', viewed: false },
          { path: 'deleted.txt', status: 'D', viewed: false },
          { path: 'after.txt', status: 'R', viewed: false },
        ]),
      )

      yield* Effect.promise(() =>
        writeFile(join(local.root, 'modified.txt'), 'uncommitted owner text\n'),
      )

      const cases = [
        ['modified.txt', 'old\n', 'new\n'],
        ['added.txt', '', 'added\n'],
        ['deleted.txt', 'deleted\n', ''],
        ['after.txt', 'renamed content\n', 'renamed content\n'],
      ]

      for (const [path, oldText, newText] of cases) {
        const response = yield* Effect.promise(() =>
          bridge.handle(JSON.stringify({ id: 1, op: 'file', session: review.session, path })),
        )

        expect(response).toEqual({
          id: 1,
          ok: true,
          kind: 'file',
          session: review.session,
          path,
          oldText,
          newText,
          binary: false,
        })
      }

      for (const path of ['../modified.txt', 'not-in-review.txt', 'binary.dat', 'large.txt']) {
        const response = yield* Effect.promise(() =>
          bridge.handle(JSON.stringify({ id: 2, op: 'file', session: review.session, path })),
        )

        expect(response.ok).toBe(false)
        expect(response).not.toHaveProperty('newText')
      }

      expect(
        yield* Effect.promise(() =>
          bridge.handle(
            JSON.stringify({
              id: 3,
              op: 'viewed',
              session: review.session,
              path: 'modified.txt',
              viewed: true,
            }),
          ),
        ),
      ).toEqual({
        id: 3,
        ok: true,
        kind: 'viewed',
        session: review.session,
        path: 'modified.txt',
        viewed: true,
      })

      const persisted = yield* Effect.promise(() =>
        readFile(join(local.data, 'sessions', 'reviews.json'), 'utf8'),
      )

      expect(persisted).toContain('modified.txt')
      yield* Effect.promise(() => bridge.dispose())

      const reopened = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      const resumed = yield* Effect.promise(() =>
        reopened.handle(JSON.stringify({ id: 4, op: 'resume', session: review.session })),
      )

      expect(resumed).toMatchObject({
        id: 4,
        ok: true,
        kind: 'review',
        baseCommit: review.baseCommit,
        headCommit: review.headCommit,
        lastFile: 'after.txt',
      })

      if (resumed.ok && resumed.kind === 'review')
        expect(resumed.files.find((file) => file.path === 'modified.txt')?.viewed).toBe(true)
      else expect.fail('Expected review response')
      expect(yield* Effect.promise(() => readFile(join(local.root, 'modified.txt'), 'utf8'))).toBe(
        'uncommitted owner text\n',
      )
      expect(
        (yield* Effect.promise(() => local.git('branch', '--show-current'))).stdout.trim(),
      ).toBe('main')
      const wire = JSON.stringify(resumed)

      expect(wire).not.toContain(local.root)
      expect(wire).not.toContain('retention')
    }),
  { timeout: 20000 },
)

it.effect(
  'validates requests and returns finite CLI authentication failures without leaking input',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeBridge(local.data, {
            ...environment,
            GH_TOKEN: 'private-secret-with-invalid-characters!',
          }),
        ),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      for (const line of [
        '{',
        '{"id":9,"op":"unknown"}',
        '{"id":9007199254740992,"op":"saved"}',
        '{"id":1.5,"op":"saved"}',
        '{"id":7,"op":"viewed","session":"bad","path":"a","viewed":true}',
      ]) {
        const response = yield* Effect.promise(() => bridge.handle(line))

        expect(response.ok).toBe(false)
        expect(response).toHaveProperty('error', 'Invalid request.')
      }

      const response = yield* Effect.promise(() =>
        bridge.handle(
          '{"id":10,"op":"list","destination":"https://github.com/example/repository"}',
        ),
      )

      expect(response).toEqual({
        id: 10,
        ok: false,
        error: 'Authentication unavailable. Sign in with the provider CLI and retry.',
      })
      expect(JSON.stringify(response)).not.toContain('private-secret')
      expect(
        yield* Effect.promise(() =>
          bridge.handle('{"id":11,"op":"list","destination":"file:///private/path"}'),
        ),
      ).toMatchObject({ id: 11, ok: false })
      expect(
        yield* Effect.promise(() =>
          bridge.handle(
            '{"id":12,"op":"list","destination":"https://github.com/example/repository","more":true}',
          ),
        ),
      ).toMatchObject({ id: 12, ok: false })
    }),
  { timeout: 20000 },
)

it.effect(
  'runs the bundled Node JSON-lines process and releases the catalog lease on EOF and SIGTERM',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture
      const script = join(process.cwd(), 'scripts/rune-review-prototype/bridge/dist/bridge.mjs')

      for (const signal of [false, true]) {
        const output = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(process.execPath, [script], {
                env: { ...environment, DUFF_STANDALONE_DATA: local.data },
                stdio: ['pipe', 'pipe', 'ignore'],
              })

              let output = ''
              let signalled = false

              child.stdout.on('data', (chunk: Buffer) => {
                output += chunk.toString('utf8')

                if (signal && output.includes('\n') && !signalled) {
                  signalled = true
                  child.kill('SIGTERM')
                }
              })
              child.once('error', reject)
              child.once('exit', (code) =>
                code === 0 ? resolve(output) : reject(new Error('Node bridge failed')),
              )
              child.stdin.write('{"id":1,"op":"saved"}\n')

              if (!signal) child.stdin.end('{"id":2,"op":"unknown"}\n')
            }),
        )

        const lines = output.trim().split('\n')

        expect(lines[0]).toBe('{"id":1,"ok":true,"kind":"saved","items":[]}')

        if (!signal) expect(lines[1]).toBe('{"id":2,"ok":false,"error":"Invalid request."}')

        const lockPresent = yield* Effect.promise(() =>
          access(join(local.data, 'sessions', 'reviews.lock')).then(
            () => true,
            () => false,
          ),
        )

        expect(lockPresent).toBe(false)
      }
    }),
  { timeout: 20000 },
)

it.effect('uses standalone-only platform paths and an explicit override', () =>
  Effect.sync(() => {
    expect(standaloneDataDirectory({}, 'darwin', '/home/test')).toBe(
      '/home/test/Library/Application Support/Duff-Standalone',
    )
    expect(standaloneDataDirectory({ XDG_DATA_HOME: '/data' }, 'linux', '/home/test')).toBe(
      '/data/Duff-Standalone',
    )
    expect(standaloneDataDirectory({ LOCALAPPDATA: '/local' }, 'win32', '/home/test')).toBe(
      '/local/Duff-Standalone',
    )
    expect(
      standaloneDataDirectory({ DUFF_STANDALONE_DATA: '/isolated' }, 'linux', '/home/test'),
    ).toBe('/isolated')
    expect(standaloneDataDirectory({}, 'linux', '/home/test')).toBe(
      '/home/test/.local/share/Duff-Standalone',
    )
  }),
)

it.effect('does not acknowledge viewed state when the durable catalog cannot be written', () =>
  Effect.gen(function* () {
    const local = yield* fixture

    const bridge = yield* Effect.acquireRelease(
      Effect.sync(() => makeBridge(local.data, environment)),
      (bridge) => Effect.promise(() => bridge.dispose()),
    )

    const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'base'))
    const catalog = join(local.data, 'sessions', 'reviews.json')

    // A real filesystem failure, not a mocked storage adapter.
    yield* Effect.promise(() => rm(catalog))
    yield* Effect.promise(() => mkdir(catalog))

    const response = yield* Effect.promise(() =>
      bridge.handle(
        JSON.stringify({
          id: 20,
          op: 'viewed',
          session: review.session,
          path: 'modified.txt',
          viewed: true,
        }),
      ),
    )

    expect(response).toEqual({ id: 20, ok: false, error: 'Saved review storage unavailable.' })
    expect(response).not.toHaveProperty('viewed')
  }),
)
