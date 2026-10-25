import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  chmodSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import {
  DashboardPreferences,
  changeDashboardPreferences,
  reconcileDashboardPreferences,
} from '@duff/core/dashboard-preferences'
import {
  CatalogError,
  RepositoryCatalog,
  WatchedRepository,
  hostedRepositoryId,
} from '@duff/core/dashboard-repositories'
import { Effect, Layer, Option, Schema, Struct } from 'effect'

import { readDashboardPreferences, writeDashboardPreferences } from './DashboardPreferenceStorage'

const failure = (reason: CatalogError['reason']) => new CatalogError({ reason })

const rowSchema = Schema.Struct({ id: Schema.NonEmptyString, value: Schema.String })

const versionSchema = Schema.Struct({ user_version: Schema.Int })

const sqliteFailure = Schema.Struct({ errcode: Schema.Int })

const codec = Schema.fromJsonString(Schema.toCodecJson(WatchedRepository))

function parseRepository(row: ReturnType<StatementSync['get']>): WatchedRepository {
  const decoded = Schema.decodeUnknownOption(rowSchema)(row)

  if (Option.isNone(decoded)) throw failure('invalid')
  const repository = Schema.decodeUnknownOption(codec)(decoded.value.value)

  if (Option.isNone(repository) || repository.value.id !== decoded.value.id)
    throw failure('invalid')

  return repository.value
}

function version(database: DatabaseSync): number {
  const result = Schema.decodeUnknownOption(versionSchema)(
    database.prepare('PRAGMA user_version').get(),
  )

  if (Option.isNone(result) || result.value.user_version < 0 || result.value.user_version > 1)
    throw failure('invalid')

  return result.value.user_version
}

function privateFile(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = lstatSync(directory)

  if (!root.isDirectory() || (process.getuid !== undefined && root.uid !== process.getuid()))
    throw failure('unavailable')
  chmodSync(directory, 0o700)
  const file = join(directory, 'repositories.sqlite')
  const handle = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)

  try {
    const stat = fstatSync(handle)

    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw failure('unavailable')
    fchmodSync(handle, 0o600)
  } finally {
    closeSync(handle)
  }

  return file
}

/** Shared, host-local catalog. Each operation owns a short SQLite transaction and connection. */
export const makeRepositoryStoreLayer = (directory: string): Layer.Layer<RepositoryCatalog> =>
  Layer.sync(RepositoryCatalog, () => {
    const root = resolve(directory)

    const transaction = <A>(
      operation: (database: DatabaseSync) => A,
      reason: CatalogError['reason'],
    ) =>
      Effect.try({
        try: () => {
          const database = new DatabaseSync(privateFile(root))

          try {
            database.exec('PRAGMA busy_timeout = 1500')
            // Refuse future formats before changing their journal settings or data.
            version(database)
            database.exec('PRAGMA journal_mode = WAL')
            database.exec('BEGIN IMMEDIATE')

            try {
              if (version(database) === 0) {
                if (
                  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
                    .length !== 0
                )
                  throw failure('invalid')
                database.exec(
                  'CREATE TABLE repositories (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT; PRAGMA user_version = 1',
                )
              }

              database.exec(
                'CREATE TABLE IF NOT EXISTS dashboard_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL) STRICT',
              )

              // Refuse malformed catalogs even for mutations, rather than repairing them silently.
              database.prepare('SELECT id, value FROM repositories').all().forEach(parseRepository)
              const result = operation(database)

              database.exec('COMMIT')

              return result
            } catch (error) {
              database.exec('ROLLBACK')
              throw error
            }
          } finally {
            database.close()
          }
        },
        catch: (error) => {
          if (error instanceof CatalogError) return error
          const sqlite = Schema.decodeUnknownOption(sqliteFailure)(error)

          if (Option.isSome(sqlite)) {
            const code = sqlite.value.errcode & 0xff

            if (code === 5 || code === 6) return failure('busy')

            if (code === 11 || code === 26 || code === 1) return failure('invalid')
          }

          return failure(reason)
        },
      })

    return RepositoryCatalog.of({
      preferences: Effect.fn('RepositoryCatalog.preferences')(() =>
        transaction(readDashboardPreferences, 'unavailable'),
      ),
      changePreferences: Effect.fn('RepositoryCatalog.changePreferences')((change) =>
        transaction(
          (database) =>
            writeDashboardPreferences(
              database,
              changeDashboardPreferences(readDashboardPreferences(database), change),
            ),
          'write-failed',
        ),
      ),
      relocate: Effect.fn('RepositoryCatalog.relocate')((id, hosting) =>
        transaction((database) => {
          const preferences = readDashboardPreferences(database)
          const select = database.prepare('SELECT id, value FROM repositories WHERE id = ?')
          const row = select.get(id)

          if (!row) throw failure('unavailable')
          const previous = parseRepository(row)
          const canonicalId = hostedRepositoryId(hosting)
          const existing = select.get(canonicalId)
          const canonical = existing ? parseRepository(existing) : undefined

          const repository = WatchedRepository.make({
            id: canonicalId,
            name: hosting.repository.displayName,
            hosting: Option.some(hosting),
            localPaths: [...new Set([...previous.localPaths, ...(canonical?.localPaths ?? [])])],
          })

          database
            .prepare(
              'INSERT INTO repositories (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
            )
            .run(repository.id, Schema.encodeSync(codec)(repository))

          if (id !== canonicalId) database.prepare('DELETE FROM repositories WHERE id = ?').run(id)
          writeDashboardPreferences(
            database,
            DashboardPreferences.make(
              Struct.assign(preferences, {
                repositoryOrder: [
                  ...new Set(
                    preferences.repositoryOrder.map((entry) =>
                      entry === id ? canonicalId : entry,
                    ),
                  ),
                ],
                repositoryId:
                  preferences.repositoryId === id ? canonicalId : preferences.repositoryId,
              }),
            ),
          )

          return repository
        }, 'write-failed'),
      ),
      list: Effect.fn('RepositoryCatalog.list')(() =>
        transaction((database) => {
          const preferences = readDashboardPreferences(database)

          const repositories = database
            .prepare('SELECT id, value FROM repositories ORDER BY id')
            .all()
            .map(parseRepository)

          return repositories.sort(
            (left, right) =>
              preferences.repositoryOrder.indexOf(left.id) -
              preferences.repositoryOrder.indexOf(right.id),
          )
        }, 'unavailable'),
      ),
      add: Effect.fn('RepositoryCatalog.add')((repositories: ReadonlyArray<WatchedRepository>) =>
        transaction((database) => {
          const preferences = readDashboardPreferences(database)
          const select = database.prepare('SELECT id, value FROM repositories WHERE id = ?')

          const upsert = database.prepare(
            'INSERT INTO repositories (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
          )

          for (const repository of repositories) {
            const row = select.get(repository.id)
            const previous = row === undefined ? undefined : parseRepository(row)

            const merged = WatchedRepository.make({
              id: repository.id,
              name: repository.name,
              hosting: Option.orElse(repository.hosting, () => previous?.hosting ?? Option.none()),
              localPaths: [...new Set([...(previous?.localPaths ?? []), ...repository.localPaths])],
            })

            upsert.run(merged.id, Schema.encodeSync(codec)(merged))
          }

          writeDashboardPreferences(
            database,
            reconcileDashboardPreferences(preferences, [
              ...preferences.repositoryOrder,
              ...repositories.map((repository) => repository.id),
            ]),
          )
        }, 'write-failed'),
      ),
      remove: Effect.fn('RepositoryCatalog.remove')((id: string) =>
        transaction((database) => {
          database.prepare('DELETE FROM repositories WHERE id = ?').run(id)
          writeDashboardPreferences(database, readDashboardPreferences(database))
        }, 'write-failed'),
      ),
    })
  })
