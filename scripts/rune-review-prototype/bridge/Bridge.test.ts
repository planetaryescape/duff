import { execFile, spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  access,
  copyFile,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

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

const script = fileURLToPath(new URL('./dist/bridge.mjs', import.meta.url))

// Resolve a disposable toolchain beside a copied bundle, never the installed real LSP.
async function heldLanguageStartup(directory: string) {
  const toolchain = join(directory, 'toolchain')
  const entry = join(toolchain, 'held-startup-bridge.mjs')
  const temporary = join(directory, 'temporary')
  const acquired = join(directory, 'startup-acquired.json')
  const server = join(toolchain, 'node_modules', 'typescript-language-server')
  const typescript = join(toolchain, 'node_modules', 'typescript')
  const tsserver = join(typescript, 'lib', 'tsserver.js')

  await mkdir(join(server, 'lib'), { recursive: true })
  await mkdir(join(typescript, 'lib'), { recursive: true })
  await mkdir(temporary)
  await copyFile(script, entry)
  await writeFile(join(server, 'package.json'), '{"name":"typescript-language-server"}')
  await writeFile(join(typescript, 'package.json'), '{"name":"typescript"}')
  await writeFile(tsserver, `process.stdout.write('acquired'); setInterval(() => {}, 1000);`)
  await writeFile(
    join(server, 'lib', 'cli.mjs'),
    `import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
let input = '';
let started = false;
process.stdin.on('data', chunk => {
  input += chunk;
  if (started || !input.includes('"method":"initialize"')) return;
  started = true;
  const child = spawn(process.execPath, [${JSON.stringify(tsserver)}], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', () => {
    writeFileSync(${JSON.stringify(`${acquired}.pending`)}, JSON.stringify({ pids: [process.pid, child.pid], root: process.cwd() }));
    renameSync(${JSON.stringify(`${acquired}.pending`)}, ${JSON.stringify(acquired)});
  });
  // Deliberately never reply to initialize: readiness cannot race the control line.
});
`,
  )

  async function waitForAcquisition(attempt = 0): Promise<{
    pids: readonly number[]
    root: string
  }> {
    let text: string | undefined

    try {
      text = await readFile(acquired, 'utf8')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }

    if (text !== undefined)
      return Schema.decodeUnknownSync(
        Schema.Struct({ pids: Schema.Array(Schema.Int), root: Schema.String }),
      )(JSON.parse(text))

    if (attempt >= 200)
      throw new Error('Controlled toolchain did not acquire its initialize request and child')

    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    return waitForAcquisition(attempt + 1)
  }

  return { entry, temporary, acquired: () => waitForAcquisition() }
}

const languageFixture = Effect.gen(function* () {
  const local = yield* fixture

  yield* Effect.promise(async () => {
    await local.git('rm', 'large.txt', 'binary.dat')
    await writeFile(join(local.root, 'stable.ts'), 'export const stable: Date = new Date()\n')
    await writeFile(join(local.root, 'types.ts'), 'export const value: number = 42\n')
    await writeFile(join(local.root, 'data.json'), '{"files":["literal"],"answer":42}\n')
    await writeFile(
      join(local.root, 'use.ts'),
      'import { value } from "./types"\r\n\tconst emoji = "😀"; value\r\nimport { stable } from "@stable"\r\nstable\r\nimport data from "./data.json"\r\ndata.answer\r\n',
    )
    await writeFile(
      join(local.root, 'component.tsx'),
      'import { value } from "./types"\nexport const Component = () => <div>{value}</div>\n',
    )
    await writeFile(
      join(local.root, 'multiple.ts'),
      'interface Merged { first: string }\ninterface Merged { second: number }\nconst item: Merged = { first: "", second: 1 }\nitem\n',
    )
    await writeFile(
      join(local.root, 'missing.ts'),
      'import { missing } from "dependency-not-installed"\nexport const local: number = 7\nmissing; local\n',
    )
    await mkdir(join(local.root, 'evil'))
    await writeFile(join(local.root, 'evil', 'package.json'), '{"name":"evil","main":"index.js"}')
    await writeFile(
      join(local.root, 'evil', 'index.js'),
      `require('fs').writeFileSync(${JSON.stringify(join(local.directory, 'plugin-executed'))}, 'executed'); module.exports = () => ({ create: x => x.languageService });`,
    )
    await writeFile(
      join(local.root, 'tsconfig.json'),
      JSON.stringify({
        extends: './analysis-root.json',
        compilerOptions: {
          strict: true,
          jsx: 'preserve',
          baseUrl: '.',
          paths: { '@stable': ['./stable.ts'] },
        },
      }),
    )
    await writeFile(join(local.root, 'analysis-root.json'), '{"extends":"./analysis-base.json"}')
    await writeFile(
      join(local.root, 'analysis-base.json'),
      JSON.stringify({
        compilerOptions: {
          resolveJsonModule: true,
          esModuleInterop: true,
          moduleResolution: 'node',
          plugins: [{ name: './evil' }],
        },
      }),
    )
    await local.git('add', '.')
    await local.git('commit', '-m', 'language base')
    await local.git('branch', 'language-base')
    // Advance the target independently: the old context must still use the merge base.
    await local.git('checkout', 'language-base')
    await writeFile(join(local.root, 'target-only.ts'), 'export const notTheBase = true\n')
    await local.git('add', '.')
    await local.git('commit', '-m', 'target tip')
    await local.git('checkout', 'main')
    await writeFile(join(local.root, 'types.ts'), '\n\nexport const value: string = "head"\n')
    await local.git('mv', 'use.ts', 'renamed.ts')

    // Make the other fixture sources queryable changed files without changing their declarations.
    await Promise.all(
      ['component.tsx', 'multiple.ts', 'missing.ts'].map(async (path) => {
        const text = await readFile(join(local.root, path), 'utf8')
        await writeFile(join(local.root, path), `${text}\n`)
      }),
    )

    await local.git('add', '.')
    await local.git('commit', '-m', 'language head')
  })

  return local
})

async function childProcesses(parent: number | undefined) {
  if (parent === undefined) throw new Error('Missing process ID')
  const table = (await exec('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 1048576 })).stdout

  const entries = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ pid: Schema.Int, parent: Schema.Int, command: Schema.String })),
  )(
    table
      .trim()
      .split('\n')
      .map((line) => {
        const parts = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)

        return { pid: Number(parts?.[1]), parent: Number(parts?.[2]), command: parts?.[3] }
      }),
  )

  const selected = new Set([parent])
  let size = 0

  while (size !== selected.size) {
    size = selected.size

    for (const entry of entries) if (selected.has(entry.parent)) selected.add(entry.pid)
  }

  selected.delete(parent)

  return entries.flatMap((entry) =>
    selected.has(entry.pid) &&
    (entry.command.includes('/typescript-language-server/lib/cli.mjs') ||
      entry.command.includes('/typescript/lib/tsserver.js'))
      ? [entry.pid]
      : [],
  )
}

const bridgeProcess = (data: string, options: { entry?: string; temporary?: string } = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(process.execPath, [options.entry ?? script], {
        env: {
          ...environment,
          DUFF_STANDALONE_DATA: data,
          TMPDIR: options.temporary ?? tmpdir(),
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      })

      const exit = new Promise<number | null>((resolve) => {
        child.once('close', resolve)
        child.once('error', () => resolve(-1))
      })

      const lines = createInterface({ input: child.stdout })
      child.stdin.on('error', () => undefined)

      return { child, exit, lines, iterator: lines[Symbol.asyncIterator]() }
    }),
    (owned) =>
      Effect.promise(async () => {
        if (owned.child.exitCode === null) owned.child.stdin.end('{"op":"shutdown"}\n')
        await owned.exit
        owned.lines.close()
      }),
  )

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

        expect(lines).toContain('{"id":1,"ok":true,"kind":"saved","items":[]}')

        if (!signal) expect(lines).toContain('{"id":2,"ok":false,"error":"Invalid request."}')

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

it.live(
  'shutdown interrupts an active CLI process and its ordinary descendant',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture
      const bin = join(local.directory, 'bin')
      const marker = join(local.directory, 'active-cli.json')

      yield* Effect.promise(async () => {
        await mkdir(bin)
        // Exercise the actual command spawner and process-group cleanup, without credentials.
        await writeFile(
          join(bin, 'gh'),
          `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.DUFF_TEST_MARKER, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`,
          { mode: 0o755 },
        )
      })

      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(process.execPath, [script], {
            env: {
              ...environment,
              PATH: `${bin}:${process.env.PATH}`,
              GH_TOKEN: '',
              GITHUB_TOKEN: '',
              DUFF_STANDALONE_DATA: local.data,
              DUFF_TEST_MARKER: marker,
            },
            stdio: ['pipe', 'pipe', 'ignore'],
          }),
        ),
        (child) =>
          Effect.sync(() => {
            if (child.exitCode === null) child.kill('SIGTERM')
          }),
      )

      child.stdin.write(
        '{"id":1,"op":"list","destination":"https://github.com/example/repository"}\n',
      )
      let markerText = ''

      for (let attempt = 0; attempt < 100 && !markerText; attempt += 1) {
        markerText = yield* Effect.promise(() => readFile(marker, 'utf8').catch(() => ''))

        if (!markerText) yield* Effect.sleep('100 millis')
      }

      const pids = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(Schema.Int)),
      )(markerText)

      expect(pids).toHaveLength(2)

      const started = Date.now()

      const exit = yield* Effect.promise(
        () =>
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', resolve)
            // Exactly the private control line sent by the native Bridge's Drop implementation.
            child.stdin.end('{"op":"shutdown"}\n')
          }),
      )

      expect(exit).toBe(0)
      // Without the control handler the CLI request runs until its 12-second timeout.
      expect(Date.now() - started).toBeLessThan(5000)

      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }),
  { timeout: 20000 },
)

it.live(
  'requires trust and answers real TypeScript queries from both immutable revisions, not dirty files',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

      const request = (op: string, side = 'new', path = 'renamed.ts', character = 21) =>
        bridge.handle(
          JSON.stringify({ id: 80, op, session: review.session, path, side, line: 1, character }),
        )

      expect(yield* Effect.promise(() => request('hover'))).toMatchObject({ id: 80, ok: false })

      const enabled = yield* Effect.promise(() =>
        bridge.handle(JSON.stringify({ id: 81, op: 'language-enable', session: review.session })),
      )

      expect(enabled).toMatchObject({ id: 81, ok: true, kind: 'language', state: 'limited' })

      for (const side of ['old', 'new']) {
        const dataHover = yield* Effect.promise(() =>
          bridge.handle(
            JSON.stringify({
              id: 82,
              op: 'hover',
              session: review.session,
              path: 'renamed.ts',
              side,
              line: 5,
              character: 7,
            }),
          ),
        )

        if (dataHover.ok && dataHover.kind === 'hover')
          expect(dataHover.content).toContain('"answer": number')
        else expect.fail('Expected immutable JSON data hover')
      }

      yield* Effect.promise(() =>
        writeFile(join(local.root, 'types.ts'), 'export const value: boolean = false\n'),
      )

      for (const [side, type, commit, line] of [
        ['old', 'number', review.baseCommit, 0],
        ['new', 'string', review.headCommit, 2],
      ] as const) {
        const hover = yield* Effect.promise(() => request('hover', side))
        expect(hover).toMatchObject({
          ok: true,
          kind: 'hover',
          side,
        })

        if (hover.ok && hover.kind === 'hover') expect(hover.content).toContain(type)
        else expect.fail('Expected hover')

        const definition = yield* Effect.promise(() => request('definition', side))
        expect(definition).toMatchObject({
          ok: true,
          kind: 'definition',
          side,
        })

        if (definition.ok && definition.kind === 'definition') {
          expect(definition.targets).toHaveLength(1)
          expect(definition.targets[0]).toMatchObject({ path: 'types.ts', commit, line })
          expect(definition.targets[0]?.text).toContain(type)
        } else expect.fail('Expected definition')
      }

      for (const path of [
        '../types.ts',
        'file:///etc/passwd',
        'https://example.invalid/a.ts',
        'types.ts',
      ])
        expect(yield* Effect.promise(() => request('definition', 'new', path))).toMatchObject({
          ok: false,
        })

      const noResult = yield* Effect.promise(() => request('definition', 'new', 'renamed.ts', 0))
      expect(noResult).toMatchObject({ ok: true, targets: [] })

      for (const [path, line, character, expected] of [
        ['component.tsx', 1, 37, 'string'],
        ['renamed.ts', 3, 2, 'Date'],
        ['missing.ts', 2, 10, 'number'],
      ] as const) {
        const response = yield* Effect.promise(() =>
          bridge.handle(
            JSON.stringify({
              id: 82,
              op: 'hover',
              session: review.session,
              path,
              side: 'new',
              line,
              character,
            }),
          ),
        )

        expect(response.ok).toBe(true)

        if (response.ok && response.kind === 'hover') {
          expect(response.content).toContain(expected)
          expect(response.message).toContain('Limited')
        } else expect.fail('Expected local source hover')
      }

      const unchanged = yield* Effect.promise(() =>
        bridge.handle(
          JSON.stringify({
            id: 83,
            op: 'definition',
            session: review.session,
            path: 'renamed.ts',
            side: 'new',
            line: 3,
            character: 2,
          }),
        ),
      )

      expect(unchanged).toMatchObject({
        ok: true,
        kind: 'definition',
        targets: [
          {
            path: 'stable.ts',
            commit: review.headCommit,
            line: 0,
            character: 13,
            startLine: 0,
            text: 'export const stable: Date = new Date()\n',
          },
        ],
      })

      const multiple = yield* Effect.promise(() =>
        bridge.handle(
          JSON.stringify({
            id: 84,
            op: 'definition',
            session: review.session,
            path: 'multiple.ts',
            side: 'new',
            line: 2,
            character: 13,
          }),
        ),
      )

      if (multiple.ok && multiple.kind === 'definition')
        expect(multiple.targets.map((target) => target.line)).toEqual([0, 1])
      else expect.fail('Expected merged declaration definitions')

      for (const character of [-1, 17, 9999999]) {
        const invalid = yield* Effect.promise(() =>
          request('hover', 'new', 'renamed.ts', character),
        )

        expect(invalid).toMatchObject({ ok: false })
      }

      const disabled = yield* Effect.promise(() =>
        bridge.handle(JSON.stringify({ id: 85, op: 'language-disable', session: review.session })),
      )

      expect(disabled).toMatchObject({ id: 85, ok: true, state: 'unavailable' })
      expect(yield* Effect.promise(() => request('hover'))).toMatchObject({ ok: false })
      expect(
        yield* Effect.promise(() =>
          access(join(local.directory, 'plugin-executed')).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(yield* Effect.promise(() => readFile(join(local.root, 'types.ts'), 'utf8'))).toContain(
        'boolean',
      )
    }),
  { timeout: 60000 },
)

it.live(
  'multiplexes viewed writes during a cold real query, cancels correlated reads, and closes the entire language process tree',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture
      const bridge = makeBridge(local.data, environment)
      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

      yield* Effect.promise(() => bridge.dispose())

      const process = yield* bridgeProcess(local.data)

      const send = (request: Schema.JsonObject) =>
        process.child.stdin.write(`${JSON.stringify(request)}\n`)

      const next = () => process.iterator.next().then((line) => line.value ?? '')

      send({ id: 100, op: 'language-enable', session: review.session })
      expect(yield* Effect.promise(next)).toContain('"state":"limited"')

      const pids = yield* Effect.promise(() => childProcesses(process.child.pid))
      expect(pids.length).toBeGreaterThanOrEqual(4)

      send({
        id: 101,
        op: 'hover',
        session: review.session,
        path: 'renamed.ts',
        side: 'new',
        line: 1,
        character: 21,
      })
      send({ id: 102, op: 'viewed', session: review.session, path: 'renamed.ts', viewed: true })
      expect(yield* Effect.promise(next)).toContain('"kind":"viewed"')

      // A targeted cancellation cannot cancel the already-acknowledged durable write.
      send({ id: 103, op: 'language-cancel', requestId: 101 })
      const cancelled = yield* Effect.promise(async () => Promise.all([next(), next()]))
      expect(cancelled.some((line) => line.includes('"id":101,"ok":false'))).toBe(true)
      expect(cancelled.some((line) => line.includes('"kind":"language-cancelled"'))).toBe(true)

      send({
        id: 104,
        op: 'hover',
        session: review.session,
        path: 'renamed.ts',
        side: 'old',
        line: 1,
        character: 21,
      })
      send({ id: 105, op: 'viewed', session: review.session, path: 'renamed.ts', viewed: false })
      expect(yield* Effect.promise(next)).toContain('"kind":"viewed"')

      const started = Date.now()
      process.child.stdin.end('{"op":"shutdown"}\n')
      expect(yield* Effect.promise(() => process.exit)).toBe(0)
      expect(Date.now() - started).toBeLessThan(5000)

      for (const pid of pids) expect(() => globalThis.process.kill(pid, 0)).toThrow()

      const reopened = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      const resumed = yield* Effect.promise(() =>
        reopened.handle(JSON.stringify({ id: 106, op: 'resume', session: review.session })),
      )

      if (resumed.ok && resumed.kind === 'review')
        expect(resumed.files.find((file) => file.path === 'renamed.ts')?.viewed).toBe(false)
      else expect.fail('Expected durable review state')
    }),
  { timeout: 30000 },
)

it.live(
  'invalidates pending trust and supersedes real queries without blocking progress',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

      const enable = () =>
        bridge.handle(JSON.stringify({ id: 120, op: 'language-enable', session: review.session }))

      const hover = (id: number, side = 'new') =>
        bridge.handle(
          JSON.stringify({
            id,
            op: 'hover',
            session: review.session,
            path: 'renamed.ts',
            side,
            line: 1,
            character: 21,
          }),
        )

      const disabled = yield* Effect.promise(() =>
        Promise.all([
          enable(),
          bridge.handle(
            JSON.stringify({ id: 121, op: 'language-disable', session: review.session }),
          ),
        ]),
      )

      expect(disabled[0]).not.toMatchObject({ state: 'limited' })
      expect(disabled[1]).toMatchObject({ id: 121, ok: true, state: 'unavailable' })
      expect(yield* Effect.promise(() => hover(122))).toMatchObject({
        id: 122,
        ok: false,
        error: 'Language analysis unavailable.',
      })
      expect(yield* Effect.promise(enable)).toMatchObject({ state: 'limited' })

      const responses = yield* Effect.promise(() =>
        Promise.all([
          hover(123, 'old'),
          hover(124, 'new'),
          bridge.handle(
            JSON.stringify({
              id: 125,
              op: 'viewed',
              session: review.session,
              path: 'renamed.ts',
              viewed: true,
            }),
          ),
        ]),
      )

      expect(responses[0]).toMatchObject({
        id: 123,
        ok: false,
        error: 'Language analysis unavailable.',
      })
      expect(responses[1]).toMatchObject({ id: 124, ok: true, kind: 'hover' })
      expect(responses[2]).toMatchObject({ id: 125, ok: true, kind: 'viewed', viewed: true })

      // Also cover a readiness reply already in transit when native Escape cancels its ID.
      expect(
        yield* Effect.promise(() =>
          bridge.handle('{"id":126,"op":"language-cancel","requestId":120}'),
        ),
      ).toMatchObject({ id: 126, ok: true, kind: 'language-cancelled', requestId: 120 })
      expect(yield* Effect.promise(() => hover(127))).toMatchObject({
        id: 127,
        ok: false,
        error: 'Language analysis unavailable.',
      })
    }),
  { timeout: 30000 },
)

it.live(
  'the native shutdown control line joins held toolchain initialization and its acquired process group',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture
      const bridge = makeBridge(local.data, environment)
      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

      yield* Effect.promise(() => bridge.dispose())

      const startup = yield* Effect.promise(() => heldLanguageStartup(local.directory))
      const owned = yield* bridgeProcess(local.data, startup)
      const responses: string[] = []
      owned.lines.on('line', (line) => responses.push(line))
      owned.child.stdin.write(
        `${JSON.stringify({ id: 130, op: 'language-enable', session: review.session })}\n`,
      )
      const { pids, root } = yield* Effect.promise(startup.acquired)

      expect(pids).toHaveLength(2)
      expect(yield* Effect.promise(() => childProcesses(owned.child.pid))).toEqual(pids)
      expect(yield* Effect.promise(() => readdir(root))).toContain('types.ts')
      expect(responses.some((line) => line.includes('"state":"limited"'))).toBe(false)
      const started = Date.now()
      owned.child.stdin.end('{"op":"shutdown"}\n')

      expect(yield* Effect.promise(() => owned.exit)).toBe(0)
      expect(Date.now() - started).toBeLessThan(5000)

      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow()
        // A leader can acquire another child between the observation and shutdown.
        expect(() => process.kill(-pid, 0)).toThrow()
      }

      expect(yield* Effect.promise(() => readdir(startup.temporary))).toEqual([])
    }),
  { timeout: 30000 },
)

it.live(
  'rejects non-JSON referenced configs before starting project tooling',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      for (const path of ['unsafe.jsonc', 'unsafe.txt', 'unsafe']) {
        yield* Effect.promise(async () => {
          await writeFile(
            join(local.root, path),
            '{"compilerOptions":{"plugins":[{"name":"./evil"}]}}',
          )
          await writeFile(
            join(local.root, 'tsconfig.json'),
            JSON.stringify({ extends: `./${path}` }),
          )
          await local.git('add', '.')
          await local.git('commit', '-m', 'unsupported config')
        })
        const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

        const enabled = yield* Effect.promise(() =>
          bridge.handle(
            JSON.stringify({ id: 140, op: 'language-enable', session: review.session }),
          ),
        )

        expect(enabled).toMatchObject({
          id: 140,
          ok: true,
          kind: 'language',
          session: review.session,
          state: 'unavailable',
        })
        expect(
          yield* Effect.promise(() =>
            access(join(local.directory, 'plugin-executed')).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }
    }),
  { timeout: 30000 },
)

it.live(
  'cancels an enable ID during held toolchain initialization, leaving no context, sources or process group',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture
      const bridge = makeBridge(local.data, environment)
      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))
      yield* Effect.promise(() => bridge.dispose())
      const startup = yield* Effect.promise(() => heldLanguageStartup(local.directory))
      const owned = yield* bridgeProcess(local.data, startup)
      const next = () => owned.iterator.next().then((line) => line.value ?? '')
      const replies: string[] = []
      owned.lines.on('line', (line) => replies.push(line))
      owned.child.stdin.write(
        `${JSON.stringify({ id: 150, op: 'language-enable', session: review.session })}\n`,
      )
      const { pids, root } = yield* Effect.promise(startup.acquired)

      expect(pids).toHaveLength(2)
      expect(yield* Effect.promise(() => childProcesses(owned.child.pid))).toEqual(pids)
      expect(yield* Effect.promise(() => readdir(root))).toContain('types.ts')
      expect(replies.some((line) => line.includes('"state":"limited"'))).toBe(false)
      owned.child.stdin.write('{"id":151,"op":"language-cancel","requestId":150}\n')
      const cancelled = yield* Effect.promise(() => Promise.all([next(), next()]))
      expect(cancelled.some((line) => line.includes('"id":150,"ok":false'))).toBe(true)
      expect(cancelled.some((line) => line.includes('"kind":"language-cancelled"'))).toBe(true)

      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow()
        expect(() => process.kill(-pid, 0)).toThrow()
      }

      expect(yield* Effect.promise(() => childProcesses(owned.child.pid))).toEqual([])
      expect(yield* Effect.promise(() => readdir(startup.temporary))).toEqual([])
      owned.child.stdin.write(
        `${JSON.stringify({ id: 152, op: 'hover', session: review.session, path: 'renamed.ts', side: 'new', line: 1, character: 21 })}\n`,
      )
      expect(yield* Effect.promise(next)).toBe(
        '{"id":152,"ok":false,"error":"Language analysis unavailable."}',
      )
    }),
  { timeout: 30000 },
)

it.live(
  'rejects outside JSDoc import types and tags while preserving revision-local JavaScript types',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture

      const bridge = yield* Effect.acquireRelease(
        Effect.sync(() => makeBridge(local.data, environment)),
        (bridge) => Effect.promise(() => bridge.dispose()),
      )

      yield* Effect.promise(() =>
        writeFile(
          join(local.directory, 'outside.ts'),
          'export interface Secret { marker: "OUTSIDE_REVISION_SENTINEL" }\n',
        ),
      )

      for (const reference of [
        join(local.directory, 'outside'),
        `../${basename(local.directory)}/outside`,
        './doc-types',
      ]) {
        for (const tag of [false, true]) {
          const source = tag
            ? `/** @import { Secret } from ${JSON.stringify(reference)} */\n/** @type {Secret} */\nlet value;\nvalue.marker;\n`
            : `/** @type {import(${JSON.stringify(reference)}).Secret} */\nlet value;\nvalue.marker;\n`

          yield* Effect.promise(async () => {
            await writeFile(
              join(local.root, 'doc-types.ts'),
              'export interface Secret { marker: "INSIDE_REVISION" }\n',
            )
            await writeFile(join(local.root, 'doc.js'), source)
            await local.git('add', '.')
            await local.git('commit', '-m', 'JSDoc reference')
          })

          const review = yield* Effect.promise(() =>
            bridge.compareLocal(local.root, 'language-base'),
          )

          const enabled = yield* Effect.promise(() =>
            bridge.handle(
              JSON.stringify({ id: 160, op: 'language-enable', session: review.session }),
            ),
          )

          const hover = yield* Effect.promise(() =>
            bridge.handle(
              JSON.stringify({
                id: 161,
                op: 'hover',
                session: review.session,
                path: 'doc.js',
                side: 'new',
                line: tag ? 3 : 2,
                character: 7,
              }),
            ),
          )

          if (reference === './doc-types') {
            expect(enabled).toMatchObject({ state: 'limited' })
            expect(hover).toMatchObject({ ok: true, kind: 'hover' })

            if (hover.ok && hover.kind === 'hover')
              expect(hover.content).toContain('INSIDE_REVISION')
          } else {
            expect(enabled).toMatchObject({ state: 'unavailable' })
            expect(hover).toMatchObject({ ok: false, error: 'Language analysis unavailable.' })
          }

          expect(JSON.stringify(hover)).not.toContain('OUTSIDE_REVISION_SENTINEL')
        }
      }
    }),
  { timeout: 30000 },
)

it.live(
  'missing installed language tooling leaves no copied revision sources behind',
  () =>
    Effect.gen(function* () {
      const local = yield* languageFixture
      const bridge = makeBridge(local.data, environment)
      const review = yield* Effect.promise(() => bridge.compareLocal(local.root, 'language-base'))

      yield* Effect.promise(() => bridge.dispose())

      const entry = join(local.directory, 'isolated-bridge.mjs')
      const temporary = join(local.directory, 'temporary')

      yield* Effect.promise(async () => {
        await copyFile(script, entry)
        await mkdir(temporary)
      })

      const owned = yield* bridgeProcess(local.data, { entry, temporary })
      owned.child.stdin.write(
        `${JSON.stringify({ id: 170, op: 'language-enable', session: review.session })}\n`,
      )
      const response = yield* Effect.promise(() => owned.iterator.next())

      expect(response.value).toContain('"state":"unavailable"')
      expect(yield* Effect.promise(() => readdir(temporary))).toEqual([])
    }),
  { timeout: 30000 },
)
