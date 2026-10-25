import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { ReviewStorageError, SavedReviewCatalog, SavedReviews } from '@duff/core/saved-reviews'
import { Effect, Layer, Option, Schema } from 'effect'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const failure = (reason: ReviewStorageError['reason']) => new ReviewStorageError({ reason })

const codec = Schema.fromJsonString(Schema.toCodecJson(SavedReviewCatalog))

const snapshot = Schema.Struct({ revision: Schema.Int, catalog: SavedReviewCatalog })

const rowSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  value: Schema.String,
})

const versionSchema = Schema.Struct({ user_version: Schema.Int })

const sqliteFailure = Schema.Struct({ errcode: Schema.Int })

const empty = SavedReviewCatalog.make({
  version: 1,
  active: Option.none(),
  sessions: [],
  pendingRelease: [],
})

function privateFile(directory: string, file: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = lstatSync(directory)

  if (!root.isDirectory() || (process.getuid !== undefined && root.uid !== process.getuid()))
    throw failure('unavailable')
  chmodSync(directory, 0o700)
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
}

function version(database: DatabaseSync): number {
  const decoded = Schema.decodeUnknownOption(versionSchema)(
    database.prepare('PRAGMA user_version').get(),
  )

  if (Option.isNone(decoded) || decoded.value.user_version < 0 || decoded.value.user_version > 1)
    throw failure('invalid')

  return decoded.value.user_version
}

/**
 * Shared progress for one managed checkout. Stale saves fail busy until the caller
 * explicitly loads again; no cached snapshot is silently rebased or overwritten.
 */
export const makeSharedReviewStoreLayer = (
  directory: string,
  workspace: string,
): Layer.Layer<SavedReviews> =>
  Layer.sync(SavedReviews, () => {
    const root = resolve(directory)
    const checkout = resolve(workspace)
    const file = join(root, `reviews-${digest(checkout)}.sqlite`)
    const owner = digest(JSON.stringify([file, checkout]))
    let observed: number | undefined
    let conflicted = false

    const validate = (catalog: SavedReviewCatalog): SavedReviewCatalog => {
      const keys = new Set(catalog.sessions.map((session) => session.key))
      const owned = (prefix: string) => prefix.startsWith(`refs/duff/sessions/${owner}/`)

      if (
        keys.size !== catalog.sessions.length ||
        (Option.isSome(catalog.active) && !keys.has(catalog.active.value))
      )
        throw failure('invalid')

      if (!catalog.pendingRelease.every((entry) => entry.root === checkout && owned(entry.prefix)))
        throw failure('invalid')

      for (const session of catalog.sessions) {
        const identity = digest(
          JSON.stringify([
            session.review.root,
            session.selection.provider,
            session.selection.repository.authority,
            session.selection.repository.key,
            session.selection.id,
          ]),
        )

        if (
          session.review.root !== checkout ||
          session.key !== identity ||
          !owned(session.retention) ||
          session.retention.split('/')[4] !== session.key ||
          session.review.headCommit !== session.resolved.revisions.source.commit ||
          session.resolved.pullRequest.source._tag !== 'Available' ||
          Option.getOrUndefined(session.resolved.pullRequest.source.ref.revision)?.toLowerCase() !==
            session.resolved.revisions.source.commit ||
          Option.getOrUndefined(session.resolved.pullRequest.target.ref.revision)?.toLowerCase() !==
            session.resolved.revisions.target.commit ||
          session.selection.id !== session.resolved.pullRequest.id ||
          session.selection.repository.key !== session.resolved.pullRequest.target.repository.key ||
          session.selection.repository.authority !==
            session.resolved.pullRequest.target.repository.authority
        )
          throw failure('invalid')
      }

      return catalog
    }

    const read = (database: DatabaseSync) => {
      const row = database.prepare('SELECT revision, value FROM progress WHERE singleton = 1').get()

      if (row === undefined) return snapshot.make({ revision: 0, catalog: empty })
      const decoded = Schema.decodeUnknownOption(rowSchema)(row)

      if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.revision))
        throw failure('invalid')
      const catalog = Schema.decodeUnknownOption(codec)(decoded.value.value)

      if (Option.isNone(catalog)) throw failure('invalid')

      return snapshot.make({ revision: decoded.value.revision, catalog: validate(catalog.value) })
    }

    const transaction = <A>(
      operation: (database: DatabaseSync) => A,
      reason: ReviewStorageError['reason'],
    ) =>
      Effect.try({
        try: () => {
          privateFile(root, file)
          const database = new DatabaseSync(file)

          try {
            database.exec('PRAGMA busy_timeout = 1500')
            version(database)
            database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE')

            try {
              if (version(database) === 0) {
                if (
                  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
                    .length !== 0
                )
                  throw failure('invalid')
                database.exec(
                  'CREATE TABLE progress (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision > 0), value TEXT NOT NULL) STRICT; PRAGMA user_version = 1',
                )
              }

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
          if (error instanceof ReviewStorageError) return error
          const sqlite = Schema.decodeUnknownOption(sqliteFailure)(error)

          if (Option.isSome(sqlite)) {
            const code = sqlite.value.errcode & 0xff

            if (code === 5 || code === 6) return failure('busy')

            if (code === 11 || code === 26 || code === 1) return failure('invalid')
          }

          return failure(reason)
        },
      })

    return SavedReviews.of({
      owner,
      load: Effect.fn('SharedReviews.load')(() =>
        transaction(read, 'unavailable').pipe(
          Effect.map(({ revision, catalog }) => {
            observed = revision
            conflicted = false

            return catalog
          }),
        ),
      ),
      save: Effect.fn('SharedReviews.save')((catalog: SavedReviewCatalog) =>
        transaction((database) => {
          // Always decode existing data before considering even a first save.
          const current = read(database)

          if (
            conflicted ||
            (observed === undefined ? current.revision !== 0 : observed !== current.revision)
          ) {
            conflicted = true
            throw failure('busy')
          }

          const checked = Schema.decodeUnknownOption(SavedReviewCatalog)(catalog)

          if (Option.isNone(checked)) throw failure('invalid')
          const text = Schema.encodeSync(codec)(validate(checked.value))
          const next = current.revision + 1

          if (!Number.isSafeInteger(next)) throw failure('invalid')
          database
            .prepare(
              'INSERT INTO progress (singleton, revision, value) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, value = excluded.value',
            )
            .run(next, text)

          return next
        }, 'write-failed').pipe(
          Effect.tap((revision) =>
            Effect.sync(() => {
              observed = revision
            }),
          ),
          Effect.asVoid,
        ),
      ),
    })
  })
