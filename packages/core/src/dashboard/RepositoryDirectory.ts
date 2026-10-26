import { Context, Effect, Layer, Option, type Redacted, Schema } from 'effect'

import { GitContextSnapshot } from '../git-context/GitContext'
import {
  AuthenticationRequired,
  type ChangeStatistics,
  ComparisonChanged,
  type DiscoveryError,
  type GitHostingProvider,
  InvalidContinuation,
  type ProviderIdentity,
  type ProviderRepository,
  type OpenPullRequest,
  type PullRequestDetails,
  PullRequestPage,
  type PullRequestState,
  type RepositoryIdentity,
  RepositoryUnavailable,
} from '../pull-requests/GitHostingProvider'
import { ResolvedPullRequest } from '../pull-requests/PullRequests'
import { ReviewError, ReviewRevision, ReviewRevisions } from '../review/BranchReview'
import { HostedRepository } from './Repositories'

export const RepositoryPage = Schema.Struct({
  items: Schema.Array(HostedRepository),
  hasMore: Schema.Boolean,
})

export interface RepositoryPage extends Schema.Schema.Type<typeof RepositoryPage> {}

export const RepositoryPullRequestPage = Schema.Struct({
  ...PullRequestPage.fields,
  hosting: HostedRepository,
})

export interface RepositoryPullRequestPage extends Schema.Schema.Type<
  typeof RepositoryPullRequestPage
> {}

export const RepositorySource = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  label: Schema.String,
  scope: Schema.String,
})

export interface RepositorySource extends Schema.Schema.Type<typeof RepositorySource> {}

export class RepositoryDirectory extends Context.Service<
  RepositoryDirectory,
  {
    readonly providers: ReadonlyArray<ProviderIdentity>
    readonly recognize: (destination: string) => Option.Option<HostedRepository>
    readonly suggest: (hosted: HostedRepository) => RepositorySource
    readonly browse: (
      providerId: string,
      scope: string,
      page: number,
      mode: 'silent' | 'connect',
    ) => Effect.Effect<RepositoryPage, DiscoveryError>
    readonly list: (
      hosted: HostedRepository,
      state: PullRequestState,
      cursor: Option.Option<Redacted.Redacted>,
    ) => Effect.Effect<RepositoryPullRequestPage, DiscoveryError>
    readonly details: (
      hosted: HostedRepository,
      id: string,
    ) => Effect.Effect<PullRequestDetails, DiscoveryError>
    readonly metadata: (
      hosted: HostedRepository,
      id: string,
    ) => Effect.Effect<PullRequestDetails, DiscoveryError>
    readonly statistics: (
      hosted: HostedRepository,
      expected: OpenPullRequest,
    ) => Effect.Effect<ChangeStatistics, DiscoveryError | ComparisonChanged>
    readonly avatar: (
      hosted: HostedRepository,
      key: string,
    ) => Effect.Effect<Option.Option<string>, DiscoveryError>
    readonly connect: (hosted: HostedRepository) => Effect.Effect<void, DiscoveryError>
    readonly resolve: (
      hosted: HostedRepository,
      id: string,
    ) => Effect.Effect<ResolvedPullRequest, DiscoveryError | ReviewError>
  }
>()('duff/dashboard/RepositoryDirectory') {}

const same = (left: RepositoryIdentity, right: RepositoryIdentity) =>
  left.authority === right.authority && left.key === right.key

const remote = (destination: string) =>
  GitContextSnapshot.fields.remotes.value.make({
    name: 'directory',
    destination,
    transport: 'https',
    credentials: { _tag: 'NotApplicable' },
  })

class BoundRepository {
  constructor(
    readonly provider: GitHostingProvider,
    readonly repository: ProviderRepository,
  ) {}
}

export const makeRepositoryDirectoryLayer = (providers: ReadonlyArray<GitHostingProvider>) =>
  Layer.effect(
    RepositoryDirectory,
    Effect.gen(function* () {
      if (new Set(providers.map((provider) => provider.identity.id)).size !== providers.length)
        return yield* Effect.die(new Error('Duplicate Duff provider registration.'))

      const recognize = (destination: string): Option.Option<HostedRepository> => {
        const matches = providers.flatMap((provider) => {
          const repository = provider.recognizeRemote(remote(destination))

          if (Option.isNone(repository)) return []
          const cloneUrl = provider.destination?.(repository.value.identity)

          return cloneUrl && Option.isSome(cloneUrl)
            ? [
                HostedRepository.make({
                  provider: provider.identity,
                  repository: repository.value.identity,
                  cloneUrl: cloneUrl.value,
                }),
              ]
            : []
        })

        return matches.length === 1 ? Option.fromUndefinedOr(matches[0]) : Option.none()
      }

      const bound = new Map<string, ProviderRepository>()

      const bind = Effect.fn('RepositoryDirectory.bind')(function* (hosted: HostedRepository) {
        const provider = providers.find((item) => item.identity.id === hosted.provider.id)
        const destination = provider?.destination?.(hosted.repository)

        if (!provider || !destination || Option.isNone(destination))
          return yield* new RepositoryUnavailable()
        // Never trust a persisted clone URL or bind an identity to another repository.
        const recognized = provider.recognizeRemote(remote(hosted.cloneUrl))

        if (Option.isNone(recognized) || !same(recognized.value.identity, hosted.repository))
          return yield* new RepositoryUnavailable()
        const key = JSON.stringify([provider.identity.id, hosted.repository])
        let repository = bound.get(key)

        if (!repository) {
          repository = recognized.value
          bound.set(key, repository)
        }

        return new BoundRepository(provider, repository)
      })

      return RepositoryDirectory.of({
        providers: providers.map((provider) => provider.identity),
        recognize,
        suggest: (hosted) => {
          const provider = providers.find((item) => item.identity.id === hosted.provider.id)
          const scope = provider?.browsingScope?.(hosted.repository) ?? ''

          return RepositorySource.make({
            id: JSON.stringify([hosted.provider.id, scope]),
            providerId: hosted.provider.id,
            label: scope
              ? `${provider?.identity.displayName ?? hosted.provider.displayName}: ${scope}`
              : hosted.provider.displayName,
            scope,
          })
        },
        browse: Effect.fn('RepositoryDirectory.browse')(function* (providerId, scope, page, mode) {
          if (!Number.isSafeInteger(page) || page < 1) return yield* new InvalidContinuation()
          const provider = providers.find((item) => item.identity.id === providerId)

          if (!provider?.browseRepositories) return yield* new RepositoryUnavailable()

          return yield* provider.browseRepositories(scope, page, mode)
        }),
        list: Effect.fn('RepositoryDirectory.list')(function* (hosted, state, cursor) {
          const { provider, repository } = yield* bind(hosted)

          return yield* repository.listPullRequests({ scope: 'repository', state, cursor }).pipe(
            Effect.map((page) =>
              RepositoryPullRequestPage.make({
                items: page.items,
                next: page.next,
                hosting: hosted,
              }),
            ),
            Effect.catchTag(
              'ProviderRedirected',
              Effect.fn('RepositoryDirectory.recoverMoved')(function* (error) {
                if (!provider.refreshRepository) return yield* error
                const identity = yield* provider.refreshRepository(hosted.repository)
                const destination = provider.destination?.(identity)

                if (!destination || Option.isNone(destination)) return yield* error
                const canonical = recognize(destination.value)

                if (Option.isNone(canonical) || same(canonical.value.repository, hosted.repository))
                  return yield* error
                const refreshed = yield* bind(canonical.value)

                const page = yield* refreshed.repository.listPullRequests({
                  scope: 'repository',
                  state,
                  cursor: Option.none(),
                })

                return RepositoryPullRequestPage.make({
                  items: page.items,
                  next: page.next,
                  hosting: HostedRepository.make({
                    provider: provider.identity,
                    repository: identity,
                    cloneUrl: destination.value,
                  }),
                })
              }),
            ),
          )
        }),
        details: Effect.fn('RepositoryDirectory.details')(function* (hosted, id) {
          const { repository } = yield* bind(hosted)
          const details = yield* repository.getPullRequestDetails(id)

          if (
            details.pullRequest.id !== id ||
            !same(details.pullRequest.target.repository, hosted.repository)
          )
            return yield* new RepositoryUnavailable()

          return details
        }),
        metadata: Effect.fn('RepositoryDirectory.metadata')(function* (hosted, id) {
          const { repository } = yield* bind(hosted)

          const details = yield* (
            repository.getPullRequestMetadata ?? repository.getPullRequestDetails
          )(id)

          if (
            details.pullRequest.id !== id ||
            !same(details.pullRequest.target.repository, hosted.repository)
          )
            return yield* new RepositoryUnavailable()

          return details
        }),
        statistics: Effect.fn('RepositoryDirectory.statistics')(function* (hosted, expected) {
          const { repository } = yield* bind(hosted)

          if (!same(expected.target.repository, hosted.repository))
            return yield* new RepositoryUnavailable()

          if (repository.getPullRequestStatistics) {
            const value = yield* repository.getPullRequestStatistics(expected)
            const comparison = value.comparison

            if (
              comparison.providerId !== hosted.provider.id ||
              comparison.authority !== hosted.repository.authority ||
              comparison.pullRequestId !== expected.id ||
              !same(comparison.targetRepository, hosted.repository)
            )
              return yield* new RepositoryUnavailable()

            if (
              expected.source._tag !== 'Available' ||
              !same(comparison.sourceRepository, expected.source.repository) ||
              !Option.contains(expected.source.ref.revision, comparison.sourceRevision) ||
              !Option.contains(expected.target.ref.revision, comparison.targetRevision)
            )
              return yield* new ComparisonChanged()

            return value
          }

          return yield* new RepositoryUnavailable()
        }),
        avatar: Effect.fn('RepositoryDirectory.avatar')(function* (hosted, key) {
          const { repository } = yield* bind(hosted)

          return yield* repository.getAvatar(key)
        }),
        connect: Effect.fn('RepositoryDirectory.connect')(function* (hosted) {
          const { repository } = yield* bind(hosted)
          const authentication = yield* repository.connectAuthentication()

          if (authentication._tag !== 'Authenticated') return yield* new AuthenticationRequired()
        }),
        resolve: Effect.fn('RepositoryDirectory.resolve')(function* (hosted, id) {
          const { provider, repository } = yield* bind(hosted)
          const pullRequest = yield* repository.getPullRequest(id)

          if (pullRequest.id !== id || !same(pullRequest.target.repository, hosted.repository))
            return yield* new ReviewError({
              operation: 'resolve PR',
              message: 'Provider details do not match the selected PR.',
            })

          if (pullRequest.source._tag === 'Unavailable')
            return yield* new ReviewError({
              operation: 'resolve PR',
              message: 'The PR source repository is unavailable.',
            })

          const revision = Effect.fn('RepositoryDirectory.revision')(function* (
            identity: RepositoryIdentity,
            ref: typeof pullRequest.target.ref,
            side: 'source' | 'target',
          ) {
            const destination = provider.destination?.(identity)

            if (Option.isNone(ref.revision) || !destination || Option.isNone(destination))
              return yield* new ReviewError({
                operation: 'resolve PR',
                message:
                  'An exact commit or safe repository destination is unavailable. Duff never substitutes HEAD or a merge commit.',
              })

            return ReviewRevision.make({
              commit: ref.revision.value.toLowerCase(),
              ref: ref.name,
              remote: Option.some({ name: `duff-${side}`, destination: destination.value }),
            })
          })

          const source = yield* revision(
            pullRequest.source.repository,
            pullRequest.source.ref,
            'source',
          )

          const target = yield* revision(
            pullRequest.target.repository,
            pullRequest.target.ref,
            'target',
          )

          return ResolvedPullRequest.make({
            pullRequest,
            revisions: ReviewRevisions.make({ source, target }),
          })
        }),
      })
    }),
  )
