import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it } from '@effect/vitest'
import { createTestRenderer } from '@opentui/core/testing'
import { Effect, Schedule, Schema } from 'effect'

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
      'vim.opt.swapfile = false\nvim.opt.shadafile = "NONE"\nvim.opt.termguicolors = true\nvim.opt.background = "light"\n',
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

      let terminalOutput = ''

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
              terminal: {
                cols: 120,
                rows: 30,
                data: (_terminal, bytes) => {
                  terminalOutput += Buffer.from(bytes).toString()
                  terminal.write(bytes)
                },
              },
            },
          )

          terminal.onData = (bytes) => child.terminal?.write(bytes)
          terminal.onTerminalResize = (cols, rows) => child.terminal?.resize(cols, rows)

          return child
        }),
        (child) =>
          Effect.promise(async () => {
            child.kill('SIGKILL')
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

      const chrome = (red: number, green: number, blue: number) =>
        Effect.promise(async () => {
          await view.renderOnce()

          const title = view
            .captureSpans()
            .lines[0]?.spans.find((span) => span.text.includes('duff'))

          const background = title?.bg

          return (
            background !== undefined &&
            Math.round(background.r * 255) === red &&
            Math.round(background.g * 255) === green &&
            Math.round(background.b * 255) === blue
          )
        }).pipe(
          Effect.filterOrFail(
            (matches) => matches,
            () =>
              new NavigationFailure({
                message: `Expected Duff chrome RGB ${red}, ${green}, ${blue}`,
              }),
          ),
          Effect.retry({ times: 25, schedule: Schedule.spaced('40 millis') }),
        )

      const command = Effect.fn('NavigationTest.command')(function* (value: string) {
        yield* Effect.promise(() => view.mockInput.typeText(value))
        view.mockInput.pressEnter()
      })

      let sequence = 0

      const editorCommand = Effect.fn('NavigationTest.editorCommand')(function* (value: string) {
        sequence += 1
        yield* command(
          `:execute '${value.replaceAll("'", "''")}' | redraw! | echo 'ready' . '${sequence}'`,
        )
        yield* text(`ready${sequence}`)
      })

      yield* text('Changed files · list')
      yield* text('v viewed')
      yield* text('line60 = 6000')
      yield* chrome(239, 241, 245)
      expect(sidebar()).toContain('useDeliveryPinLocation.ts')
      expect(sidebar()).toContain('normalizeRoute.ts')
      expect(terminal.screen().text).not.toContain('line145 = 14500')
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'list-first-hunk-120x30', view)
      view.mockInput.pressKey('F4')
      yield* text('F3 next hunk')
      yield* editorCommand(
        "lua io.stderr:write(string.char(27) .. '[8;20;184t'); io.stderr:flush()",
      )
      expect(terminalOutput).not.toContain('warning(stream):')
      yield* editorCommand('set background=dark')
      yield* chrome(20, 24, 30)
      yield* editorCommand('colorscheme morning')
      yield* chrome(239, 241, 245)
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
      yield* text('F9 read+next')
      view.mockInput.pressKey('F12')
      yield* text('Review controls')
      yield* text('Mark viewed and open next unread')
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'review-help-120x30', view)
      view.mockInput.pressEscape()
      yield* wait(
        'Help closes without consuming editor input',
        () => !terminal.screen().text.includes('Review controls'),
      )

      yield* editorCommand('setlocal foldmethod=manual foldlevel=0 foldtext=foldtext()')
      yield* editorCommand('12,15fold')
      yield* editorCommand('10,20fold')
      yield* editorCommand('normal! 60G')
      yield* text('line60 = 6000')
      view.mockInput.pressKey('F10')
      yield* wait(
        'Focus mode shows both hunks and folds distant unchanged lines',
        () =>
          terminal.screen().text.includes('unchanged lines') &&
          terminal.screen().text.includes('line145 = 14500') &&
          !terminal.screen().text.includes('line70 = 70'),
      )
      yield* text('focus on')
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'focus-mode-120x30', view)
      view.mockInput.pressKey('F11')
      yield* wait(
        'Removed lines can be hidden while additions remain visible',
        () =>
          terminal.screen().text.includes('removed off') &&
          !terminal.screen().text.includes('- export const line60 = 60') &&
          terminal.screen().text.includes('line60 = 6000'),
      )
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'removed-hidden-120x30', view)
      view.mockInput.pressKey('F11')
      yield* text('- export const line60 = 60')
      yield* editorCommand("call setline(100, 'export const line100 = 12345')")
      yield* text('line100 = 12345')
      yield* editorCommand("call setline(100, 'export const line100 = 100')")
      yield* editorCommand('write')
      yield* wait(
        'Focus folds recompute after real buffer edits and saves',
        () =>
          !terminal.screen().text.includes('line100 = 12345') &&
          terminal.screen().text.includes('line145 = 14500'),
      )
      view.mockInput.pressKey('F10')
      yield* text('focus off')
      yield* command(
        ':redraw! | lua print(vim.inspect({vim.wo.foldmethod, vim.wo.foldlevel, vim.fn.foldclosed(10), vim.fn.foldclosedend(10)}))',
      )
      yield* text('{ "manual", 0, 10, 20 }')
      yield* editorCommand('normal! 10Gzo')
      yield* command(
        ':redraw! | lua print(vim.inspect({vim.fn.foldclosed(12), vim.fn.foldclosedend(12)}))',
      )
      yield* text('{ 12, 15 }')
      yield* editorCommand('normal! 60G')
      view.mockInput.pressKey('F10')
      yield* text('focus on')
      view.mockInput.pressKey('F9')
      yield* text('1/3 viewed')
      yield* text('line100 = 10000')
      view.mockInput.pressKey('F9')
      yield* text('2/3 viewed')
      yield* text('export const removed = true')
      view.mockInput.pressKey('F9')
      yield* text('3/3 viewed')
      yield* text('All files viewed')
      view.mockInput.pressKey('F9')
      yield* text('All files viewed')
      expect(sidebar()).toContain('3/3 viewed')
      yield* captureEvidence(
        process.env.DUFF_TERMINAL_EVIDENCE_DIR,
        'all-files-viewed-120x30',
        view,
      )
      yield* editorCommand('enew')
      view.mockInput.pressKey('F9')
      yield* text('The active buffer is not part of this review.')
      expect(sidebar()).toContain('3/3 viewed')
      view.resize(80, 24)
      terminal.width = 80
      terminal.height = 24
      yield* Effect.promise(() => view.renderOnce())
      yield* wait(
        'The native terminal resizes to 80 columns',
        () => terminal.screen().columns === 80,
      )
      yield* wait(
        'The CLI redraws its header and both footer rows at 80 by 24',
        () =>
          terminal.screen().lines[0]?.includes('duff') === true &&
          terminal.screen().lines.at(-1)?.includes('F9 read+next') === true,
      )
      view.mockInput.pressKey('F12')
      yield* text('Review controls')
      yield* text('Escape closes help')
      yield* captureEvidence(process.env.DUFF_TERMINAL_EVIDENCE_DIR, 'review-help-80x24', view)
      view.mockInput.pressEscape()
      yield* wait(
        'Compact help closes and returns focus to Neovim',
        () => !terminal.screen().text.includes('Review controls'),
      )
      expect(yield* Effect.promise(() => readFile(files.config, 'utf8'))).toBe(files.settings)
      yield* command(':qa')
      expect(yield* Effect.promise(() => child.exited).pipe(Effect.timeout('5 seconds'))).toBe(0)
      expect((yield* Effect.promise(() => files.git('status', '--porcelain'))).stdout).toBe('')
    }),
  30000,
)
