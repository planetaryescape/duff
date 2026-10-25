import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  RepositoryCatalog,
  WatchedRepository,
  HostedRepository,
  hostedRepositoryId,
} from '@duff/core/dashboard-repositories'
import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Scope } from 'effect'

import { dashboardDataDirectory } from './DataDirectory'
import { makeRepositoryStoreLayer } from './RepositoryStore'

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'duff-repositories-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

const openStore = Effect.fn('Test.openRepositoryStore')(function* (path: string) {
  const scope = yield* Scope.Scope
  const context = yield* Layer.buildWithScope(makeRepositoryStoreLayer(path), scope)

  return Context.get(context, RepositoryCatalog)
})

const repository = (id: string, localPaths: ReadonlyArray<string> = []) =>
  WatchedRepository.make({ id, name: id, hosting: Option.none(), localPaths })

it.effect(
  'atomically relocates watchlist membership, merges paths, and never resurrects removed entries',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const store = yield* openStore(path)

      const hosting = HostedRepository.make({
        provider: { id: 'github', displayName: 'GitHub', authenticationSource: 'github' },
        repository: { authority: 'github.com', key: 'new/repo', displayName: 'new/repo' },
        cloneUrl: 'https://github.com/new/repo.git',
      })

      const id = hostedRepositoryId(hosting)

      yield* store.add([repository('old', ['/old']), repository(id, ['/new']), repository('other')])
      const moved = yield* store.relocate('old', hosting)
      const reopened = yield* openStore(path)

      expect(moved).toEqual({
        id,
        name: 'new/repo',
        hosting: Option.some(hosting),
        localPaths: ['/old', '/new'],
      })
      expect(yield* reopened.list()).toEqual([moved, repository('other')])
      expect((yield* Effect.flip(store.relocate('old', hosting))).reason).toBe('unavailable')

      yield* store.add([repository('another', ['/keep'])])
      const database = new DatabaseSync(join(path, 'repositories.sqlite'))
      database.exec(
        "CREATE TRIGGER reject_move BEFORE DELETE ON repositories WHEN OLD.id = 'another' BEGIN SELECT RAISE(ABORT, 'rejected'); END",
      )
      database.close()

      expect((yield* Effect.flip(store.relocate('another', hosting))).reason).toBe('write-failed')
      expect(yield* store.list()).toEqual([
        moved,
        repository('another', ['/keep']),
        repository('other'),
      ])
    }),
)

it.effect(
  'shares updates, deduplicates paths and preserves unrelated writes from stale readers',
  () =>
    Effect.gen(function* () {
      const path = yield* directory
      const first = yield* openStore(path)
      const second = yield* openStore(path)

      expect(yield* first.list()).toEqual([])
      expect(yield* second.list()).toEqual([])
      yield* first.add([repository('a', ['/a'])])
      yield* second.add([repository('b', ['/b']), repository('a', ['/a', '/a2'])])
      yield* first.add([repository('a', ['/a3'])])

      const expected = [repository('a', ['/a', '/a2', '/a3']), repository('b', ['/b'])]

      expect(yield* first.list()).toEqual(expected)
      expect(yield* second.list()).toEqual(expected)
      const reopened = yield* openStore(path)

      expect(yield* reopened.list()).toEqual(expected)
      yield* second.remove('a')
      yield* second.remove('missing')
      expect(yield* first.list()).toEqual([repository('b', ['/b'])])
    }),
)

it.effect('round-trips hosted metadata and keeps it when a local discovery updates paths', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const first = yield* openStore(path)

    const hosted = WatchedRepository.make({
      id: 'hosted',
      name: 'Hosted',
      localPaths: [],
      hosting: Option.some({
        provider: { id: 'github', displayName: 'GitHub', authenticationSource: 'github' },
        repository: { authority: 'github.com', key: 'owner/repo', displayName: 'repo' },
        cloneUrl: 'https://github.com/owner/repo.git',
      }),
    })

    yield* first.add([hosted])
    const second = yield* openStore(path)

    expect(yield* second.list()).toEqual([hosted])
    yield* second.add([repository('hosted', ['/checkout'])])
    expect(yield* first.list()).toEqual([{ ...hosted, name: 'hosted', localPaths: ['/checkout'] }])
  }),
)

it.effect('removes only watchlist membership and makes storage private on POSIX', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const checkout = join(path, 'checkout.txt')
    const progress = join(path, 'progress.json')

    yield* Effect.promise(() => writeFile(checkout, 'repository content'))
    yield* Effect.promise(() => writeFile(progress, 'saved progress'))
    const store = yield* openStore(path)

    yield* store.add([repository('a', [checkout])])
    yield* store.remove('a')
    expect(yield* Effect.promise(() => readFile(checkout, 'utf8'))).toBe('repository content')
    expect(yield* Effect.promise(() => readFile(progress, 'utf8'))).toBe('saved progress')

    if (process.platform !== 'win32') {
      expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o700)
      expect(
        (yield* Effect.promise(() => stat(join(path, 'repositories.sqlite')))).mode & 0o777,
      ).toBe(0o600)
    }
  }),
)

it.effect('refuses newer database versions without replacing their contents', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const database = new DatabaseSync(join(path, 'repositories.sqlite'))

    database.exec(
      "CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('keep'); PRAGMA user_version = 2",
    )
    database.close()
    const before = yield* Effect.promise(() => readFile(join(path, 'repositories.sqlite')))
    const store = yield* openStore(path)

    expect((yield* Effect.flip(store.list())).reason).toBe('invalid')
    expect((yield* Effect.flip(store.add([repository('a')]))).reason).toBe('invalid')
    expect((yield* Effect.flip(store.remove('a'))).reason).toBe('invalid')
    expect(yield* Effect.promise(() => readFile(join(path, 'repositories.sqlite')))).toEqual(before)
  }),
)

it.effect('refuses corrupt SQLite files with privacy-safe typed failures', () =>
  Effect.gen(function* () {
    const path = yield* directory

    yield* Effect.promise(() =>
      writeFile(join(path, 'repositories.sqlite'), 'private corrupt bytes'),
    )
    const store = yield* openStore(path)
    const error = yield* Effect.flip(store.list())

    expect(error.reason).toBe('invalid')
    expect(JSON.stringify(error)).not.toContain(path)
    expect(JSON.stringify(error)).not.toContain('private corrupt bytes')
    expect(yield* Effect.promise(() => readFile(join(path, 'repositories.sqlite'), 'utf8'))).toBe(
      'private corrupt bytes',
    )
  }),
)

it.effect('refuses malformed persisted records and rolls back the entire batch', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const store = yield* openStore(path)

    yield* store.add([repository('a')])
    const database = new DatabaseSync(join(path, 'repositories.sqlite'))

    database.prepare('UPDATE repositories SET value = ? WHERE id = ?').run('{}', 'a')
    database.close()
    expect((yield* Effect.flip(store.list())).reason).toBe('invalid')
    expect((yield* Effect.flip(store.add([repository('b')]))).reason).toBe('invalid')
    expect((yield* Effect.flip(store.remove('a'))).reason).toBe('invalid')
    const inspection = new DatabaseSync(join(path, 'repositories.sqlite'))

    try {
      expect(inspection.prepare('SELECT id, value FROM repositories').all()).toEqual([
        { id: 'a', value: '{}' },
      ])
    } finally {
      inspection.close()
    }
  }),
)

it.effect('bounds contention and reports busy without losing a subsequent write', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const store = yield* openStore(path)

    yield* store.add([repository('a')])
    const other = new DatabaseSync(join(path, 'repositories.sqlite'))

    other.exec('BEGIN IMMEDIATE')

    try {
      expect((yield* Effect.flip(store.add([repository('b')]))).reason).toBe('busy')
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }

    yield* store.add([repository('b')])
    expect(yield* store.list()).toEqual([repository('a'), repository('b')])
  }),
)

it.effect('rolls back earlier batch entries when a later SQLite write fails', () =>
  Effect.gen(function* () {
    const path = yield* directory
    const store = yield* openStore(path)

    yield* store.list()
    const database = new DatabaseSync(join(path, 'repositories.sqlite'))

    database.exec(
      "CREATE TRIGGER reject_b BEFORE INSERT ON repositories WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'rejected'); END",
    )
    database.close()
    expect((yield* Effect.flip(store.add([repository('a'), repository('b')]))).reason).toBe(
      'write-failed',
    )
    expect(yield* store.list()).toEqual([])
  }),
)

it('uses host-local user data paths, never editor profiles, and ignores relative environment paths', () => {
  expect(
    dashboardDataDirectory({ platform: 'linux', homedir: '/home/user', environment: {} }),
  ).toBe('/home/user/.local/share/duff/dashboard')
  expect(
    dashboardDataDirectory({
      platform: 'linux',
      homedir: '/home/user',
      environment: { XDG_DATA_HOME: '/data' },
    }),
  ).toBe('/data/duff/dashboard')
  expect(
    dashboardDataDirectory({
      platform: 'linux',
      homedir: '/home/user',
      environment: { XDG_DATA_HOME: 'relative' },
    }),
  ).toBe('/home/user/.local/share/duff/dashboard')
  expect(
    dashboardDataDirectory({ platform: 'darwin', homedir: '/Users/user', environment: {} }),
  ).toBe('/Users/user/Library/Application Support/Duff/dashboard')
  expect(
    dashboardDataDirectory({
      platform: 'win32',
      homedir: 'C:\\Users\\user',
      environment: { LOCALAPPDATA: 'D:\\Local' },
    }),
  ).toBe('D:\\Local\\Duff\\dashboard')
  expect(
    dashboardDataDirectory({ platform: 'win32', homedir: 'C:\\Users\\user', environment: {} }),
  ).toBe('C:\\Users\\user\\AppData\\Local\\Duff\\dashboard')
})
