import { type WatchedRepository } from '@duff/core/dashboard-repositories'
import {
  type OpenPullRequest,
  type ProviderIdentity,
  type PullRequestState,
} from '@duff/core/git-hosting-provider'
import { type RepositorySource } from '@duff/core/repository-directory'

export class DashboardState {
  mode: 'dashboard' | 'picker' = 'dashboard'
  repositories: ReadonlyArray<WatchedRepository> = []
  repositoryId = ''
  pullRequestId = ''
  pulls: ReadonlyArray<OpenPullRequest> = []
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
