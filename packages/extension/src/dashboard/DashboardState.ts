import { type WatchedRepository } from '@duff/core/dashboard-repositories'
import {
  type OpenPullRequest,
  type ProviderIdentity,
  type PullRequestDetails,
  type PullRequestState,
} from '@duff/core/git-hosting-provider'
import { type RepositorySource } from '@duff/core/repository-directory'

type DetailState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Loaded'; readonly value: PullRequestDetails }
  | { readonly _tag: 'Failed' }

export class DashboardState {
  mode: 'dashboard' | 'picker' = 'dashboard'
  repositories: ReadonlyArray<WatchedRepository> = []
  repositoryId = ''
  pullRequestId = ''
  pulls: ReadonlyArray<OpenPullRequest> = []
  details: DetailState = { _tag: 'Idle' }
  avatars: Readonly<Record<string, string>> = {}
  #detailVersion = 0
  candidates: ReadonlyArray<WatchedRepository> = []
  selections: ReadonlyArray<WatchedRepository> = []
  providers: ReadonlyArray<ProviderIdentity> = []
  sources: ReadonlyArray<RepositorySource> = []
  checked: ReadonlyArray<string> = []
  sourceId = 'local'
  sourceLabel = 'Local repositories'
  filter: PullRequestState = 'open'
  message = ''
  error = false
  busy = false
  more = false

  updateRepositories(repositories: ReadonlyArray<WatchedRepository>): boolean {
    this.repositories = repositories
    const selected = repositories.find((item) => item.id === this.repositoryId)
    const repositoryId = selected?.id ?? repositories[0]?.id ?? ''

    if (repositoryId === this.repositoryId) return false
    this.repositoryId = repositoryId
    this.pulls = []
    this.pullRequestId = ''
    this.clearDetails()
    this.avatars = {}

    return true
  }

  clearDetails(): void {
    this.#detailVersion++
    this.details = { _tag: 'Idle' }
  }

  beginDetails(id: string): number {
    this.#detailVersion++
    this.pullRequestId = id
    this.details = { _tag: 'Loading' }

    return this.#detailVersion
  }

  finishDetails(version: number, value: PullRequestDetails | undefined): boolean {
    if (version !== this.#detailVersion) return false
    this.details =
      value && value.pullRequest.id === this.pullRequestId
        ? { _tag: 'Loaded', value }
        : { _tag: 'Failed' }

    return true
  }

  selectRepositories(repositories: ReadonlyArray<WatchedRepository>): void {
    const checked = new Set(this.checked)

    for (const repository of repositories) {
      const watched = this.repositories.some(
        (item) =>
          item.id === repository.id &&
          repository.localPaths.every((path) => item.localPaths.includes(path)),
      )

      if (!watched) checked.add(repository.id)
    }

    this.checked = [...checked]
  }
}
