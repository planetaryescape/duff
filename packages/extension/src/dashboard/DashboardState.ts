import {
  type DashboardPreferences,
  defaultDashboardPreferences,
} from '@duff/core/dashboard-preferences'
import { type WatchedRepository } from '@duff/core/dashboard-repositories'
import {
  type OpenPullRequest,
  type ComparisonIdentity,
  type ProviderIdentity,
  type PullRequestDetails,
  type PullRequestState,
} from '@duff/core/git-hosting-provider'
import { type RepositorySource } from '@duff/core/repository-directory'

import { type DashboardResource, failed, refreshing, retainedValue } from './DashboardResource'
import { descriptionMarkdown } from './DescriptionMarkdown'

interface DetailValue {
  readonly metadata: PullRequestDetails
  readonly descriptionHtml: string
}

export interface DashboardChangeSummary {
  readonly comparison: ComparisonIdentity
  readonly files: number | undefined
  readonly lines: { readonly additions: number; readonly deletions: number } | undefined
  readonly reason: string
}

export const DashboardChangeSummary = {
  of: (value: DashboardChangeSummary): DashboardChangeSummary => value,
}

export class DashboardState {
  mode: 'dashboard' | 'picker' = 'dashboard'
  repositories: ReadonlyArray<WatchedRepository> = []
  repositoryId = ''
  pullRequestId = ''
  pulls: ReadonlyArray<OpenPullRequest> = []
  details: DashboardResource<DetailValue> = { _tag: 'Idle' }
  statistics: DashboardResource<DashboardChangeSummary> = { _tag: 'Idle' }
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
  query = ''
  columnWidths = defaultDashboardPreferences.columnWidths
  labels: Readonly<Record<string, string>> = {}
  message = ''
  error = false
  busy = false
  more = false

  restore(preferences: DashboardPreferences): void {
    this.repositoryId = preferences.repositoryId
    this.pullRequestId = preferences.pullRequestId
    this.filter = preferences.filter
    this.query = preferences.query
    this.columnWidths = preferences.columnWidths
    this.labels = preferences.repositoryLabels ?? {}
  }

  updateRepositories(repositories: ReadonlyArray<WatchedRepository>): boolean {
    this.repositories = repositories
    const selected = repositories.find((item) => item.id === this.repositoryId)
    const repositoryId = selected?.id ?? repositories[0]?.id ?? ''

    if (repositoryId === this.repositoryId) return false
    this.repositoryId = repositoryId
    this.pulls = []
    this.pullRequestId = ''
    this.query = ''
    this.clearDetails()
    this.avatars = {}

    return true
  }

  clearDetails(): void {
    this.#detailVersion++
    this.details = { _tag: 'Idle' }
    this.statistics = { _tag: 'Idle' }
  }

  beginDetails(id: string): number {
    this.#detailVersion++
    const retain = retainedValue(this.details)?.metadata.pullRequest.id === id
    this.pullRequestId = id
    this.details = refreshing(retain ? this.details : { _tag: 'Idle' })
    this.statistics = refreshing(retain ? this.statistics : { _tag: 'Idle' })

    return this.#detailVersion
  }

  finishDetails(
    version: number,
    value: PullRequestDetails | undefined,
    statistics: DashboardChangeSummary | undefined,
  ): boolean {
    if (!this.finishMetadata(version, value)) return false

    if (value) this.finishStatistics(version, statistics)

    return true
  }

  finishMetadata(version: number, value: PullRequestDetails | undefined): boolean {
    if (version !== this.#detailVersion) return false

    if (value && value.pullRequest.id === this.pullRequestId) {
      const previous = retainedValue(this.details)?.metadata.pullRequest

      if (
        !previous ||
        JSON.stringify([previous.source, previous.target]) !==
          JSON.stringify([value.pullRequest.source, value.pullRequest.target])
      )
        this.statistics = { _tag: 'Loading' }
      this.details = {
        _tag: 'Current',
        value: { metadata: value, descriptionHtml: descriptionMarkdown(value.description) },
      }
    } else {
      this.details = failed(this.details, 'Could not load PR details.')
      this.statistics = failed(this.statistics, 'Could not refresh change statistics.')
    }

    return true
  }

  finishStatistics(version: number, value: DashboardChangeSummary | undefined): boolean {
    if (version !== this.#detailVersion) return false
    this.statistics = value
      ? { _tag: 'Current', value }
      : failed(this.statistics, 'Could not refresh change statistics.')

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
