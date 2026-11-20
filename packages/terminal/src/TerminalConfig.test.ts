import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { readTerminalSettings, terminalConfigPath } from './TerminalConfig'

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'duff-config-test-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

it.effect(
  'uses the same XDG configuration path on Mac and Linux, ignoring relative XDG paths',
  () =>
    Effect.gen(function* () {
      expect(
        terminalConfigPath({ home: '/home/test', configHome: undefined, path: undefined }),
      ).toBe('/home/test/.config/duff/config.json')
      expect(
        terminalConfigPath({ home: '/Users/test', configHome: '/custom/config', path: undefined }),
      ).toBe('/custom/config/duff/config.json')
      expect(
        terminalConfigPath({ home: '/Users/test', configHome: 'relative', path: undefined }),
      ).toBe('/Users/test/.config/duff/config.json')
    }),
)

it.effect(
  'defaults only when the default file is absent, and fills omitted fields in supplied JSON',
  () =>
    Effect.gen(function* () {
      const home = yield* directory
      const location = { home, configHome: undefined, path: undefined }
      expect(yield* readTerminalSettings(location)).toEqual({
        fileView: 'tree',
        sidebarWidth: 40,
        icons: 'text',
        focusMode: false,
        showRemovedLines: true,
        focusContext: 3,
        keys: {
          focus: 'f6',
          previousHunk: 'f7',
          nextHunk: 'f8',
          markNext: 'f9',
          focusMode: 'f10',
          removedLines: 'f11',
          help: 'f12',
        },
      })
      const path = terminalConfigPath(location)
      yield* Effect.promise(() => mkdir(join(home, '.config/duff'), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path, '{"fileView":"list","icons":"nerd","keys":{"nextHunk":"f1"}}'),
      )
      expect(yield* readTerminalSettings(location)).toEqual({
        fileView: 'list',
        sidebarWidth: 40,
        icons: 'nerd',
        focusMode: false,
        showRemovedLines: true,
        focusContext: 3,
        keys: {
          focus: 'f6',
          previousHunk: 'f7',
          nextHunk: 'f1',
          markNext: 'f9',
          focusMode: 'f10',
          removedLines: 'f11',
          help: 'f12',
        },
      })
    }),
)

it.effect(
  'rejects invalid values, unknown fields, duplicate global keys, invalid JSON and unreadable explicit files',
  () =>
    Effect.gen(function* () {
      const home = yield* directory
      const path = join(home, 'config.json')
      const location = { home, configHome: undefined, path }

      for (const content of [
        '{bad',
        '{"fileView":"grid"}',
        '{"fileVeiw":"list"}',
        '{"sidebarWidth":5}',
        '{"icons":"emoji"}',
        '{"keys":{"nextHunk":"f6"}}',
        '{"keys":{"focus":"q"}}',
        '{"keys":{"typo":"f9"}}',
        '{"keys":{"markNext":"f8"}}',
        '{"focusMode":"yes"}',
        '{"showRemovedLines":1}',
        '{"focusContext":-1}',
        '{"focusContext":21}',
        'null',
      ]) {
        yield* Effect.promise(() => writeFile(path, content))
        expect((yield* readTerminalSettings(location).pipe(Effect.flip))._tag).toBe(
          'TerminalConfigError',
        )
      }

      expect(
        (yield* readTerminalSettings({ ...location, path: join(home, 'missing.json') }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe('TerminalConfigError')
    }),
)

it.effect('reads the dotfiles source through a symlink without rewriting it', () =>
  Effect.gen(function* () {
    const home = yield* directory
    const source = join(home, 'dotfiles/duff/.config/duff')
    const configHome = join(home, '.config')
    yield* Effect.promise(() => mkdir(source, { recursive: true }))
    yield* Effect.promise(() => mkdir(configHome))
    yield* Effect.promise(() =>
      writeFile(join(source, 'config.json'), '{"fileView":"list","sidebarWidth":48}'),
    )
    yield* Effect.promise(() => symlink(source, join(configHome, 'duff')))
    expect(
      (yield* readTerminalSettings({ home, configHome: undefined, path: undefined })).sidebarWidth,
    ).toBe(48)
  }),
)
