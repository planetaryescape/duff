import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AzureCliAuthentication,
  makeAzureCliAuthenticationLayer,
} from '@duff/core/azure-cli-authentication'
import { makeSavedReviewStoreLayer } from '@duff/core/file-saved-reviews'
import { ProviderUnavailable, PullRequestSelection } from '@duff/core/git-hosting-provider'
import { GitHubCredentials, makeGitHubCredentialsLayer } from '@duff/core/github-credentials'
import { ProviderAuthentication } from '@duff/core/provider-authentication'
import { pullRequestsLayer } from '@duff/core/pull-request-providers'
import { ResolvedPullRequest } from '@duff/core/pull-requests'
import {
  RepositoryDirectory,
  type RepositoryPullRequestPage,
} from '@duff/core/repository-directory'
import { BranchReview, GitPath, makeGitReviewLayer, ReviewError } from '@duff/core/review'
import { fileSnapshots } from '@duff/core/review-progress'
import { makeReviewWorkspacesLayer, ReviewWorkspaces } from '@duff/core/review-workspaces'
import { ReviewSessions } from '@duff/core/saved-review-sessions'
import { type SavedReview } from '@duff/core/saved-reviews'
import { Effect, Layer, ManagedRuntime, Option, Schema, Semaphore } from 'effect'

const id = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(Number.MIN_SAFE_INTEGER),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

const session = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

const destination = Schema.NonEmptyString.check(Schema.isMaxLength(8192))

const Request = Schema.Union([
  Schema.Struct({
    id,
    op: Schema.Literal('list'),
    destination,
    more: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ id, op: Schema.Literal('prepare'), destination, pr: Schema.NonEmptyString }),
  Schema.Struct({ id, op: Schema.Literal('file'), session, path: GitPath }),
  Schema.Struct({
    id,
    op: Schema.Literal('viewed'),
    session,
    path: GitPath,
    viewed: Schema.Boolean,
  }),
  Schema.Struct({ id, op: Schema.Literal('resume'), session }),
  Schema.Struct({ id, op: Schema.Literal('saved') }),
])

const authentication = Layer.effect(
  ProviderAuthentication,
  Effect.gen(function* () {
    const azure = yield* AzureCliAuthentication
    const github = yield* GitHubCredentials

    return ProviderAuthentication.of({
      session: Effect.fn('StandaloneAuthentication.session')(function* (provider) {
        if (provider === 'microsoft') return Option.some(yield* azure.session())

        if (provider === 'github') return yield* github.session()

        return yield* new ProviderUnavailable()
      }),
    })
  }),
)

const unavailable = () =>
  new ReviewError({ operation: 'standalone', message: 'Review unavailable' })

const unsupportedFile = () =>
  new ReviewError({ operation: 'standalone file', message: 'File unavailable' })

function reviewResponse(saved: SavedReview) {
  const pr = saved.resolved.pullRequest

  return {
    kind: 'review' as const,
    session: saved.key,
    title: pr.title,
    author: pr.author ?? '',
    branch: pr.source._tag === 'Available' ? pr.source.ref.name : '',
    baseCommit: saved.review.baseCommit,
    headCommit: saved.review.headCommit,
    files: saved.review.files.map((file) => ({
      path: file.path,
      status: file.status,
      viewed: saved.viewed.includes(file.path),
    })),
    lastFile: Option.getOrNull(saved.lastFile),
  }
}

/** Isolated standalone storage; never reads the extension's profile or catalog. */
export function standaloneDataDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (environment.DUFF_STANDALONE_DATA) return resolve(environment.DUFF_STANDALONE_DATA)

  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Duff-Standalone')

  if (platform === 'win32')
    return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Duff-Standalone')

  return join(environment.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'Duff-Standalone')
}

/** One Node-side integration boundary, with serialized requests and owned disposal. */
export function makeBridge(directory: string, environment: NodeJS.ProcessEnv) {
  const git = makeGitReviewLayer(environment)

  const sessions = ReviewSessions.layer.pipe(
    Layer.provide(Layer.merge(git, makeSavedReviewStoreLayer(join(directory, 'sessions')))),
  )

  const providers = pullRequestsLayer.pipe(
    Layer.provide(
      authentication.pipe(
        Layer.provide(
          Layer.merge(
            makeAzureCliAuthenticationLayer(environment),
            makeGitHubCredentialsLayer(environment),
          ),
        ),
      ),
    ),
  )

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(git, sessions, providers, makeReviewWorkspacesLayer(directory, environment)),
  )

  const gate = Semaphore.makeUnsafe(1)
  let page: RepositoryPullRequestPage | undefined
  let pageDestination: string | undefined

  const execute = Effect.fn('StandaloneBridge.execute')(function* (
    request: Schema.Schema.Type<typeof Request>,
  ) {
    const saved = yield* ReviewSessions

    if (request.op === 'saved') {
      const catalog = yield* saved.list()

      return {
        kind: 'saved' as const,
        items: catalog.sessions.map((entry) => ({
          session: entry.key,
          title: entry.resolved.pullRequest.title,
          author: entry.resolved.pullRequest.author ?? '',
          repository: entry.selection.repository.displayName,
        })),
      }
    }

    if (request.op === 'list' || request.op === 'prepare') {
      const repositories = yield* RepositoryDirectory
      const recognized = repositories.recognize(request.destination)

      if (Option.isNone(recognized)) return yield* new ProviderUnavailable()

      if (request.op === 'list') {
        if (
          request.more &&
          (pageDestination !== request.destination || !page || Option.isNone(page.next))
        )
          return yield* unavailable()
        const previous = request.more ? page : undefined

        const next = yield* repositories.list(
          previous?.hosting ?? recognized.value,
          'open',
          previous?.next ?? Option.none(),
        )

        page = next
        pageDestination = request.destination

        return {
          kind: 'list' as const,
          repositoryLabel: next.hosting.repository.displayName,
          items: next.items.map((pr) => ({
            id: pr.id,
            title: pr.title,
            author: pr.author ?? '',
            branch: pr.source._tag === 'Available' ? pr.source.ref.name : '',
            filesChanged: null,
          })),
          hasMore: Option.isSome(next.next),
        }
      }

      const resolved = yield* repositories.resolve(recognized.value, request.pr)
      const workspace = yield* (yield* ReviewWorkspaces).prepare(resolved)

      const selection = PullRequestSelection.make({
        provider: recognized.value.provider.id,
        repository: resolved.pullRequest.target.repository,
        id: resolved.pullRequest.id,
        label: resolved.pullRequest.title,
      })

      return reviewResponse(yield* saved.accept(selection, workspace.resolved, workspace.review))
    }

    if (request.op === 'resume') return reviewResponse(yield* saved.resume(request.session))

    const catalog = yield* saved.list()
    const current = catalog.sessions.find((entry) => entry.key === request.session)
    const change = current?.review.files.find((file) => file.path === request.path)

    if (!current || !change) return yield* unavailable()

    if (request.op === 'viewed') {
      const updated = yield* saved.progress(
        current.key,
        current.review,
        [change.path],
        request.viewed,
      )

      return {
        kind: 'viewed' as const,
        session: current.key,
        path: change.path,
        viewed: updated.viewed.includes(change.path),
      }
    }

    const comparison = current.comparisons.find((file) => file.change.path === change.path)

    if (
      !comparison ||
      [comparison.base, comparison.head].some(
        (object) => Option.isSome(object) && object.value.mode === '160000',
      )
    )
      return yield* unsupportedFile()
    const reader = yield* BranchReview
    const [base, head] = fileSnapshots(current.review, change)
    const oldText = yield* reader.read(base)
    const newText = yield* reader.read(head)

    if (
      [oldText, newText].some(
        (text) =>
          Buffer.byteLength(text, 'utf8') > 1024 * 1024 ||
          text.includes('\0') ||
          text.includes('\ufffd'),
      )
    )
      return yield* unsupportedFile()
    yield* saved.opened(current.key, current.review, change.path)

    return {
      kind: 'file' as const,
      session: current.key,
      path: change.path,
      oldText,
      newText,
      binary: false,
    }
  })

  const handle = (line: string, signal?: AbortSignal) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const envelope = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id })))(
          line,
        )

        const requestId = Option.isSome(envelope) ? envelope.value.id : 0
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Request))(line)

        if (Option.isNone(decoded) || Buffer.byteLength(line) > 65536)
          return { id: requestId, ok: false as const, error: 'Invalid request.' }

        return yield* execute(decoded.value).pipe(
          Effect.match({
            onSuccess: (response) => ({ id: requestId, ok: true as const, ...response }),
            onFailure: (error) => ({
              id: requestId,
              ok: false as const,
              error:
                error._tag === 'ReviewError' && error.operation === 'standalone file'
                  ? 'Binary, oversized, or unsupported file unavailable.'
                  : error._tag === 'AuthenticationRequired' ||
                      error._tag === 'GitHubAuthenticationError' ||
                      error._tag === 'AzureCliAuthenticationError'
                    ? 'Authentication unavailable. Sign in with the provider CLI and retry.'
                    : error._tag === 'ReviewStorageError'
                      ? 'Saved review storage unavailable.'
                      : 'Review operation unavailable. Check repository access and retry.',
            }),
          }),
        )
      }).pipe(gate.withPermits(1)),
      { signal },
    )

  /** Explicit local fixture seam: real Git comparison, retention, and catalog; never selected by the UI. */
  const compareLocal = (root: string, branch: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const review = yield* (yield* BranchReview).compare(root, branch)

        const repository = {
          authority: 'local',
          key: review.root,
          displayName: 'Local Git comparison',
        }

        const resolved = ResolvedPullRequest.make({
          pullRequest: {
            id: 'local',
            title: 'Local Git comparison',
            url: 'https://local.invalid/comparison',
            draft: false,
            source: {
              _tag: 'Available',
              repository,
              ref: { name: 'refs/heads/local', revision: Option.some(review.headCommit) },
            },
            target: {
              repository,
              ref: { name: 'refs/heads/base', revision: Option.some(review.baseCommit) },
            },
          },
          revisions: {
            source: { commit: review.headCommit, ref: 'refs/heads/local', remote: Option.none() },
            target: { commit: review.baseCommit, ref: 'refs/heads/base', remote: Option.none() },
          },
        })

        return reviewResponse(
          yield* (yield* ReviewSessions).accept(
            PullRequestSelection.make({
              provider: 'local',
              repository,
              id: 'local',
              label: 'Local Git comparison',
            }),
            resolved,
            review,
          ),
        )
      }).pipe(gate.withPermits(1)),
    )

  return { handle, compareLocal, dispose: () => runtime.dispose() }
}

/** Composition-root convenience; callers can supply isolated environment and storage explicitly. */
export function makeStandaloneBridge(environment: NodeJS.ProcessEnv) {
  return makeBridge(standaloneDataDirectory(environment, process.platform, homedir()), environment)
}
