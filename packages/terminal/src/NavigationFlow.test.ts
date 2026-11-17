import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { createTestRenderer } from '@opentui/core/testing'
import { Effect, Schema } from 'effect'

import { captureEvidence } from '../test/Capture'
import { EditorTerminal } from './EditorTerminal'

const execute = promisify(execFile)

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

const firstPath = 'src/components/DeliveryPinCard/useDeliveryPinLocation.ts'

const secondPath = 'src/components/OrderTracking/normalizeRoute.ts'

class NavigationFailure extends Schema.TaggedError<NavigationFailure>()('NavigationFailure', {
  message: Schema.String,
}) {}

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'duff-navigation-')))
    const root = join(directory, 'repo')
    await mkdir(join(root, 'src/components/DeliveryPinCard'), { recursive: true })
    await mkdir(join(root, 'src/components/OrderTracking'), { recursive: true })
    await mkdir(join(root, 'src/legacy'), { recursive: true })
    const git = (...args: string[]) => execute('git', ['-C', root, ...args], { env: environment })
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Navigation Fixture')
    await git('config', 'user.email', 'fixture@example.invalid')

    const lines = Array.from(
      { length: 180 },
      (_, index) => `export const line${index + 1} = ${index + 1}`,
    )

    await writeFile(join(root, firstPath), `${lines.join('\n')}\n`)
    await writeFile(join(root, secondPath), `${lines.join('\n')}\n`)
    await writeFile(join(root, 'src/legacy/removed.ts'), 'export const removed = true\n')
    await git('add', '.')
    await git('commit', '-m', 'base')
    await git('switch', '-c', 'feature/navigation')
    const first = [...lines]
    first[59] = 'export const line60 = 6000'
    first[144] = 'export const line145 = 14500'
    const second = [...lines]
    second[99] = 'export const line100 = 10000'
    await writeFile(join(root, firstPath), `${first.join('\n')}\n`)
    await writeFile(join(root, secondPath), `${second.join('\n')}\n`)
    await git('rm', 'src/legacy/removed.ts')
    await git('add', '.')
    await git('commit', '-m', 'distant hunks')
    const configHome = join(directory, '.config')
    const source = join(directory, 'dotfiles/duff/.config/duff')
    await mkdir(source, { recursive: true })
    await mkdir(configHome)
    await symlink(source, join(configHome, 'duff'))

    const settings =
      '{"fileView":"list","sidebarWidth":44,"keys":{"focus":"f4","previousHunk":"f2","nextHunk":"f3"}}'

    const config = join(source, 'config.json')
    await writeFile(config, settings)
    const editor = join(directory, 'init.lua')
    await writeFile(
      editor,
      'vim.opt.swapfile = false\nvim.opt.shadafile = "NONE"\nvim.opt.termguicolors = true\n',
    )

    return { directory, root, configHome, config, settings, editor, git }
  }),
  (files) => Effect.promise(() => rm(files.directory, { recursive: true, force: true })),
)

it.live(
  'uses dotfiles config, readable filenames, keyboard list/tree navigation and first-hunk/cross-file jumps in the real CLI',
  () =>
    Effect.gen(function* () {
      const files = yield* fixture

      const view = yield* Effect.acquireRelease(
        Effect.promise(() => createTestRenderer({ width: 120, height: 30, kittyKeyboard: true })),
        (view) => Effect.sync(() => view.renderer.destroy()),
      )

      const terminal = new EditorTerminal(view.renderer, { width: 120, height: 30 })
      view.renderer.root.add(terminal)
      terminal.focus()

      const child = yield* Effect.acquireRelease(
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
              `nvim -u "${files.editor}" -i NONE`,
            ],
            {
              env: {
                ...environment,
                XDG_CONFIG_HOME: files.configHome,
                XDG_STATE_HOME: join(files.directory, 'state'),
                TERM: 'xterm-256color',
              },
              terminal: { cols: 120, rows: 30, data: (_terminal, bytes) => terminal.write(bytes) },
            },
          )

          terminal.onData = (bytes) => child.terminal?.write(bytes)

          return child
        }),
        (child) =>
          Effect.promise(async () => {
            child.kill('SIGTERM')
            await child.exited
            child.terminal?.close()
          }),
      )

      const sidebar = () =>
        terminal
          .screen()
          .lines.map((line) => line.slice(0, 44))
          .join('\n')

      const wait = (description: string, predicate: () => boolean) =>
        Effect.callback<void>((resume) => {
          const check = () => {
            if (predicate()) resume(Effect.void)
          }

          terminal.onScreenChange = check
          check()

          return Effect.sync(() => {
            terminal.onScreenChange = undefined
          })
        }).pipe(
          Effect.timeout('8 seconds'),
          Effect.mapError(
            () => new NavigationFailure({ message: `${description}\n${terminal.screen().text}` }),
          ),
        )

      const text = (value: string) =>
        wait(`Expected ${value}`, () => terminal.screen().text.includes(value))

      const command = Effect.fn('NavigationTest.command')(function* (value: string) {
        yield* Effect.promise(() => view.mockInput.typeText(value))
        view.mockInput.pressEnter()
      })

      yield* text('Changed files · list')
      yield* text('line60 = 6000')
      expect(sidebar()).toContain('useDeliveryPinLocation.ts')
      expect(sidebar()).toContain('normalizeRoute.ts')
      expect(terminal.screen().text).not.toContain('line145 = 14500')
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'list-first-hunk-120x30', view)
      view.mockInput.pressKey('F4')
      yield* text('F3 next hunk')
      view.mockInput.pressKey('F3')
      yield* text('line145 = 14500')
      view.mockInput.pressKey('F3')
      yield* text('line100 = 10000')
      yield* captureEvidence(
        process.env.DUFF_TERMINAL_EVIDENCE_DIR,
        'cross-file-next-hunk-120x30',
        view,
      )
      view.mockInput.pressKey('F2')
      yield* text('line145 = 14500')
      view.mockInput.pressKey('F2')
      yield* text('line60 = 6000')

      view.mockInput.pressKey('F4')
      yield* text('j/k files')
      yield* Effect.promise(() => view.mockInput.typeText('j'))
      view.mockInput.pressEnter()
      yield* text('line100 = 10000')
      yield* text('F3 next hunk')
      yield* command(':normal! G')
      yield* text('line180 = 180')
      view.mockInput.pressKey('F4')
      yield* text('j/k files')
      view.mockInput.pressEnter()
      yield* wait(
        'Reopening returns to the first diff, not the previous buffer cursor',
        () =>
          terminal.screen().text.includes('line100 = 10000') &&
          !terminal.screen().text.includes('line180 = 180'),
      )
      yield* text('F3 next hunk')

      yield* command(`:edit ${firstPath}`)
      yield* text('line60 = 6000')
      yield* command(':normal! G')
      yield* text('line180 = 180')
      view.mockInput.pressKey('F4')
      yield* text('j/k files')
      view.mockInput.pressEnter()
      yield* text('F3 next hunk')
      yield* wait(
        'Neovim buffer changes synchronize the selected file before reopening its first diff',
        () =>
          terminal.screen().text.includes('line60 = 6000') &&
          !terminal.screen().text.includes('line180 = 180'),
      )
      yield* command(`:edit ${secondPath}`)
      yield* text('line100 = 10000')
      view.mockInput.pressKey('F4')
      yield* text('j/k files')
      yield* Effect.promise(() => view.mockInput.typeText('t'))
      yield* text('Changed files · tree')
      yield* wait(
        'Tree displays the selected leaf under its directory',
        () => sidebar().includes('normalizeRoute.ts') && sidebar().includes('OrderTracking/'),
      )
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'tree-open-120x30', view)
      yield* Effect.promise(() => view.mockInput.typeText('hh'))
      yield* wait(
        'Left folds a real directory without hiding the editor buffer',
        () => sidebar().includes('▸ OrderTracking/') && !sidebar().includes('normalizeRoute.ts'),
      )
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'tree-folded-120x30', view)
      yield* Effect.promise(() => view.mockInput.typeText('t'))
      yield* text('Changed files · list')
      yield* wait('Switching to list retains the file identity', () =>
        sidebar().includes('normalizeRoute.ts'),
      )
      yield* Effect.promise(() => view.mockInput.typeText('t'))
      yield* text('Changed files · tree')
      yield* wait(
        'Switching back reveals the selected file',
        () => sidebar().includes('normalizeRoute.ts') && sidebar().includes('▾ OrderTracking/'),
      )
      yield* Effect.promise(() => view.mockInput.typeText('g'))
      view.mockInput.pressEnter()
      yield* wait(
        'Enter folds the selected root directory',
        () => sidebar().includes('▸ src/') && !sidebar().includes('useDeliveryPinLocation.ts'),
      )
      yield* Effect.promise(() => view.mockInput.typeText('l'))
      yield* wait('Right expands the root directory', () => sidebar().includes('▾ src/'))
      yield* Effect.promise(() => view.mockInput.typeText('jll'))
      view.mockInput.pressEnter()
      yield* text('F3 next hunk')
      yield* text('line60 = 6000')
      expect(yield* Effect.promise(() => readFile(files.config, 'utf8'))).toBe(files.settings)
      yield* command(':qa')
      expect(yield* Effect.promise(() => child.exited).pipe(Effect.timeout('5 seconds'))).toBe(0)
      expect((yield* Effect.promise(() => files.git('status', '--porcelain'))).stdout).toBe('')
    }),
  30000,
)
