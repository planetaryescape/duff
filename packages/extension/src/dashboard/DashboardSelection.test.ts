import { HostedRepository } from '@duff/core/dashboard-repositories'
import { PullRequestDetails } from '@duff/core/git-hosting-provider'
import { Option } from 'effect'
import { expect, it } from 'vitest'

import { DashboardSelection } from './DashboardSelection'
import { DashboardState } from './DashboardState'
import { type DashboardChangeSummary } from './DashboardState'
import { comparison } from './DashboardTestData'

const hosted = HostedRepository.make({
  provider: { id: 'fixture', displayName: 'Fixture', authenticationSource: 'editor' },
  repository: { authority: 'example.test', key: 'repo', displayName: 'repo' },
  cloneUrl: 'https://example.test/repo.git',
})

const metadata = (revision: string) =>
  PullRequestDetails.make({
    pullRequest: {
      id: '1',
      title: 'PR',
      url: 'https://example.test/pr/1',
      draft: false,
      source: {
        _tag: 'Available',
        repository: hosted.repository,
        ref: { name: 'refs/heads/feature', revision: Option.some('a'.repeat(40)) },
      },
      target: {
        repository: hosted.repository,
        ref: { name: 'refs/heads/main', revision: Option.some(revision.repeat(40)) },
      },
    },
    description: 'Readable before statistics',
    filesChanged: Option.none(),
    linesChanged: Option.none(),
  })

function gate<A>() {
  let complete: (value: A) => void = () => {
    throw new Error('Gate not initialized')
  }

  const value = new Promise<A>((resolve) => {
    complete = resolve
  })

  return { value, complete }
}

it('publishes metadata before statistics, shares duplicate selection work, and clears old totals when revisions move', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  let revision = 'a'

  const statistics = gate<DashboardChangeSummary>()

  const metadataRendered = gate<void>()
  const requests: string[] = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => undefined,
      cachedStatistics: async () => undefined,
      metadata: async () => {
        requests.push('metadata')

        return metadata(revision)
      },
      statistics: async () => {
        requests.push('statistics')

        return statistics.value
      },
    },
    async () => {
      if (state.details._tag === 'Current' && state.statistics._tag === 'Loading')
        metadataRendered.complete()
    },
  )

  const first = controller.load(hosted, '1')
  expect(controller.load(hosted, '1')).toBe(first)
  await metadataRendered.value
  expect(state.details._tag).toBe('Current')
  expect(state.statistics._tag).toBe('Loading')
  statistics.complete({ comparison, files: 2, lines: { additions: 7, deletions: 3 }, reason: '' })
  await first
  expect(requests).toEqual(['metadata', 'statistics'])
  expect(state.statistics).toMatchObject({ _tag: 'Current', value: { files: 2 } })
  revision = 'b'
  const states: string[] = []

  const moved = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => undefined,
      cachedStatistics: async () => undefined,
      metadata: async () => metadata(revision),
      statistics: async () => undefined,
    },
    async () => {
      states.push(state.statistics._tag)
    },
  )

  await moved.load(hosted, '1', true)
  expect(states).toEqual(['Refreshing', 'Loading', 'Unavailable'])
})

it('cancels switching and disposal and rejects late publications with identical PR numbers across repositories', async () => {
  const state = new DashboardState()
  const first = gate<PullRequestDetails>()
  const started = gate<void>()
  const signals: AbortSignal[] = []
  const rendered: string[] = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => undefined,
      cachedStatistics: async () => undefined,
      metadata: async (_hosted, _id, { signal }) => {
        signals.push(signal)
        started.complete()

        return first.value
      },
      statistics: async () => ({
        comparison,
        files: 0,
        lines: { additions: 0, deletions: 0 },
        reason: '',
      }),
    },
    async () => {
      rendered.push(state.details._tag)
    },
  )

  state.repositoryId = 'first'
  const pending = controller.load(hosted, '1')
  await started.value
  state.repositoryId = 'second'
  controller.cancel()
  state.clearDetails()
  first.complete(metadata('a'))
  await pending
  expect(signals[0]?.aborted).toBe(true)
  expect(state.details._tag).toBe('Idle')
  expect(rendered).toEqual(['Loading'])
  const disposed = controller.load(hosted, '1')
  controller.dispose()
  await disposed
  expect(state.details._tag).toBe('Idle')
  await controller.load(hosted, '1')
  expect(signals).toHaveLength(1)
})

it('renders cached metadata before revalidation and keeps failed revalidation stale without requesting statistics', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  const revalidation = gate<PullRequestDetails | undefined>()
  const started = gate<void>()
  const states: string[] = []
  const requests: string[] = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => metadata('a'),
      cachedStatistics: async () => undefined,
      metadata: async () => {
        started.complete()

        return revalidation.value
      },
      statistics: async () => {
        requests.push('statistics')

        return undefined
      },
    },
    async () => {
      states.push(state.details._tag)
    },
  )

  const work = controller.load(hosted, '1')
  await started.value
  expect(state.details).toMatchObject({
    _tag: 'Refreshing',
    value: { descriptionHtml: '<p>Readable before statistics</p>\n' },
  })
  revalidation.complete(undefined)
  await work
  expect(states).toEqual(['Loading', 'Refreshing', 'Stale'])
  expect(requests).toEqual([])
})

it('retains matching totals on a failed statistics refresh and forwards explicit retry intent', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  const summary = { comparison, files: 2, lines: { additions: 7, deletions: 3 }, reason: '' }
  const version = state.beginDetails('1')
  state.finishMetadata(version, metadata('a'))
  state.finishStatistics(version, summary)
  const options: boolean[] = []
  const states: string[] = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => metadata('a'),
      cachedStatistics: async () => undefined,
      metadata: async (_hosted, _id, input) => {
        options.push(input.force)

        return metadata('a')
      },
      statistics: async (_hosted, _expected, input) => {
        options.push(input.force)

        return undefined
      },
    },
    async () => {
      states.push(state.statistics._tag)
    },
  )

  await controller.load(hosted, '1', true)
  expect(options).toEqual([true, true])
  expect(states).toEqual(['Refreshing', 'Refreshing', 'Refreshing', 'Stale'])
  expect(state.statistics).toEqual({
    _tag: 'Stale',
    value: summary,
    reason: 'Could not refresh change statistics.',
  })
})

it('revalidates metadata after comparison movement and bounds repeated movement without publishing mismatched totals', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  const requests: Array<string | boolean> = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => undefined,
      cachedStatistics: async () => undefined,
      metadata: async (_hosted, _id, options) => {
        requests.push(options.force)

        return metadata('a')
      },
      statistics: async () => {
        requests.push('statistics')

        return {
          comparison: { ...comparison, targetRevision: 'f'.repeat(40) },
          files: 99,
          lines: { additions: 999, deletions: 999 },
          reason: '',
        }
      },
    },
    async () => {},
  )

  await controller.load(hosted, '1')
  expect(requests).toEqual([false, 'statistics', true, 'statistics'])
  expect(state.statistics).toMatchObject({
    _tag: 'Unavailable',
    reason: 'The comparison changed while loading. Retry to load the latest revisions.',
  })
  expect(state.details._tag).toBe('Current')
})

it('interrupts statistics on disposal and ignores a late result even when the adapter completes after cancellation', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  const statistics = gate<DashboardChangeSummary>()
  const started = gate<AbortSignal>()

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => undefined,
      cachedStatistics: async () => undefined,
      metadata: async () => metadata('a'),
      statistics: async (_hosted, _expected, options) => {
        started.complete(options.signal)

        return statistics.value
      },
    },
    async () => {},
  )

  const work = controller.load(hosted, '1')
  const signal = await started.value
  controller.dispose()
  expect(signal.aborted).toBe(true)
  statistics.complete({
    comparison,
    files: 99,
    lines: { additions: 999, deletions: 999 },
    reason: '',
  })
  await work
  expect(state.details._tag).toBe('Idle')
  expect(state.statistics._tag).toBe('Idle')
})

it('paints cached matching totals before slow metadata revalidation and clears them when metadata proves a new comparison', async () => {
  const state = new DashboardState()
  state.repositoryId = 'repo'
  const pending = gate<PullRequestDetails>()
  const started = gate<void>()
  const summary = { comparison, files: 3, lines: { additions: 10, deletions: 2 }, reason: '' }
  const states: string[] = []

  const controller = new DashboardSelection(
    state,
    {
      cachedMetadata: async () => metadata('a'),
      cachedStatistics: async () => summary,
      metadata: async () => {
        started.complete()

        return pending.value
      },
      statistics: async () => undefined,
    },
    async () => {
      states.push(state.statistics._tag)
    },
  )

  const work = controller.load(hosted, '1')
  await started.value
  expect(state.statistics).toEqual({ _tag: 'Refreshing', value: summary })
  pending.complete(metadata('b'))
  await work
  expect(states).toEqual(['Loading', 'Refreshing', 'Loading', 'Unavailable'])
})
