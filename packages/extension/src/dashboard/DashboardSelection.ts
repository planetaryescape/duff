import { type HostedRepository } from '@duff/core/dashboard-repositories'
import { type OpenPullRequest, type PullRequestDetails } from '@duff/core/git-hosting-provider'
import { Option } from 'effect'

import { type DashboardChangeSummary, type DashboardState } from './DashboardState'

interface SelectionOptions {
  readonly force: boolean
  readonly signal: AbortSignal
}

export type DashboardStatisticsResult = DashboardChangeSummary | 'ComparisonChanged' | undefined

export interface DashboardSelectionData {
  readonly cachedStatistics: (
    hosted: HostedRepository,
    expected: OpenPullRequest,
    options: SelectionOptions,
  ) => Promise<DashboardChangeSummary | undefined>
  readonly cachedMetadata: (
    hosted: HostedRepository,
    id: string,
    options: SelectionOptions,
  ) => Promise<PullRequestDetails | undefined>
  readonly metadata: (
    hosted: HostedRepository,
    id: string,
    options: SelectionOptions,
  ) => Promise<PullRequestDetails | undefined>
  readonly statistics: (
    hosted: HostedRepository,
    expected: OpenPullRequest,
    options: SelectionOptions,
  ) => Promise<DashboardStatisticsResult>
}

export const DashboardSelectionData = {
  of: (value: DashboardSelectionData): DashboardSelectionData => value,
}

function matchesSelection(
  hosted: HostedRepository,
  expected: OpenPullRequest,
  value: DashboardChangeSummary,
): boolean {
  const comparison = value.comparison

  return (
    comparison.providerId === hosted.provider.id &&
    comparison.authority === hosted.repository.authority &&
    comparison.pullRequestId === expected.id &&
    comparison.targetRepository.authority === expected.target.repository.authority &&
    comparison.targetRepository.key === expected.target.repository.key &&
    Option.contains(expected.target.ref.revision, comparison.targetRevision) &&
    expected.source._tag === 'Available' &&
    comparison.sourceRepository.authority === expected.source.repository.authority &&
    comparison.sourceRepository.key === expected.source.repository.key &&
    Option.contains(expected.source.ref.revision, comparison.sourceRevision)
  )
}

export class DashboardSelection {
  #controller = new AbortController()
  #pending: { readonly key: string; readonly work: Promise<void> } | undefined
  #generation = 0
  #closed = false

  constructor(
    readonly state: DashboardState,
    readonly data: DashboardSelectionData,
    readonly render: () => Promise<void>,
  ) {}

  load(hosted: HostedRepository, id: string, force = false): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const key = JSON.stringify([this.state.repositoryId, hosted.provider.id, hosted.repository, id])

    if (this.#pending?.key === key) return this.#pending.work
    this.cancel()
    const generation = this.#generation
    const repositoryId = this.state.repositoryId
    const controller = this.#controller
    let version = this.state.beginDetails(id)

    const current = () =>
      !controller.signal.aborted &&
      generation === this.#generation &&
      repositoryId === this.state.repositoryId &&
      id === this.state.pullRequestId

    const pass = async (retry: boolean): Promise<void> => {
      if (!current()) return

      const metadata = await this.data.metadata(hosted, id, {
        force: force || retry,
        signal: controller.signal,
      })

      if (!current()) return

      if (!this.state.finishMetadata(version, metadata)) return
      await this.render()

      if (!metadata || !current()) return

      const statistics = await this.data.statistics(hosted, metadata.pullRequest, {
        force,
        signal: controller.signal,
      })

      if (!current()) return

      if (
        statistics !== 'ComparisonChanged' &&
        (!statistics || matchesSelection(hosted, metadata.pullRequest, statistics))
      ) {
        if (this.state.finishStatistics(version, statistics)) await this.render()

        return
      }

      if (retry) {
        this.state.statistics = {
          _tag: 'Unavailable',
          reason: 'The comparison changed while loading. Retry to load the latest revisions.',
        }
        await this.render()

        return
      }

      this.state.statistics = { _tag: 'Loading' }
      version = this.state.beginDetails(id)
      await this.render()

      return pass(true)
    }

    const work = (async () => {
      await this.render()

      if (!current()) return

      const cached = await this.data.cachedMetadata(hosted, id, {
        force,
        signal: controller.signal,
      })

      if (!current()) return

      if (cached && this.state.finishMetadata(version, cached)) {
        const statistics = await this.data.cachedStatistics(hosted, cached.pullRequest, {
          force,
          signal: controller.signal,
        })

        if (!current()) return

        if (statistics && matchesSelection(hosted, cached.pullRequest, statistics))
          this.state.finishStatistics(version, statistics)
        version = this.state.beginDetails(id)
        await this.render()
      }

      await pass(false)
    })().finally(() => {
      if (this.#pending?.work === work) this.#pending = undefined
    })

    this.#pending = { key, work }

    return work
  }

  cancel(): void {
    this.#generation++
    this.#controller.abort()
    this.#controller = new AbortController()
    this.#pending = undefined
  }

  dispose(): void {
    this.cancel()
    this.#closed = true
    this.state.clearDetails()
  }
}
