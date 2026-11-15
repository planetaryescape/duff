import { createHash } from 'node:crypto'
import {
  mkdir,
  open as openFile,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { BranchReview, Commit, type FileChange, GitPath, type Review } from '@duff/core/review'
import { fileSnapshots } from '@duff/core/review-progress'
import { Context, Effect, Layer, Schema } from 'effect'

import { type EditorError, Neovim } from './Neovim'
import { workspaceContents } from './WorkspaceFile'

const Viewed = Schema.Struct({
  path: GitPath,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

const Progress = Schema.Struct({
  baseCommit: Commit,
  headCommit: Commit,
  viewed: Schema.Array(Viewed),
})

export class TerminalError extends Schema.TaggedError<TerminalError>()('TerminalError', {
  message: Schema.String,
}) {}

export interface TerminalState {
  readonly review: Review
  readonly viewed: ReadonlySet<string>
  readonly selected: string | undefined
}

export class TerminalReview extends Context.Service<
  TerminalReview,
  {
    readonly load: () => Effect.Effect<TerminalState, TerminalError | EditorError>
    readonly open: (file: FileChange) => Effect.Effect<TerminalState, TerminalError | EditorError>
    readonly toggleViewed: () => Effect.Effect<TerminalState, TerminalError | EditorError>
    readonly saved: (path: string, hash: string) => Effect.Effect<TerminalState, TerminalError>
  }
>()('duff/terminal/TerminalReview') {}

export interface ReviewOptions {
  readonly root: string
  readonly base: string
  readonly stateDirectory: string
}

const failure = () =>
  new TerminalError({
    message:
      'Could not read or save terminal review progress. Check the state directory and retry.',
  })

export const makeTerminalReviewLayer = (options: ReviewOptions) =>
  Layer.effect(
    TerminalReview,
    Effect.gen(function* () {
      const git = yield* BranchReview
      const editor = yield* Neovim

      const repository = yield* git
        .branches(options.root)
        .pipe(Effect.mapError((error) => new TerminalError({ message: error.message })))

      const root = yield* Effect.tryPromise({
        try: () => realpath(repository.root),
        catch: failure,
      })

      const identity = createHash('sha256')
        .update(root)
        .update('\0')
        .update(options.base)
        .digest('hex')

      const path = join(options.stateDirectory, `${identity}.json`)
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            const lock = await openFile(`${path}.lock`, 'wx', 0o600)
            await lock.close()
          },
          catch: () =>
            new TerminalError({
              message:
                'This terminal comparison is already open, or its progress lock remains after a crash. Close the other reviewer before removing the .lock file in the terminal state directory.',
            }),
        }),
        () => Effect.promise(() => rm(`${path}.lock`, { force: true })),
      )
      const viewed = new Map<string, string>()
      let review: Review | undefined
      let selected: string | undefined

      const current = () => {
        if (!review) return Effect.fail(new TerminalError({ message: 'Open a comparison first.' }))

        return Effect.succeed(review)
      }

      const state = Effect.fn('TerminalReview.state')(function* () {
        return { review: yield* current(), viewed: new Set(viewed.keys()), selected }
      })

      const persist = Effect.fn('TerminalReview.persist')(function* () {
        const review = yield* current()

        const value = Progress.make({
          baseCommit: review.baseCommit,
          headCommit: review.headCommit,
          viewed: Array.from(viewed, ([path, hash]) => ({ path, hash })),
        })

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            const temporary = `${path}.${process.pid}.tmp`
            await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
            await rename(temporary, path)
          },
          catch: failure,
        })
      })

      const open = Effect.fn('TerminalReview.open')(function* (input: FileChange) {
        const review = yield* current()
        const file = review.files.find((candidate) => candidate.path === input.path)

        if (!file)
          return yield* new TerminalError({ message: 'This file is not in the active comparison.' })
        const [baseSnapshot] = fileSnapshots(review, file)

        const base = yield* git
          .read(baseSnapshot)
          .pipe(Effect.mapError((error) => new TerminalError({ message: error.message })))

        const target = join(root, file.path)

        if (file.status !== 'D')
          yield* workspaceContents(root, file.path).pipe(
            Effect.mapError((error) => new TerminalError({ message: error.message })),
          )

        if (base.includes('\0') || Buffer.byteLength(base) > 2 * 1024 * 1024)
          return yield* new TerminalError({
            message: 'Binary or oversized base files are not supported.',
          })
        const hash = yield* editor.open(target, base, file.status === 'D')
        selected = file.path
        const previous = viewed.get(file.path)

        if (previous && previous !== hash) {
          viewed.delete(file.path)
          yield* persist()
        }

        return yield* state()
      })

      return TerminalReview.of({
        load: Effect.fn('TerminalReview.load')(function* () {
          const branches = yield* git
            .branches(root)
            .pipe(Effect.mapError((error) => new TerminalError({ message: error.message })))

          const next = yield* git
            .compare(branches.root, options.base)
            .pipe(Effect.mapError((error) => new TerminalError({ message: error.message })))

          const nextViewed = new Map<string, string>()

          const contents = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await readFile(path, 'utf8')
              } catch (error) {
                const missing = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)

                if (missing) return undefined
                throw error
              }
            },
            catch: failure,
          })

          if (contents !== undefined) {
            const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Progress))(
              contents,
            ).pipe(Effect.mapError(failure))

            if (saved.baseCommit === next.baseCommit && saved.headCommit === next.headCommit) {
              for (const entry of saved.viewed) {
                const file = next.files.find((file) => file.path === entry.path)

                if (!file) continue
                const snapshot = file.status === 'D' ? fileSnapshots(next, file)[0] : undefined

                const result = yield* (
                  snapshot
                    ? git.read(snapshot).pipe(
                        Effect.map((content) => Buffer.from(content)),
                        Effect.mapError(failure),
                      )
                    : workspaceContents(root, file.path).pipe(Effect.mapError(failure))
                ).pipe(Effect.result)

                if (result._tag === 'Failure') continue
                const content = result.success

                if (createHash('sha256').update(content).digest('hex') === entry.hash)
                  nextViewed.set(entry.path, entry.hash)
              }
            }
          }

          yield* editor.reset()
          review = next
          viewed.clear()

          for (const [path, hash] of nextViewed) viewed.set(path, hash)

          return yield* state()
        }),
        open,
        toggleViewed: Effect.fn('TerminalReview.toggleViewed')(function* () {
          const active = yield* editor.fingerprint()
          const review = yield* current()

          const file = review.files.find(
            (file) =>
              active.path === join(root, file.path) ||
              active.path === `duff://deleted/${join(root, file.path)}`,
          )

          if (!file)
            return yield* new TerminalError({
              message: 'The active buffer is not part of this review.',
            })
          const before = viewed.get(file.path)

          if (before === active.hash) viewed.delete(file.path)
          else viewed.set(file.path, active.hash)
          yield* persist().pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (before) viewed.set(file.path, before)
                else viewed.delete(file.path)
              }),
            ),
          )

          return yield* state()
        }),
        saved: Effect.fn('TerminalReview.saved')(function* (path, hash) {
          const relativePath = relative(root, path)
          const before = viewed.get(relativePath)

          if (before && before !== hash) {
            viewed.delete(relativePath)
            yield* persist()
          }

          return yield* state()
        }),
      })
    }),
  )
