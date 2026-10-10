import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { Context, Effect, Layer, Schema } from 'effect'

export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/))

export const GitPath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\u0000).+$/s),
)

export const FileChange = Schema.Struct({
  status: Schema.Literals(['A', 'M', 'D', 'R', 'C', 'T']),
  path: GitPath,
  previousPath: Schema.optional(GitPath),
})

export interface FileChange extends Schema.Schema.Type<typeof FileChange> {}

export const Review = Schema.Struct({
  root: Schema.String,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  baseCommit: Commit,
  headCommit: Commit,
  files: Schema.Array(FileChange),
})

export interface Review extends Schema.Schema.Type<typeof Review> {}

export const Snapshot = Schema.Struct({
  root: Schema.String,
  commit: Commit,
  path: Schema.optional(GitPath),
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export class ReviewError extends Schema.TaggedError<ReviewError>()('ReviewError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class BranchReview extends Context.Service<
  BranchReview,
  {
    readonly branches: (directory: string) => Effect.Effect<
      {
        readonly root: string
        readonly current: string
        readonly branches: ReadonlyArray<string>
      },
      ReviewError
    >
    readonly compare: (root: string, branch: string) => Effect.Effect<Review, ReviewError>
    readonly read: (snapshot: Snapshot) => Effect.Effect<string, ReviewError>
  }
>()('duff/BranchReview') {}

const execute = promisify(execFile)

const git = Effect.fn('GitReview.git')(function* (root: string, args: ReadonlyArray<string>) {
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      execute('git', ['-C', root, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        signal,
      }),
    catch: () =>
      new ReviewError({
        operation: args[0] ?? 'git',
        message:
          'Git operation failed. Check that Git is installed, the repository has commits, and the selected branch is available locally. Raw diagnostics are hidden because they may contain private data.',
      }),
  })

  return result.stdout
})

const decodeFiles = Effect.fn('GitReview.decodeFiles')(function* (output: string) {
  const tokens = output.split('\0')
  const files: FileChange[] = []

  for (let index = 0; index < tokens.length - 1;) {
    const rawStatus = tokens[index++]
    const renamed = rawStatus?.startsWith('R') || rawStatus?.startsWith('C')
    const firstPath = tokens[index++]
    const path = renamed ? tokens[index++] : firstPath

    const status = rawStatus?.charAt(0)
    const input = renamed ? { status, path, previousPath: firstPath } : { status, path }

    const file = yield* Schema.decodeUnknownEffect(FileChange)(input).pipe(
      Effect.mapError(
        () =>
          new ReviewError({
            operation: 'decode changed files',
            message: 'Git returned an unsupported file change.',
          }),
      ),
    )

    files.push(file)
  }

  return files
})

const commit = Effect.fn('GitReview.commit')(function* (root: string, ref: string) {
  const output = yield* git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])

  return yield* Schema.decodeUnknownEffect(Commit)(output.trim()).pipe(
    Effect.mapError(
      () =>
        new ReviewError({
          operation: 'resolve commit',
          message: 'Git returned an invalid commit ID.',
        }),
    ),
  )
})

export const gitReviewLayer = Layer.effect(
  BranchReview,
  Effect.gen(function* () {
    const branches = Effect.fn('BranchReview.branches')(function* (directory: string) {
      const root = (yield* git(directory, ['rev-parse', '--show-toplevel'])).trim()
      const current = (yield* git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

      const output = yield* git(root, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
      ])

      return {
        root,
        current,
        branches: output
          .trim()
          .split('\n')
          .filter((ref) => ref && !ref.endsWith('/HEAD') && ref !== `refs/heads/${current}`),
      }
    })

    const compare = Effect.fn('BranchReview.compare')(function* (root: string, baseBranch: string) {
      const headCommit = yield* commit(root, 'HEAD')
      const targetCommit = yield* commit(root, baseBranch)
      const ancestor = (yield* git(root, ['merge-base', targetCommit, headCommit])).trim()

      const baseCommit = yield* Schema.decodeUnknownEffect(Commit)(ancestor).pipe(
        Effect.mapError(
          () =>
            new ReviewError({
              operation: 'merge-base',
              message: 'The branches have no valid common ancestor.',
            }),
        ),
      )

      const headBranch = (yield* git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

      const output = yield* git(root, [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        baseCommit,
        headCommit,
        '--',
      ])

      const files = yield* decodeFiles(output)

      return Review.make({ root, baseBranch, headBranch, baseCommit, headCommit, files })
    })

    const read = Effect.fn('BranchReview.read')(function* (input: Snapshot) {
      const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(input).pipe(
        Effect.mapError(
          () => new ReviewError({ operation: 'read snapshot', message: 'Invalid snapshot.' }),
        ),
      )

      if (snapshot.path === undefined) return ''

      return yield* git(snapshot.root, ['show', `${snapshot.commit}:${snapshot.path}`])
    })

    return BranchReview.of({ branches, compare, read })
  }),
)
