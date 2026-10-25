import { WatchedRepository } from '@duff/core/dashboard-repositories'
import { Option } from 'effect'
import { expect, it } from 'vitest'

import { DashboardState } from './DashboardState'

const repository = (id: string, localPaths: ReadonlyArray<string> = []) =>
  WatchedRepository.make({ id, name: id, hosting: Option.none(), localPaths })

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
