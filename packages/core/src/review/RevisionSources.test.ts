import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { makeRevisionSourcesLayer, RevisionSources } from './RevisionSources'

const exec = promisify(execFile)

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), 'duff-revision-sources-'))
    const git = (...args: string[]) => exec('git', args, { cwd: root, env: environment })

    await git('init', '--initial-branch=main')
    await git('config', 'user.email', 'test@example.invalid')
    await git('config', 'user.name', 'Fixture')
    await git('config', 'core.precomposeUnicode', 'false')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'unchanged.ts'), 'export interface Local { value: number }\n')
    await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1\n')
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}')
    await writeFile(join(root, 'large-image.png'), Buffer.alloc(17 * 1024 * 1024))
    await mkdir(join(root, '.yarn', 'releases'), { recursive: true })
    await writeFile(join(root, '.yarn', 'releases', 'vendored.cjs'), 'x'.repeat(2 * 1024 * 1024))
    await git('add', '.')
    await git('commit', '-m', 'base')
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim()

    return { root, git, commit }
  }),
  ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

it.live(
  'exports unchanged imports and configs from the exact immutable tree, ignoring Git environment redirection',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture

      yield* Effect.promise(() =>
        writeFile(join(local.root, 'src', 'unchanged.ts'), 'dirty owner source'),
      )

      const files = yield* Effect.gen(function* () {
        return yield* (yield* RevisionSources).read(local.root, local.commit)
      }).pipe(
        Effect.provide(
          makeRevisionSourcesLayer({
            ...environment,
            GIT_WORK_TREE: '/missing',
            GIT_DIR: '/missing',
          }),
        ),
      )

      expect(files).toEqual([
        { path: 'src/main.ts', text: 'export const value = 1\n' },
        { path: 'src/unchanged.ts', text: 'export interface Local { value: number }\n' },
        { path: 'tsconfig.json', text: '{"compilerOptions":{"strict":true}}' },
      ])
    }),
)

it.live(
  'rejects symlinks, oversized blobs, platform-ambiguous paths and invalid revisions without partial exports',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture
      const sources = yield* RevisionSources

      for (const kind of [
        'symlink',
        'large',
        'binary',
        'invalid-utf8',
        'path',
        'case',
        'unicode',
        'case-directory',
        'unicode-directory',
      ]) {
        yield* Effect.promise(async () => {
          await local.git('reset', '--hard', local.commit)

          if (kind === 'symlink') await symlink('/etc/passwd', join(local.root, 'escape'))

          if (kind === 'large') await writeFile(join(local.root, 'large.ts'), 'x'.repeat(1048577))

          if (kind === 'binary') await writeFile(join(local.root, 'binary.ts'), 'source\0text')

          if (kind === 'invalid-utf8')
            await writeFile(join(local.root, 'invalid.ts'), Buffer.from([0xc3, 0x28]))

          if (kind === 'path')
            await writeFile(join(local.root, 'file:uri.ts'), 'export const x = 1')

          await local.git('add', '.')

          if (kind === 'case' || kind === 'unicode') {
            const object = (await local.git('hash-object', 'src/main.ts')).stdout.trim()
            const paths = kind === 'case' ? ['Foo.ts', 'foo.ts'] : ['é.ts', 'e\u0301.ts']

            await local.git('update-index', '--add', '--cacheinfo', `100644,${object},${paths[0]}`)
            await local.git('update-index', '--add', '--cacheinfo', `100644,${object},${paths[1]}`)
          }

          if (kind === 'case-directory' || kind === 'unicode-directory') {
            const object = (await local.git('hash-object', 'src/main.ts')).stdout.trim()

            const [first, second] =
              kind === 'case-directory'
                ? (['A/x.ts', 'a/y.ts'] as const)
                : (['é/x.ts', 'e\u0301/y.ts'] as const)

            await local.git('update-index', '--add', '--cacheinfo', `100644,${object},${first}`)
            await local.git('update-index', '--add', '--cacheinfo', `100644,${object},${second}`)
          }

          await local.git('commit', '-m', kind)
        })
        const commit = (yield* Effect.promise(() => local.git('rev-parse', 'HEAD'))).stdout.trim()
        const result = yield* Effect.result(sources.read(local.root, commit))

        expect(result._tag).toBe('Failure')
      }

      const result = yield* Effect.result(sources.read(local.root, 'HEAD:../outside'))

      expect(result._tag).toBe('Failure')
    }).pipe(Effect.provide(makeRevisionSourcesLayer(environment))),
)

it.live(
  'exports a large pinned tree with exact Unicode, empty and shared blobs without interpreting source as framing',
  () =>
    Effect.gen(function* () {
      const local = yield* fixture

      const expected = Array.from({ length: 700 }, (_, index) => [
        { path: `src/part-${String(index).padStart(4, '0')}-0.ts`, text: '' },
        {
          path: `src/part-${String(index).padStart(4, '0')}-1.ts`,
          text: 'export const value = "é😀"\n',
        },
        {
          path: `src/part-${String(index).padStart(4, '0')}-2.ts`,
          text: '0123456789 blob 123\nno final newline',
        },
      ]).flat()

      yield* Effect.forEach(
        expected,
        (file) => Effect.promise(() => writeFile(join(local.root, file.path), file.text)),
        { concurrency: 32 },
      )

      yield* Effect.promise(async () => {
        await local.git('add', '.')
        await local.git('commit', '-m', 'large source tree')
      })
      const commit = (yield* Effect.promise(() => local.git('rev-parse', 'HEAD'))).stdout.trim()
      const files = yield* (yield* RevisionSources).read(local.root, commit)

      expect(files).toHaveLength(2103)
      expect(files.filter((file) => file.path.startsWith('src/part-'))).toEqual(expected)
    }).pipe(Effect.provide(makeRevisionSourcesLayer(environment))),
  { timeout: 45000 },
)
