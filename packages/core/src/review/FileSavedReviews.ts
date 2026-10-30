import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Effect, Layer, Option, Schema, Semaphore } from 'effect'

import { ReviewStorageError, SavedReviewCatalog, SavedReviews } from './SavedReviews'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const codec = Schema.toCodecJson(SavedReviewCatalog)

const failure = (reason: ReviewStorageError['reason']) => new ReviewStorageError({ reason })

const hasCode = (code: string) => Schema.is(Schema.Struct({ code: Schema.Literal(code) }))

/** A dead PID is recoverable; permission failures and reused/live PIDs are ambiguous. */
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return false
  } catch (error) {
    return hasCode('ESRCH')(error)
  }
}

export const makeSavedReviewStoreLayer = (directory: string | undefined) =>
  Layer.effect(
    SavedReviews,
    Effect.gen(function* () {
      const root = directory === undefined ? undefined : resolve(directory)
      const owner = digest(root ?? 'unavailable')
      const gate = yield* Semaphore.make(1)
      let blocked: ReviewStorageError['reason'] | undefined
      let leased = false
      let validated = false
      const child = `${process.pid}-${randomUUID()}`
      const lock = join(root ?? '', 'reviews.lock')
      const candidate = join(root ?? '', `.reviews-lock-${child}`)
      const file = join(root ?? '', 'reviews.json')

      const acquire = async () => {
        if (leased) {
          const children = await fs.readdir(lock)

          if (children.length !== 1 || children[0] !== child) throw failure('busy')

          return
        }

        await fs.mkdir(root ?? '', { recursive: true })

        const children = await fs.readdir(lock).catch((error) => {
          if (hasCode('ENOENT')(error)) return undefined
          throw error
        })

        if (children) {
          const observed = children[0]
          const match = observed?.match(/^([1-9][0-9]*)-[a-f0-9-]{36}$/)

          if (children.length !== 1 || !observed || !match || !dead(Number(match[1])))
            throw failure('busy')

          // The owner may have disposed normally between our first read and the death check.
          const current = await fs.readdir(lock).catch(() => {
            throw failure('busy')
          })

          if (current.length !== 1 || current[0] !== observed) throw failure('busy')
          // Keep this deterministic destination nonempty permanently. A delayed recoverer
          // of the same lease must never rename a newer owner's lock over an empty target.
          await fs.rename(lock, join(root ?? '', `.reviews-stale-${observed}`)).catch(() => {
            throw failure('busy')
          })
        }

        try {
          // Publish a complete lease atomically, never an empty live lock directory.
          await fs.mkdir(candidate, { mode: 0o700 })
          await fs.writeFile(join(candidate, child), '', { flag: 'wx', mode: 0o600 })
          await fs.rename(candidate, lock).catch(() => {
            throw failure('busy')
          })
          leased = true
        } finally {
          await fs.unlink(join(candidate, child)).catch(() => {})
          await fs.rmdir(candidate).catch(() => {})
        }
      }

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (!leased) return
          const children = await fs.readdir(lock).catch(() => [])

          if (children.length !== 1 || children[0] !== child) return

          // Retire before removing the PID marker, so normal disposal cannot leave an empty lock.
          const retired = await fs.rename(lock, candidate).then(
            () => true,
            () => false,
          )

          if (!retired) return
          await fs.unlink(join(candidate, child)).catch(() => {})
          await fs.rmdir(candidate).catch(() => {})
          leased = false
        }).pipe(gate.withPermits(1)),
      )

      const validate = (catalog: SavedReviewCatalog) => {
        const keys = new Set(catalog.sessions.map((session) => session.key))

        if (
          keys.size !== catalog.sessions.length ||
          (Option.isSome(catalog.active) && !keys.has(catalog.active.value))
        )
          return false
        const prefixValid = (prefix: string) => prefix.startsWith(`refs/duff/sessions/${owner}/`)

        return (
          catalog.pendingRelease.every((entry) => prefixValid(entry.prefix)) &&
          catalog.sessions.every((session) => {
            const parts = session.retention.split('/')

            const identity = digest(
              JSON.stringify([
                session.review.root,
                session.selection.provider,
                session.selection.repository.authority,
                session.selection.repository.key,
                session.selection.id,
              ]),
            )

            return (
              prefixValid(session.retention) &&
              parts[4] === session.key &&
              session.key === identity &&
              resolve(session.review.root) === session.review.root &&
              session.review.headCommit === session.resolved.revisions.source.commit &&
              session.resolved.pullRequest.source._tag === 'Available' &&
              Option.getOrUndefined(
                session.resolved.pullRequest.source.ref.revision,
              )?.toLowerCase() === session.resolved.revisions.source.commit &&
              Option.getOrUndefined(
                session.resolved.pullRequest.target.ref.revision,
              )?.toLowerCase() === session.resolved.revisions.target.commit &&
              session.selection.id === session.resolved.pullRequest.id &&
              session.selection.repository.key ===
                session.resolved.pullRequest.target.repository.key &&
              session.selection.repository.authority ===
                session.resolved.pullRequest.target.repository.authority
            )
          })
        )
      }

      const io = <A>(operation: () => Promise<A>, reason: ReviewStorageError['reason']) =>
        Effect.tryPromise({
          try: operation,
          catch: (error) => (error instanceof ReviewStorageError ? error : failure(reason)),
        })

      const ready = Effect.fn('SavedReviews.ready')(function* () {
        if (!root) return yield* failure('unavailable')

        if (blocked) return yield* failure(blocked)
        yield* io(acquire, 'unavailable')
      })

      const read = Effect.fn('SavedReviews.read')(function* () {
        yield* ready()

        const text = yield* io(async () => {
          try {
            return await fs.readFile(file, 'utf8')
          } catch (error) {
            if (hasCode('ENOENT')(error)) return undefined
            throw error
          }
        }, 'unavailable')

        const catalog =
          text === undefined
            ? SavedReviewCatalog.make({
                version: 1,
                active: Option.none(),
                sessions: [],
                pendingRelease: [],
              })
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(codec))(text).pipe(
                Effect.mapError(() => failure('invalid')),
              )

        if (!validate(catalog)) return yield* failure('invalid')
        validated = true

        return catalog
      })

      const load = Effect.fn('SavedReviews.load')(() =>
        read().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.reason === 'invalid') blocked = 'invalid'
            }),
          ),
          gate.withPermits(1),
          Effect.uninterruptible,
        ),
      )

      const save = Effect.fn('SavedReviews.save')((catalog: SavedReviewCatalog) =>
        Effect.gen(function* () {
          yield* ready()

          if (!validated) yield* read()

          if (!validate(catalog)) return yield* failure('invalid')

          const text = yield* Schema.encodeEffect(Schema.fromJsonString(codec))(catalog).pipe(
            Effect.mapError(() => failure('invalid')),
          )

          yield* io(async () => {
            const temporary = join(root ?? '', `.reviews-${randomUUID()}.tmp`)
            let renaming = false

            try {
              const handle = await fs.open(temporary, 'wx', 0o600)

              try {
                await handle.writeFile(text)
                await handle.sync()
              } finally {
                await handle.close()
              }

              await acquire()
              renaming = true
              await fs.rename(temporary, file)
              const parent = await fs.open(root ?? '', 'r')

              try {
                await parent.sync().catch((error) => {
                  if (!['EINVAL', 'ENOTSUP', 'EBADF'].some((code) => hasCode(code)(error)))
                    throw error
                })
              } finally {
                await parent.close()
              }
            } catch (error) {
              if (renaming) blocked = 'write-failed'
              throw error
            } finally {
              await fs.unlink(temporary).catch(() => {})
            }
          }, 'write-failed')
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.reason === 'invalid') blocked = 'invalid'
            }),
          ),
          gate.withPermits(1),
          Effect.uninterruptible,
        ),
      )

      return SavedReviews.of({ owner, load, save })
    }),
  )
