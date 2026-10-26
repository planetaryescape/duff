import { WatchedRepository } from '@duff/core/dashboard-repositories'
import { PullRequestDetails } from '@duff/core/git-hosting-provider'
import { Option } from 'effect'
import { expect, it } from 'vitest'

import { DashboardState } from './DashboardState'
import { comparison } from './DashboardTestData'

const summary = {
  comparison,
  files: 0,
  lines: undefined,
  reason: 'Line totals unavailable for this comparison.',
}

const repository = (id: string, localPaths: ReadonlyArray<string> = []) =>
  WatchedRepository.make({ id, name: id, hosting: Option.none(), localPaths })

const details = (id: string) =>
  PullRequestDetails.make({
    pullRequest: {
      id,
      title: id,
      url: 'https://example.test/pull/1',
      draft: false,
      source: { _tag: 'Unavailable' },
      target: {
        repository: { authority: 'example.test', key: 'repo', displayName: 'Repo' },
        ref: { name: 'refs/heads/main', revision: Option.none() },
      },
    },
    description: 'Selected PR description',
    filesChanged: Option.some(0),
    linesChanged: Option.none(),
  })

it('keeps an empty catalog refresh from cancelling onboarding', () => {
  const state = new DashboardState()
  state.mode = 'picker'
  state.busy = true
  state.message = 'Inspecting selected folders…'

  expect(state.updateRepositories([])).toBe(false)
  expect(state.repositoryId).toBe('')
  expect(state.busy).toBe(true)
  expect(state.message).toBe('Inspecting selected folders…')
})

it('retains the selected repository on refresh and replaces it when removed', () => {
  const state = new DashboardState()
  const first = repository('first')
  const second = repository('second')
  state.updateRepositories([first, second])
  state.repositoryId = second.id
  state.pullRequestId = 'selected-pr'

  expect(state.updateRepositories([first, second])).toBe(false)
  expect(state.repositoryId).toBe(second.id)
  expect(state.pullRequestId).toBe('selected-pr')

  expect(state.updateRepositories([first])).toBe(true)
  expect(state.repositoryId).toBe(first.id)
  expect(state.pullRequestId).toBe('')
  expect(state.pulls).toEqual([])

  expect(state.updateRepositories([])).toBe(true)
  expect(state.repositoryId).toBe('')
  expect(state.updateRepositories([])).toBe(false)
})

it('selects chosen local repositories once, preserving remote choices and excluding watched paths', () => {
  const state = new DashboardState()
  const watched = repository('watched', ['/repos/watched'])
  const linked = repository('linked', ['/repos/old'])
  const updatedLink = repository('linked', ['/repos/old', '/repos/new'])
  const first = repository('first', ['/repos/first'])
  const second = repository('second', ['/repos/second'])
  state.updateRepositories([watched, linked])
  state.mode = 'picker'
  state.checked = ['remote-choice']

  state.selectRepositories([first, second, watched, updatedLink, first])

  expect(state.checked).toEqual(['remote-choice', first.id, second.id, linked.id])
  expect(state.repositories).toEqual([watched, linked])
  expect(state.mode).toBe('picker')

  state.checked = state.checked.filter((id) => id !== first.id)
  state.selectRepositories([second])
  expect(state.checked).toEqual(['remote-choice', second.id, linked.id])
})

it('keeps late PR details from replacing a newer selection or repository', () => {
  const state = new DashboardState()
  const first = state.beginDetails('first')
  const second = state.beginDetails('second')

  expect(state.details).toEqual({ _tag: 'Loading' })
  expect(state.finishDetails(first, details('first'), summary)).toBe(false)
  expect(state.finishDetails(second, details('second'), summary)).toBe(true)
  expect(state.details).toEqual({
    _tag: 'Current',
    value: { metadata: details('second'), descriptionHtml: '<p>Selected PR description</p>\n' },
  })

  const pending = state.beginDetails('first')
  state.updateRepositories([repository('another')])

  expect(state.finishDetails(pending, details('first'), summary)).toBe(false)
  expect(state.details).toEqual({ _tag: 'Idle' })
})

it('exposes detail failures and replaces them when retry succeeds', () => {
  const state = new DashboardState()
  const first = state.beginDetails('first')
  state.finishDetails(first, undefined, undefined)

  expect(state.details).toEqual({ _tag: 'Unavailable', reason: 'Could not load PR details.' })

  const retry = state.beginDetails('first')
  state.finishDetails(retry, details('first'), summary)

  expect(state.details).toEqual({
    _tag: 'Current',
    value: { metadata: details('first'), descriptionHtml: '<p>Selected PR description</p>\n' },
  })
})

it('retains descriptions and statistics during refresh and marks a failed refresh stale', () => {
  const state = new DashboardState()
  state.finishDetails(state.beginDetails('first'), details('first'), summary)
  const previous = state.details
  const statistics = state.statistics
  const retry = state.beginDetails('first')
  expect(state.details).toEqual({ ...previous, _tag: 'Refreshing' })
  expect(state.statistics).toEqual({ ...statistics, _tag: 'Refreshing' })
  state.finishDetails(retry, undefined, undefined)
  expect(state.details).toEqual({
    ...previous,
    _tag: 'Stale',
    reason: 'Could not load PR details.',
  })
  expect(state.statistics).toEqual({
    ...statistics,
    _tag: 'Stale',
    reason: 'Could not refresh change statistics.',
  })
  state.beginDetails('second')
  expect(state.details).toEqual({ _tag: 'Loading' })
  expect(state.statistics).toEqual({ _tag: 'Loading' })
})
