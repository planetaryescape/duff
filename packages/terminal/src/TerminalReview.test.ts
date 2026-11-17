import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { makeGitReviewLayer } from '@duff/core/review'
import { expect, it } from '@effect/vitest'
import { type EmbeddedTerminalRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { Effect, Layer, Queue, Schema } from 'effect'

import { EditorTerminal } from './EditorTerminal'
import { makeNeovimLayer, Neovim } from './Neovim'
import { makeTerminalReviewLayer, TerminalReview } from './TerminalReview'

const execute = promisify(execFile)

class ScreenFailure extends Schema.TaggedError<ScreenFailure>()('ScreenFailure', {
  message: Schema.String,
}) {}

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'duff-terminal-test-')))
    const root = join(directory, 'repo')
    await mkdir(root)
    const git = (...args: string[]) => execute('git', ['-C', root, ...args], { env: environment })
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Duff Test')
    await git('config', 'user.email', 'duff@example.invalid')
    await writeFile(join(root, 'code.ts'), 'export const value = 1\nkeep\n')
    await writeFile(join(root, 'removed.txt'), 'deleted content\n')
    await git('add', '.')
    await git('commit', '-m', 'base')
    await git('switch', '-c', 'feature')
    await writeFile(join(root, 'code.ts'), 'export const value = 2\nkeep\n')
    await git('rm', 'removed.txt')
    await git('add', '.')
    await git('commit', '-m', 'change')
    const config = join(directory, 'init.lua')
    await writeFile(
      config,
      `vim.opt.swapfile = false
vim.opt.shadafile = "NONE"
vim.opt.termguicolors = true
vim.keymap.set("n", "Q", "gg0", {})
vim.g.duff_fixture_config = true
`,
    )

    return { directory, root, config, stateDirectory: join(directory, 'state'), git }
  }),
  (fixture) => Effect.promise(() => rm(fixture.directory, { recursive: true, force: true })),
)

const screen = Effect.acquireRelease(
  Effect.promise(() => createTestRenderer({ width: 100, height: 28, kittyKeyboard: true })),
  (screen) => Effect.sync(() => screen.renderer.destroy()),
)

const waitForText = (terminal: EmbeddedTerminalRenderable, expected: string) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (terminal.screen().text.includes(expected)) resume(Effect.void)
    }

    terminal.onScreenChange = check
    check()

    return Effect.sync(() => {
      terminal.onScreenChange = undefined
    })
  }).pipe(
    Effect.timeout('5 seconds'),
    Effect.mapError(
      () => new ScreenFailure({ message: `Expected ${expected}\n${terminal.screen().text}` }),
    ),
  )

const waitForNormalMode = (terminal: EmbeddedTerminalRenderable) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!terminal.screen().text.includes('-- INSERT --')) resume(Effect.void)
    }

    terminal.onScreenChange = check
    check()

    return Effect.sync(() => {
      terminal.onScreenChange = undefined
    })
  }).pipe(
    Effect.timeout('5 seconds'),
    Effect.mapError(
      () => new ScreenFailure({ message: `Normal mode not reached\n${terminal.screen().text}` }),
    ),
  )

it.live(
  'reviews and edits real buffers through Neovim with user config, virtual deletions, save invalidation and resume',
  () =>
    Effect.gen(function* () {
      const files = yield* fixture
      const view = yield* screen
      const notifications = yield* Queue.unbounded<readonly [string, ReadonlyArray<unknown>]>()
      const terminal = new EditorTerminal(view.renderer, { width: '100%', height: '100%' })
      view.renderer.root.add(terminal)
      terminal.focus()

      const editorLayer = makeNeovimLayer({
        root: files.root,
        command: ['nvim', '-u', files.config, '-i', 'NONE'],
        environment,
        terminal,
        notification: (method, args) => {
          if (method === 'duff.saved') Queue.offerUnsafe(notifications, [method, args])
        },
        exited: () => {},
      })

      const reviewLayer = makeTerminalReviewLayer({ ...files, base: 'main' }).pipe(
        Layer.provide(makeGitReviewLayer(environment)),
        Layer.provideMerge(editorLayer),
      )

      yield* Effect.gen(function* () {
        const review = yield* TerminalReview
        const editor = yield* Neovim
        const initial = yield* review.load()
        expect(initial.review.files.map((file) => file.path)).toEqual(['code.ts', 'removed.txt'])
        const first = initial.review.files[0]
        expect(first).toBeDefined()

        if (first) yield* review.open(first)
        yield* waitForText(terminal, 'export const value = 2')
        yield* waitForText(terminal, '- export const value = 1')
        view.resize(80, 24)
        yield* Effect.promise(() => view.renderOnce())
        yield* waitForText(terminal, 'export const value = 2')
        expect(yield* Effect.promise(() => readFile(join(files.root, 'code.ts'), 'utf8'))).toBe(
          'export const value = 2\nkeep\n',
        )
        expect((yield* review.toggleViewed()).viewed.has('code.ts')).toBe(true)
        expect((yield* review.load()).viewed.has('code.ts')).toBe(true)

        if (first) yield* review.open(first)

        yield* Effect.promise(() => view.mockInput.typeText('GQ'))
        yield* Effect.promise(() => view.mockInput.typeText('A edited'))
        yield* waitForText(terminal, '-- INSERT --')
        view.mockInput.pressEscape()
        yield* waitForNormalMode(terminal)
        yield* Effect.promise(() => view.mockInput.typeText(':w'))
        view.mockInput.pressEnter()

        const saved = yield* Queue.take(notifications).pipe(
          Effect.timeout('5 seconds'),
          Effect.mapError(() => new ScreenFailure({ message: terminal.screen().text })),
        )

        expect(saved[0]).toBe('duff.saved')

        const [path, hash] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.String, Schema.String]),
        )(saved[1])

        expect((yield* review.saved(path, hash)).viewed.size).toBe(0)
        expect(yield* Effect.promise(() => readFile(join(files.root, 'code.ts'), 'utf8'))).toBe(
          'export const value = 2 edited\nkeep\n',
        )

        yield* Effect.promise(() => view.mockInput.typeText('u'))
        yield* Effect.promise(() => view.mockInput.typeText(':w'))
        view.mockInput.pressEnter()
        yield* Queue.take(notifications).pipe(Effect.timeout('5 seconds'))
        expect(yield* Effect.promise(() => readFile(join(files.root, 'code.ts'), 'utf8'))).toBe(
          'export const value = 2\nkeep\n',
        )
        yield* editor.hunk(1)
        const removed = initial.review.files[1]
        expect(removed).toBeDefined()

        if (removed) {
          yield* review.open(removed)
          yield* waitForText(terminal, 'deleted content')
          yield* review.open(removed)
          expect((yield* review.toggleViewed()).viewed.has('removed.txt')).toBe(true)
          yield* Effect.promise(() => view.mockInput.typeText('i'))
          yield* waitForText(terminal, "'modifiable' is off")
        }

        expect((yield* Effect.promise(() => files.git('status', '--porcelain'))).stdout).toBe('')
      }).pipe(Effect.provide(reviewLayer))
    }),
  20000,
)

it.live(
  'runs the complete CLI with focus switching, config mappings, saved progress, real editing and clean shutdown',
  () =>
    Effect.gen(function* () {
      const files = yield* fixture
      const view = yield* screen
      const terminal = new EditorTerminal(view.renderer, { width: 100, height: 28 })
      view.renderer.root.add(terminal)
      terminal.focus()

      const launch = Effect.acquireRelease(
        Effect.sync(() => {
          const child = Bun.spawn(
            [
              'bun',
              fileURLToPath(new URL('./main.tsx', import.meta.url)),
              '--repo',
              files.root,
              '--base',
              'main',
              '--editor',
              `nvim -u "${files.config}" -i NONE`,
            ],
            {
              env: {
                ...environment,
                XDG_CONFIG_HOME: join(files.directory, 'config'),
                XDG_STATE_HOME: files.stateDirectory,
                TERM: 'xterm-256color',
              },
              terminal: { cols: 100, rows: 28, data: (_terminal, data) => terminal.write(data) },
            },
          )

          terminal.onData = (data) => child.terminal?.write(data)

          return child
        }),
        (child) =>
          Effect.promise(async () => {
            child.kill('SIGKILL')
            await child.exited
            child.terminal?.close()
          }),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* launch
          yield* waitForText(terminal, 'editable workspace vs merge base')
          yield* waitForText(terminal, 'export const value = 2')
          yield* Effect.promise(() => view.renderOnce())
          yield* Effect.promise(() => view.mockMouse.click(50, 3))
          yield* waitForText(terminal, 'F8 next hunk')
          yield* Effect.promise(() => view.mockInput.typeText(':DuffViewed'))
          view.mockInput.pressEnter()
          yield* waitForText(terminal, '1/2 viewed')
          yield* Effect.promise(() => view.mockInput.typeText(':qa'))
          view.mockInput.pressEnter()
          expect(
            yield* Effect.promise(() => child.exited).pipe(
              Effect.timeout('5 seconds'),
              Effect.mapError(
                () => new ScreenFailure({ message: `First shutdown\n${terminal.screen().text}` }),
              ),
            ),
          ).toBe(0)
        }),
      )

      terminal.write('\x1bc')
      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* launch
          yield* waitForText(terminal, '1/2 viewed')
          view.mockInput.pressKey('F6')
          yield* waitForText(terminal, 'F8 next hunk')
          yield* Effect.promise(() => view.mockInput.typeText('GQA live'))
          yield* waitForText(terminal, '-- INSERT --')
          view.mockInput.pressEscape()
          yield* waitForNormalMode(terminal)
          yield* Effect.promise(() => view.mockInput.typeText(':w'))
          view.mockInput.pressEnter()
          yield* waitForText(terminal, '0/2 viewed')
          expect(yield* Effect.promise(() => readFile(join(files.root, 'code.ts'), 'utf8'))).toBe(
            'export const value = 2 live\nkeep\n',
          )
          view.resize(80, 24)
          child.terminal?.resize(80, 24)
          terminal.width = 80
          terminal.height = 24
          yield* Effect.promise(() => view.renderOnce())
          yield* waitForText(terminal, 'export const value = 2 live')
          expect(terminal.screen().columns).toBe(80)
          yield* Effect.promise(() => view.mockInput.typeText('A unsaved'))
          yield* waitForText(terminal, '-- INSERT --')
          view.mockInput.pressEscape()
          yield* waitForNormalMode(terminal)
          view.mockInput.pressKey('F6')
          yield* waitForText(terminal, 'j/k files')
          yield* Effect.promise(() => view.mockInput.typeText('q'))
          yield* waitForText(terminal, 'Save changes to')
          yield* Effect.promise(() => view.mockInput.typeText('c'))
          expect(child.exitCode).toBeNull()
          expect(yield* Effect.promise(() => readFile(join(files.root, 'code.ts'), 'utf8'))).toBe(
            'export const value = 2 live\nkeep\n',
          )
          yield* Effect.promise(() => view.mockInput.typeText(':qa!'))
          view.mockInput.pressEnter()
          expect(
            yield* Effect.promise(() => child.exited).pipe(
              Effect.timeout('5 seconds'),
              Effect.mapError(
                () => new ScreenFailure({ message: `Second shutdown\n${terminal.screen().text}` }),
              ),
            ),
          ).toBe(0)
        }),
      )
    }),
  20000,
)

it.live(
  'rejects symlink and binary editing without losing the comparison',
  () =>
    Effect.gen(function* () {
      const files = yield* fixture
      const view = yield* screen
      const terminal = new EditorTerminal(view.renderer, { width: 100, height: 28 })
      view.renderer.root.add(terminal)

      const editorLayer = makeNeovimLayer({
        root: files.root,
        command: ['nvim', '-u', files.config, '-i', 'NONE'],
        environment,
        terminal,
        notification: () => {},
        exited: () => {},
      })

      const reviewLayer = makeTerminalReviewLayer({ ...files, base: 'main' }).pipe(
        Layer.provide(makeGitReviewLayer(environment)),
        Layer.provide(editorLayer),
      )

      yield* Effect.gen(function* () {
        const review = yield* TerminalReview
        const initial = yield* review.load()
        const file = initial.review.files[0]
        expect(file).toBeDefined()

        if (!file) return
        yield* Effect.promise(() =>
          writeFile(join(files.directory, 'outside.txt'), 'private outside content'),
        )
        yield* Effect.promise(() => rm(join(files.root, 'code.ts')))
        yield* Effect.promise(() =>
          symlink(join(files.directory, 'outside.txt'), join(files.root, 'code.ts')),
        )
        expect((yield* review.open(file).pipe(Effect.flip))._tag).toBe('TerminalError')
        yield* Effect.promise(() => rm(join(files.root, 'code.ts')))
        yield* Effect.promise(() => writeFile(join(files.root, 'code.ts'), Buffer.from([0, 1, 2])))
        expect((yield* review.open(file).pipe(Effect.flip))._tag).toBe('TerminalError')
        yield* Effect.promise(() => writeFile(join(files.root, 'code.ts'), 'safe again\n'))
        expect((yield* review.open(file)).review.headCommit).toBe(initial.review.headCommit)
        expect(
          yield* Effect.promise(() => readFile(join(files.directory, 'outside.txt'), 'utf8')),
        ).toBe('private outside content')
      }).pipe(Effect.provide(reviewLayer))
    }),
  15000,
)

it.live(
  'normalizes repository roots, refuses concurrent progress writers and preserves a review on corrupt progress',
  () =>
    Effect.gen(function* () {
      const files = yield* fixture
      const nested = join(files.root, 'nested')
      yield* Effect.promise(() => mkdir(nested))
      const view = yield* screen
      const terminal = new EditorTerminal(view.renderer, { width: 100, height: 28 })
      view.renderer.root.add(terminal)

      const editorLayer = makeNeovimLayer({
        root: files.root,
        command: ['nvim', '-u', files.config, '-i', 'NONE'],
        environment,
        terminal,
        notification: () => {},
        exited: () => {},
      })

      const reviewOptions = { root: nested, base: 'main', stateDirectory: files.stateDirectory }
      const gitLayer = makeGitReviewLayer(environment)

      const reviewLayer = makeTerminalReviewLayer(reviewOptions).pipe(
        Layer.provide(gitLayer),
        Layer.provideMerge(editorLayer),
      )

      yield* Effect.gen(function* () {
        const review = yield* TerminalReview
        const editor = yield* Neovim
        const initial = yield* review.load()
        expect(initial.review.root).toBe(files.root)
        const file = initial.review.files[0]
        expect(file).toBeDefined()

        if (!file) return
        yield* review.open(file)
        yield* review.toggleViewed()

        const duplicate = makeTerminalReviewLayer(reviewOptions).pipe(
          Layer.provide(gitLayer),
          Layer.provide(Layer.succeed(Neovim, editor)),
        )

        const blocked = yield* TerminalReview.pipe(Effect.provide(duplicate), Effect.flip)
        expect(blocked._tag).toBe('TerminalError')
        expect(blocked.message).toContain('already open')
        const entries = yield* Effect.promise(() => readdir(files.stateDirectory))
        const name = entries.find((entry) => entry.endsWith('.json'))
        expect(name).toBeDefined()

        if (!name) return
        const path = join(files.stateDirectory, name)
        const original = yield* Effect.promise(() => readFile(path, 'utf8'))
        expect(original).not.toContain('export const')
        yield* Effect.promise(() => writeFile(path, '{broken'))
        expect((yield* review.load().pipe(Effect.flip))._tag).toBe('TerminalError')
        const retained = yield* review.open(file)
        expect(retained.review.headCommit).toBe(initial.review.headCommit)
        expect(retained.viewed.has(file.path)).toBe(true)
        expect(yield* Effect.promise(() => readFile(path, 'utf8'))).toBe('{broken')
      }).pipe(Effect.provide(reviewLayer))
      expect(
        (yield* Effect.promise(() => readdir(files.stateDirectory))).some((entry) =>
          entry.endsWith('.lock'),
        ),
      ).toBe(false)
    }),
  15000,
)
