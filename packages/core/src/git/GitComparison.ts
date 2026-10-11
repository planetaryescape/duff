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

/** Available comparison bases and the currently checked-out branch. */
export const Branches = Schema.Struct({
  root: Schema.String,
  current: Schema.String,
  branches: Schema.Array(Schema.String),
})

export interface Branches extends Schema.Schema.Type<typeof Branches> {}

export class GitComparisonError extends Schema.TaggedError<GitComparisonError>()(
  'GitComparisonError',
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class GitComparison extends Context.Service<
  GitComparison,
  {
    readonly branches: (directory: string) => Effect.Effect<Branches, GitComparisonError>
    readonly compare: (root: string, branch: string) => Effect.Effect<Review, GitComparisonError>
    readonly read: (snapshot: Snapshot) => Effect.Effect<string, GitComparisonError>
  }
>()('duff/git/GitComparison') {}

const execute = promisify(execFile)

const git = Effect.fn('GitComparison.git')(function* (root: string, args: ReadonlyArray<string>) {
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      execute('git', ['-C', root, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        signal,
      }),
    catch: () =>
      new GitComparisonError({
        operation: args[0] ?? 'git',
        message:
          'Git operation failed. Check that Git is installed, the repository has commits, and the selected branch is available locally. Raw diagnostics are hidden because they may contain private data.',
      }),
  })

  return result.stdout
})

const decodeFiles = Effect.fn('GitComparison.decodeFiles')(function* (output: string) {
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
          new GitComparisonError({
            operation: 'decode changed files',
            message: 'Git returned an unsupported file change.',
          }),
      ),
    )

    files.push(file)
  }

  return files
})

const commit = Effect.fn('GitComparison.commit')(function* (root: string, ref: string) {
  const output = yield* git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])

  return yield* Schema.decodeUnknownEffect(Commit)(output.trim()).pipe(
    Effect.mapError(
      () =>
        new GitComparisonError({
          operation: 'resolve commit',
          message: 'Git returned an invalid commit ID.',
        }),
    ),
  )
})

export const gitComparisonLayer = Layer.effect(
  GitComparison,
  Effect.gen(function* () {
    const branches = Effect.fn('GitComparison.branches')(function* (directory: string) {
      const root = (yield* git(directory, ['rev-parse', '--show-toplevel'])).trim()
      const current = (yield* git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

      const output = yield* git(root, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
      ])

      return Branches.make({
        root,
        current,
        branches: output
          .trim()
          .split('\n')
          .filter((ref) => ref && !ref.endsWith('/HEAD') && ref !== `refs/heads/${current}`),
      })
    })

    const compare = Effect.fn('GitComparison.compare')(function* (
      root: string,
      baseBranch: string,
    ) {
      const headCommit = yield* commit(root, 'HEAD')
      const targetCommit = yield* commit(root, baseBranch)
      const ancestor = (yield* git(root, ['merge-base', targetCommit, headCommit])).trim()

      const baseCommit = yield* Schema.decodeUnknownEffect(Commit)(ancestor).pipe(
        Effect.mapError(
          () =>
            new GitComparisonError({
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

    const read = Effect.fn('GitComparison.read')(function* (input: Snapshot) {
      const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(input).pipe(
        Effect.mapError(
          () =>
            new GitComparisonError({ operation: 'read snapshot', message: 'Invalid snapshot.' }),
        ),
      )

      if (snapshot.path === undefined) return ''

      return yield* git(snapshot.root, ['show', `${snapshot.commit}:${snapshot.path}`])
    })

    return GitComparison.of({ branches, compare, read })
  }),
)
