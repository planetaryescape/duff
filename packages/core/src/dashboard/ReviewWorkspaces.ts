import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, lstat, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Run } from '@effected/commands'
import { Context, Effect, Layer, Option, Schedule, Schema } from 'effect'
import { ChildProcessSpawner } from 'effect/process'

import { gitCommand, makeGitProcessLayer } from '../git-context/GitProcess'
import { ResolvedPullRequest } from '../pull-requests/PullRequests'
import {
  BranchReview,
  makeGitReviewLayer,
  Review,
  ReviewError,
  ReviewRevision,
  ReviewRevisions,
} from '../review/BranchReview'

export const PreparedWorkspace = Schema.Struct({
  directory: Schema.String,
  review: Review,
  resolved: ResolvedPullRequest,
})

export interface PreparedWorkspace extends Schema.Schema.Type<typeof PreparedWorkspace> {}

export class ReviewWorkspaces extends Context.Service<
  ReviewWorkspaces,
  {
    readonly prepare: (
      resolved: ResolvedPullRequest,
    ) => Effect.Effect<PreparedWorkspace, ReviewError>
    readonly load: (
      directory: string,
    ) => Effect.Effect<Option.Option<PreparedWorkspace>, ReviewError>
  }
>()('duff/dashboard/ReviewWorkspaces') {}

const codec = Schema.fromJsonString(Schema.toCodecJson(PreparedWorkspace))

const sqliteError = Schema.Struct({ errcode: Schema.Int })

const missing = Schema.Struct({ code: Schema.Literal('ENOENT') })

const failure = (operation: string) =>
  new ReviewError({
    operation,
    message:
      'The managed review workspace is unavailable or its identity changed. Existing files have been preserved. Check Git access and retry. Private diagnostics are hidden.',
  })

function key(resolved: ResolvedPullRequest): string {
  const pr = resolved.pullRequest

  return createHash('sha256')
    .update(
      JSON.stringify([
        pr.target.repository.authority.toLowerCase(),
        pr.target.repository.key,
        pr.id,
        pr.source._tag === 'Available' ? pr.source.repository.authority.toLowerCase() : '',
        pr.source._tag === 'Available' ? pr.source.repository.key : '',
        resolved.revisions.source.commit,
        resolved.revisions.target.commit,
      ]),
    )
    .digest('hex')
}

/** All inherited Git configuration is disabled; trusted credentials are added separately. */
function isolatedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment }

  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name]
  }

  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  env.GIT_CONFIG_COUNT = '0'
  env.GIT_ATTR_NOSYSTEM = '1'
  env.GIT_TEMPLATE_DIR = ''

  return env
}

const credentialEnvironment = Effect.fn('ReviewWorkspaces.credentialEnvironment')(function* (
  environment: NodeJS.ProcessEnv,
) {
  // Ask Git to resolve its own system/global includes outside the reviewed repo.
  // Scope filtering excludes repository and command/environment-injected config.
  const output = yield* Run.collect(
    gitCommand(tmpdir(), ['config', '--null', '--show-scope', '--includes', '--list']),
    { timeout: '60 seconds' },
  ).pipe(Effect.mapError(() => failure('read Git credential configuration')))

  if (!output.succeeded) return yield* failure('read Git credential configuration')

  const env = isolatedEnvironment(environment)
  const fields = output.stdout.split('\0')
  let count = 0

  if (fields.pop() !== '' || fields.length % 2 !== 0)
    return yield* failure('read Git credential configuration')

  for (let index = 0; index < fields.length; index += 2) {
    const scope = fields[index]
    const entry = fields[index + 1]

    if ((scope !== 'global' && scope !== 'system') || entry === undefined) continue

    const separator = entry.indexOf('\n')
    const name = separator < 0 ? entry : entry.slice(0, separator)

    if (!name.startsWith('credential.')) continue

    // Preserve ordering, repeated helpers, empty helper resets, URL scopes and
    // multiline values. Values live only in child environments, never argv/disk.
    env[`GIT_CONFIG_KEY_${count}`] = name
    env[`GIT_CONFIG_VALUE_${count}`] = separator < 0 ? 'true' : entry.slice(separator + 1)
    count += 1
  }

  env.GIT_CONFIG_COUNT = String(count)

  return env
})

const io = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => failure(operation) })

// SQLite owns the OS lock, not a PID/lease file. Process death releases it; no
// timeout can steal a live writer's lock. Retained empty databases are harmless.
const lock = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new DatabaseSync(path)

        try {
          database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')

          return database
        } catch (error) {
          database.close()
          throw error
        }
      },
      catch: (error) => {
        const decoded = Schema.decodeUnknownOption(sqliteError)(error)

        return failure(
          Option.isSome(decoded) && [5, 6].includes(decoded.value.errcode)
            ? 'workspace busy'
            : 'lock workspace',
        )
      },
    }),
    (database) => Effect.sync(() => database.close()),
  ).pipe(
    Effect.retry({
      while: (error) => error.operation === 'workspace busy',
      times: 1200,
      schedule: Schedule.spaced('100 millis'),
    }),
  )

/**
 * The dependency-bearing layer is also the real-Git test seam. Production callers
 * use the factory below, which supplies the isolated Git adapters.
 */
const workspaceLayer = (directory: string, environment: NodeJS.ProcessEnv) =>
  Layer.effect(
    ReviewWorkspaces,
    Effect.gen(function* () {
      const branchReview = yield* BranchReview
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = join(resolve(directory), 'review-workspaces')

      const git = Effect.fn('ReviewWorkspaces.git')(function* (
        cwd: string,
        args: ReadonlyArray<string>,
      ) {
        const output = yield* Run.collect(
          gitCommand(cwd, [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.attributesFile=/dev/null',
            '-c',
            'submodule.recurse=false',
            ...args,
          ]),
          { timeout: '60 seconds' },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(() => failure('prepare workspace')),
        )

        if (!output.succeeded) return yield* failure('prepare workspace')

        return output.stdout.trim()
      })

      const read = Effect.fn('ReviewWorkspaces.read')(function* (path: string) {
        const text = yield* Effect.tryPromise({
          try: () => readFile(path, 'utf8'),
          catch: (error) =>
            Schema.is(missing)(error)
              ? Option.none<ReviewError>()
              : Option.some(failure('load workspace')),
        }).pipe(
          Effect.catch((error) =>
            Option.isNone(error) ? Effect.succeed(undefined) : Effect.fail(error.value),
          ),
        )

        if (text === undefined) return Option.none<PreparedWorkspace>()

        return Option.some(
          yield* Schema.decodeUnknownEffect(codec)(text).pipe(
            Effect.mapError(() => failure('load workspace')),
          ),
        )
      })

      const load = Effect.fn('ReviewWorkspaces.load')(function* (input: string) {
        const project = resolve(input)
        const container = dirname(project)

        if (
          dirname(container) !== root ||
          project !== join(container, 'project') ||
          !/^[a-f0-9]{64}$/.test(container.slice(root.length + 1))
        )
          return Option.none<PreparedWorkspace>()

        const saved = yield* read(join(container, 'workspace.json'))

        if (Option.isNone(saved)) return saved
        const prepared = saved.value

        if (
          key(prepared.resolved) !== container.slice(root.length + 1) ||
          prepared.directory !== project ||
          prepared.review.root !== project ||
          prepared.review.headCommit !== prepared.resolved.revisions.source.commit
        )
          return yield* failure('load workspace')

        // Refuse symlink substitution, a foreign repository, and a moved HEAD. Never
        // repair/reset a checkout on reopen, even when the owner changed its identity.
        const canonical = yield* io('load workspace', () => realpath(project))
        const dotGit = yield* io('load workspace', () => lstat(join(project, '.git')))

        if (
          canonical !== project ||
          !dotGit.isDirectory() ||
          dotGit.isSymbolicLink() ||
          (yield* git(project, ['rev-parse', '--show-toplevel'])) !== project ||
          (yield* git(project, ['rev-parse', '--absolute-git-dir'])) !== join(project, '.git') ||
          (yield* git(project, ['rev-parse', '--verify', 'HEAD'])) !== prepared.review.headCommit ||
          (yield* git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== 'HEAD' ||
          (yield* git(project, [
            'rev-parse',
            '--verify',
            `${prepared.review.baseCommit}^{commit}`,
          ])) !== prepared.review.baseCommit
        )
          return yield* failure('load workspace')

        return saved
      })

      const prepare = Effect.fn('ReviewWorkspaces.prepare')(function* (input: ResolvedPullRequest) {
        const resolved = yield* Schema.decodeUnknownEffect(ResolvedPullRequest)(input).pipe(
          Effect.mapError(() => failure('prepare workspace')),
        )

        const id = key(resolved)
        yield* io('prepare workspace', () => mkdir(root, { recursive: true, mode: 0o700 }))
        yield* lock(join(root, `${id}.sqlite`))
        const container = join(root, id)
        const project = join(container, 'project')
        const existing = yield* load(project)

        if (Option.isSome(existing)) return existing.value

        // Missing metadata is not permission to replace a directory with user files.
        const present = yield* Effect.tryPromise({
          try: () => lstat(container),
          catch: (error) =>
            Schema.is(missing)(error)
              ? Option.none<ReviewError>()
              : Option.some(failure('prepare workspace')),
        }).pipe(
          Effect.catch((error) =>
            Option.isNone(error) ? Effect.succeed(undefined) : Effect.fail(error.value),
          ),
        )

        if (present !== undefined) return yield* failure('prepare workspace')

        const staging = yield* Effect.acquireRelease(
          io('prepare workspace', () => mkdtemp(join(root, '.preparing-'))),
          (path) =>
            io('clean workspace staging', () => rm(path, { recursive: true, force: true })).pipe(
              Effect.orDie,
            ),
        )

        const checkout = join(staging, 'project')
        yield* io('prepare workspace', () => mkdir(checkout))
        yield* git(checkout, ['init', '--template=', '.'])
        yield* git(checkout, ['config', 'core.hooksPath', '/dev/null'])
        yield* git(checkout, ['config', 'submodule.recurse', 'false'])
        yield* git(checkout, ['config', 'core.attributesFile', '/dev/null'])

        const revisions = yield* Effect.forEach(
          ['source', 'target'] as const,
          Effect.fn('ReviewWorkspaces.remote')(function* (side) {
            const revision = resolved.revisions[side]

            if (Option.isNone(revision.remote)) return yield* failure('configure workspace remote')
            const raw = revision.remote.value.destination

            const parsed = yield* Effect.try({
              try: () => new URL(raw),
              catch: () => failure('configure workspace remote'),
            })

            if (
              !['https:', 'ssh:'].includes(parsed.protocol) ||
              parsed.password ||
              parsed.search ||
              parsed.hash ||
              (parsed.username && (parsed.protocol !== 'ssh:' || parsed.username !== 'git'))
            )
              return yield* failure('configure workspace remote')

            yield* git(checkout, ['remote', 'add', side, raw])

            // BranchReview compares the canonical credential-free destination,
            // but Git must retain an explicitly supplied SSH user for transport.
            const destination = `${parsed.protocol}//${parsed.host}${parsed.pathname}`

            return ReviewRevision.make({
              ...revision,
              remote: Option.some({ name: side, destination }),
            })
          }),
        )

        const source = revisions[0]
        const target = revisions[1]

        if (!source || !target) return yield* failure('prepare workspace')

        const review = yield* branchReview
          .prepare(checkout, ReviewRevisions.make({ source, target }), 'fetch')
          .pipe(Effect.catchTag('FetchRequired', () => Effect.fail(failure('prepare workspace'))))

        yield* git(checkout, [
          'checkout',
          '--detach',
          '--no-recurse-submodules',
          resolved.revisions.source.commit,
          '--',
        ])

        const prepared = PreparedWorkspace.make({
          directory: project,
          review: Review.make({
            root: project,
            baseBranch: review.baseBranch,
            headBranch: review.headBranch,
            baseCommit: review.baseCommit,
            headCommit: review.headCommit,
            files: review.files,
          }),
          resolved,
        })

        const text = yield* Schema.encodeEffect(codec)(prepared).pipe(
          Effect.mapError(() => failure('save workspace')),
        )

        yield* io('save workspace', () =>
          writeFile(join(staging, 'workspace.json'), text, { mode: 0o600, flag: 'wx' }),
        )
        // The checkout and metadata become visible together, only after acquisition,
        // comparison and checkout have all completed successfully.
        yield* io('publish workspace', () => rename(staging, container)).pipe(
          Effect.uninterruptible,
        )

        return prepared
      }, Effect.scoped)

      return ReviewWorkspaces.of({ prepare, load })
    }),
  ).pipe(Layer.provide(makeGitProcessLayer(environment)))

const unavailableLayer = (error: ReviewError) =>
  Layer.succeed(
    ReviewWorkspaces,
    ReviewWorkspaces.of({
      prepare: Effect.fn('ReviewWorkspaces.prepare')(() => Effect.fail(error)),
      load: Effect.fn('ReviewWorkspaces.load')(() => Effect.fail(error)),
    }),
  )

export const reviewWorkspacesLayer = (directory: string, environment: NodeJS.ProcessEnv) =>
  Layer.unwrap(
    credentialEnvironment(environment).pipe(
      Effect.match({
        onFailure: unavailableLayer,
        onSuccess: (env) => workspaceLayer(directory, env),
      }),
    ),
  ).pipe(Layer.provide(makeGitProcessLayer(environment)))

export const makeReviewWorkspacesLayer = (directory: string, environment: NodeJS.ProcessEnv) =>
  Layer.unwrap(
    credentialEnvironment(environment).pipe(
      Effect.match({
        onFailure: unavailableLayer,
        onSuccess: (env) =>
          workspaceLayer(directory, env).pipe(Layer.provide(makeGitReviewLayer(env))),
      }),
    ),
  ).pipe(Layer.provide(makeGitProcessLayer(environment)))
