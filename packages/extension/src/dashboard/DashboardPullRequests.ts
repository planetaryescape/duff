import { DashboardData } from '@duff/core/dashboard-data'
import {
  hostedRepositoryId,
  RepositoryCatalog,
  type HostedRepository,
  type WatchedRepository,
} from '@duff/core/dashboard-repositories'
import { InvalidProviderResponse, type PullRequestState } from '@duff/core/git-hosting-provider'
import { RepositoryDirectory, RepositoryPullRequestPage } from '@duff/core/repository-directory'
import { Data, Effect, type Option, type Redacted } from 'effect'

type PageRequest =
  | { readonly _tag: 'First'; readonly preferredId: string; readonly force: boolean }
  | {
      readonly _tag: 'More'
      readonly cursor: Option.Option<Redacted.Redacted>
      readonly preferredId: string
    }

class LoadedPullRequests extends Data.Class<{
  readonly page: RepositoryPullRequestPage
  readonly watched: WatchedRepository
  readonly moved: boolean
  readonly revision: number
}> {}

export const dashboardPullRequestPage = Effect.fn('Dashboard.pullRequestPage')(function* (
  repository: WatchedRepository,
  hosted: HostedRepository,
  filter: PullRequestState,
  request: PageRequest,
  cancelSelection: () => void,
) {
  const listing =
    request._tag === 'First'
      ? yield* DashboardData.use((data) => data.listVersioned(hosted, filter, request.force))
      : undefined

  let page =
    listing?.page ??
    (request._tag === 'More'
      ? yield* RepositoryDirectory.use((directory) =>
          directory.list(hosted, filter, request.cursor),
        )
      : yield* new InvalidProviderResponse())

  if (page.items.length > 50) return yield* new InvalidProviderResponse()

  const moved = hostedRepositoryId(page.hosting) !== hostedRepositoryId(hosted)
  let revision = listing?.revision ?? 0

  if (moved) {
    yield* Effect.sync(cancelSelection)
    yield* DashboardData.use((data) => data.invalidate(hosted))
    const canonical = yield* DashboardData.use((data) => data.listVersioned(page.hosting, filter))
    page = canonical.page
    revision = canonical.revision
  }

  if (
    (request._tag === 'First' || moved) &&
    request.preferredId &&
    !page.items.some((pull) => pull.id === request.preferredId)
  ) {
    const selected = yield* DashboardData.use((data) =>
      data.metadata(page.hosting, request.preferredId, request._tag === 'First' && request.force),
    ).pipe(Effect.result)

    if (selected._tag === 'Success' && (selected.success.pullRequest.state ?? 'open') === filter)
      page = RepositoryPullRequestPage.make({
        items: [selected.success.pullRequest, ...page.items],
        next: page.next,
        hosting: page.hosting,
      })
  }

  const watched = moved
    ? yield* RepositoryCatalog.use((catalog) => catalog.relocate(repository.id, page.hosting))
    : repository

  return new LoadedPullRequests({ page, watched, moved, revision })
})
