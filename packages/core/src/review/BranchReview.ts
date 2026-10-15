import { spawn } from 'node:child_process'

import { Context, Effect, Layer, Option, Schema } from 'effect'

import { repositoryEnvironment } from '../git-context/RepositoryEnvironment'

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

export class ReviewError extends Schema.TaggedError<ReviewError>()('ReviewError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const ReviewRevision = Schema.Struct({
  commit: Commit,
  ref: Schema.String,
  remote: Schema.Option(Schema.Struct({ name: Schema.String, destination: Schema.String })),
})

export interface ReviewRevision extends Schema.Schema.Type<typeof ReviewRevision> {}

export const ReviewRevisions = Schema.Struct({ source: ReviewRevision, target: ReviewRevision })

export interface ReviewRevisions extends Schema.Schema.Type<typeof ReviewRevisions> {}

export const FileObject = Schema.Struct({ id: Commit, mode: Schema.String })

export const FileComparison = Schema.Struct({
  change: FileChange,
  base: Schema.Option(FileObject),
  head: Schema.Option(FileObject),
})

export interface FileComparison extends Schema.Schema.Type<typeof FileComparison> {}

export const RetentionPrefix = Schema.String.check(
  Schema.isPattern(/^refs\/duff\/sessions\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}$/),
)

export class FetchRequired extends Schema.TaggedError<FetchRequired>()('FetchRequired', {}) {}

export class BranchReview extends Context.Service<
  BranchReview,
  {
    readonly branches: (directory: string) => Effect.Effect<Branches, ReviewError>
    readonly compare: (root: string, branch: string) => Effect.Effect<Review, ReviewError>
    readonly prepare: (
      root: string,
      revisions: ReviewRevisions,
      permission: 'local-only' | 'fetch',
    ) => Effect.Effect<Review, ReviewError | FetchRequired>
    readonly read: (snapshot: Snapshot) => Effect.Effect<string, ReviewError>
    readonly comparisons: (
      review: Review,
    ) => Effect.Effect<ReadonlyArray<FileComparison>, ReviewError>
    readonly retain: (
      root: string,
      prefix: string,
      commits: ReadonlyArray<string>,
    ) => Effect.Effect<void, ReviewError>
    readonly release: (root: string, prefix: string) => Effect.Effect<void, ReviewError>
  }
>()('duff/BranchReview') {}

function fetchDestination(raw: string): Option.Option<string> {
  try {
    const url = new URL(raw)

    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.username && (url.protocol !== 'ssh:' || url.username !== 'git'))
    )
      return Option.none()

    return Option.some(`${url.protocol}//${url.host}${url.pathname}`)
  } catch {
    return /^(?:git@)?(?:github\.com|ssh\.dev\.azure\.com):[^\s?#]+$/.test(raw)
      ? Option.some(raw.replace(/^git@/, ''))
      : Option.none()
  }
}

export const makeGitReviewLayer = (environment: NodeJS.ProcessEnv) => {
  const env = {
    ...repositoryEnvironment(environment),
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  }

  const git = Effect.fn('GitReview.git')(function* (root: string, args: ReadonlyArray<string>) {
    const failure = () =>
      new ReviewError({
        operation: args[0] ?? 'git',
        message:
          'Git operation failed. Check that Git is installed, the repository has commits, and the selected branch is available locally. Raw diagnostics are hidden because they may contain private data.',
      })

    return yield* Effect.callback<string, ReviewError>((resume) => {
      const child = spawn('git', ['-C', root, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })

      let stdout = ''
      let bytes = 0

      const stop = () => {
        if (child.pid !== undefined) {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL')
            else process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)

        if (bytes > 16 * 1024 * 1024) stop()
        else stdout += chunk
      })
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length

        if (bytes > 16 * 1024 * 1024) stop()
      })
      child.once('error', () => {})

      const closed = new Promise<void>((resolve) =>
        child.once('close', (code) => {
          resolve()
          resume(
            code === 0 && bytes <= 16 * 1024 * 1024
              ? Effect.succeed(stdout)
              : Effect.fail(failure()),
          )
        }),
      )

      return Effect.promise(async () => {
        stop()
        await closed
      })
    }).pipe(Effect.timeoutOrElse({ duration: '60 seconds', orElse: failure }))
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
    const output = yield* git(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ])

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

  return Layer.effect(
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

        return Branches.make({
          root,
          current,
          branches: output
            .trim()
            .split('\n')
            .filter((ref) => ref && !ref.endsWith('/HEAD') && ref !== `refs/heads/${current}`),
        })
      })

      const compare = Effect.fn('BranchReview.compare')(function* (
        root: string,
        baseBranch: string,
      ) {
        const headCommit = yield* commit(root, 'HEAD')
        const targetCommit = yield* commit(root, baseBranch)
        const headBranch = (yield* git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

        return yield* compareCommits(root, baseBranch, headBranch, targetCommit, headCommit)
      })

      const compareCommits = Effect.fn('BranchReview.compareCommits')(function* (
        root: string,
        baseBranch: string,
        headBranch: string,
        targetCommit: string,
        headCommit: string,
      ) {
        if ((yield* git(root, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false')
          return yield* new ReviewError({
            operation: 'merge-base',
            message:
              'Shallow history cannot establish a trustworthy comparison base. Obtain full history outside Duff, then retry. Duff does not unshallow repositories.',
          })

        const ancestor = (yield* git(root, ['merge-base', '--all', targetCommit, headCommit]).pipe(
          Effect.mapError(
            () =>
              new ReviewError({
                operation: 'merge-base',
                message:
                  'No common ancestor is available. History may be shallow or unrelated. Obtain the required history outside Duff, then refresh the PR. Duff does not unshallow repositories.',
              }),
          ),
        )).trim()

        const baseCommit = yield* Schema.decodeUnknownEffect(Commit)(ancestor).pipe(
          Effect.mapError(
            () =>
              new ReviewError({
                operation: 'merge-base',
                message:
                  'The revisions have no unique common ancestor. Ambiguous merge bases are not supported.',
              }),
          ),
        )

        const output = yield* git(root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
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

      const acquire = Effect.fn('BranchReview.acquire')(function* (
        root: string,
        revision: ReviewRevision,
        side: 'source' | 'target',
      ) {
        if (Option.isNone(revision.remote))
          return yield* new ReviewError({
            operation: 'fetch',
            message:
              'No configured remote matches this PR repository. Add a remote for the exact source or target repository outside Duff, then refresh Git context and retry.',
          })
        const remote = revision.remote.value
        const raw = (yield* git(root, ['remote', 'get-url', '--', remote.name])).trim()
        const destination = fetchDestination(raw)

        if (
          Option.getOrUndefined(destination) !== remote.destination ||
          !/^[a-zA-Z0-9_.-]+$/.test(remote.name) ||
          remote.name.startsWith('-')
        )
          return yield* new ReviewError({
            operation: 'fetch',
            message:
              'Remote configuration changed or is unsupported. Refresh Git context and retry.',
          })
        yield* git(root, ['check-ref-format', revision.ref])

        if (!revision.ref.startsWith('refs/heads/'))
          return yield* new ReviewError({
            operation: 'fetch',
            message: 'The provider did not supply a supported branch ref.',
          })
        const owned = `refs/duff/reviews/${side}`

        const options = [
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          '-c',
          `remote.${remote.name}.uploadpack=git-upload-pack`,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'fetch.writeCommitGraph=false',
          'fetch',
          '--no-tags',
          '--no-prune',
          '--no-prune-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          '--refmap=',
          '--',
          remote.name,
        ]

        const fetched = yield* Effect.result(
          git(root, [...options, `+${revision.commit}:${owned}`]),
        )

        if (fetched._tag === 'Failure')
          yield* git(root, [...options, `+${revision.ref}:${owned}`]).pipe(
            Effect.mapError(
              () =>
                new ReviewError({
                  operation: 'fetch',
                  message:
                    'Git could not acquire the PR revision. Check Git credentials and source access outside Duff. API sign-in does not provide Git authentication. Refresh the PR before retrying.',
                }),
            ),
          )

        if ((yield* commit(root, owned)) !== revision.commit)
          return yield* new ReviewError({
            operation: 'fetch',
            message:
              'The remote branch moved after PR revisions were pinned. Refresh the PR explicitly to prepare a new snapshot.',
          })
      })

      const prepare = Effect.fn('BranchReview.prepare')(function* (
        root: string,
        input: ReviewRevisions,
        permission: 'local-only' | 'fetch',
      ) {
        const revisions = yield* Schema.decodeUnknownEffect(ReviewRevisions)(input).pipe(
          Effect.mapError(
            () =>
              new ReviewError({
                operation: 'prepare',
                message: 'The provider did not supply valid exact revisions.',
              }),
          ),
        )

        for (const side of ['source', 'target'] as const) {
          const revision = revisions[side]
          const available = yield* Effect.result(commit(root, revision.commit))

          if (available._tag === 'Success' && available.success === revision.commit) continue

          if (permission === 'local-only') return yield* new FetchRequired()
          yield* acquire(root, revision, side)
        }

        return yield* compareCommits(
          root,
          revisions.target.ref,
          revisions.source.ref,
          revisions.target.commit,
          revisions.source.commit,
        )
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

      const object = Effect.fn('BranchReview.object')(function* (
        root: string,
        revision: string,
        path: string,
      ) {
        const output = yield* git(root, ['ls-tree', '-z', revision, '--', `:(literal)${path}`])
        const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(output)

        if (!match || match[3] !== path)
          return yield* new ReviewError({
            operation: 'read comparison',
            message: 'The saved comparison is unavailable. Its Git objects may be missing.',
          })

        return yield* Schema.decodeUnknownEffect(FileObject)({ mode: match[1], id: match[2] }).pipe(
          Effect.mapError(
            () =>
              new ReviewError({
                operation: 'read comparison',
                message: 'Git returned invalid file metadata.',
              }),
          ),
        )
      })

      const comparisons = Effect.fn('BranchReview.comparisons')(function* (review: Review) {
        return yield* Effect.forEach(
          review.files,
          Effect.fn('BranchReview.fileComparison')(function* (change) {
            const base =
              change.status === 'A'
                ? Option.none()
                : Option.some(
                    yield* object(
                      review.root,
                      review.baseCommit,
                      change.previousPath ?? change.path,
                    ),
                  )

            const head =
              change.status === 'D'
                ? Option.none()
                : Option.some(yield* object(review.root, review.headCommit, change.path))

            return FileComparison.make({ change, base, head })
          }),
        )
      })

      const prefix = (value: string) =>
        Schema.decodeUnknownEffect(RetentionPrefix)(value).pipe(
          Effect.mapError(
            () =>
              new ReviewError({
                operation: 'retention',
                message: 'Invalid Duff retention namespace.',
              }),
          ),
        )

      const retain = Effect.fn('BranchReview.retain')(function* (
        root: string,
        input: string,
        commits: ReadonlyArray<string>,
      ) {
        const namespace = yield* prefix(input)

        for (const [index, value] of commits.entries()) {
          const verified = yield* commit(root, value)
          yield* git(root, [
            '-c',
            'core.hooksPath=/dev/null',
            'update-ref',
            `${namespace}/${index}`,
            verified,
          ])
        }
      })

      const release = Effect.fn('BranchReview.release')(function* (root: string, input: string) {
        const namespace = yield* prefix(input)
        const output = yield* git(root, ['for-each-ref', '--format=%(refname)', `${namespace}/`])

        for (const ref of output.trim().split('\n')) {
          if (ref.startsWith(`${namespace}/`))
            yield* git(root, ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', ref])
        }
      })

      return BranchReview.of({ branches, compare, prepare, read, comparisons, retain, release })
    }),
  )
}
