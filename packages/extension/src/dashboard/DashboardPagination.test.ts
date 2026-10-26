import { HostedRepository } from '@duff/core/dashboard-repositories'
import { OpenPullRequest, type PullRequestState } from '@duff/core/git-hosting-provider'
import { RepositoryPullRequestPage } from '@duff/core/repository-directory'
import { Option, Redacted } from 'effect'
import { expect, it } from 'vitest'

import { DashboardPagination } from './DashboardPagination'
import { DashboardState } from './DashboardState'

const hosted = HostedRepository.make({
  provider: { id: 'fixture', displayName: 'Fixture', authenticationSource: 'editor' },
  repository: { authority: 'example.test', key: 'repo', displayName: 'repo' },
  cloneUrl: 'https://example.test/repo.git',
})

const pull = (id: string, state: PullRequestState = 'open') =>
  OpenPullRequest.make({
    id,
    title: id,
    state,
    url: `https://example.test/pr/${id}`,
    draft: false,
    source: { _tag: 'Unavailable' },
    target: {
      repository: hosted.repository,
      ref: { name: 'refs/heads/main', revision: Option.none() },
    },
  })

const page = (ids: ReadonlyArray<string>, cursor?: string, filter: PullRequestState = 'open') =>
  RepositoryPullRequestPage.make({
    hosting: hosted,
    items: ids.map((id) => pull(id, filter)),
    next: cursor ? Option.some(Redacted.make(cursor)) : Option.none(),
  })

it('retains all pending rows and selection but replaces old membership and cursor on successful revalidation', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  pagination.apply(state, page(['first', 'closed-later'], 'second-page'), {
    _tag: 'First',
    revision: 1,
  })
  pagination.apply(state, page(['older-page'], 'old-next'), { _tag: 'More', revision: 1 })
  state.pullRequestId = 'closed-later'
  state.query = 'keep query'
  state.busy = true
  expect(state.pulls.map((item) => item.id)).toEqual(['first', 'closed-later', 'older-page'])
  expect(state.pullRequestId).toBe('closed-later')
  expect(state.more).toBe(true)
  pagination.apply(state, page(['new-current']), { _tag: 'First', revision: 2 })
  expect(state.pulls.map((item) => item.id)).toEqual(['new-current'])
  expect(state.pullRequestId).toBe('new-current')
  expect(state.query).toBe('keep query')
  expect(state.more).toBe(false)
  expect(Option.isNone(pagination.cursor)).toBe(true)
  expect(pagination.snapshot(state)?.pages).toBe(1)
})

it('does not preserve stale rows or a stale more cursor when the refreshed first page is empty', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  pagination.apply(state, page(['old'], 'old-next'), { _tag: 'First', revision: 1 })
  pagination.apply(state, page([]), { _tag: 'First', revision: 2 })
  expect(state.pulls).toEqual([])
  expect(state.pullRequestId).toBe('')
  expect(state.more).toBe(false)
  expect(Option.isNone(pagination.cursor)).toBe(true)
})

it('keeps extra pages, cursor, filter, query and selected PR on a fresh first-page cache hit and snapshot restoration', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  state.filter = 'closed'
  pagination.apply(state, page(['first'], 'page-two', 'closed'), { _tag: 'First', revision: 7 })
  pagination.apply(state, page(['selected'], 'page-three', 'closed'), { _tag: 'More', revision: 7 })
  state.query = 'selected query'
  state.pullRequestId = 'selected'
  const snapshot = pagination.snapshot(state)

  if (!snapshot) throw new Error('Missing navigation fixture')
  const restored = new DashboardPagination()
  const anotherState = new DashboardState()
  restored.restore(anotherState, snapshot)
  restored.apply(anotherState, page(['first'], 'page-two', 'closed'), {
    _tag: 'First',
    revision: 7,
  })
  expect(anotherState.pulls.map((item) => item.id)).toEqual(['first', 'selected'])
  expect(anotherState.pullRequestId).toBe('selected')
  expect(anotherState.filter).toBe('closed')
  expect(anotherState.query).toBe('selected query')
  expect(restored.snapshot(anotherState)?.pages).toBe(2)
  expect(Option.map(restored.cursor, Redacted.value)).toEqual(Option.some('page-three'))
})

it('preserves a metadata-validated off-page selection after refresh without retaining unrelated old rows', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  pagination.apply(state, page(['old', 'selected'], 'next'), { _tag: 'First', revision: 1 })
  state.pullRequestId = 'selected'
  pagination.apply(state, page(['selected', 'new'], 'new-next'), { _tag: 'First', revision: 2 })
  expect(state.pulls.map((item) => item.id)).toEqual(['selected', 'new'])
  expect(state.pullRequestId).toBe('selected')
  expect(Option.map(pagination.cursor, Redacted.value)).toEqual(Option.some('new-next'))
})

it('bounds loaded pagination at five pages and 250 items and deduplicates repeated PRs', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  const ids = (offset: number) => Array.from({ length: 50 }, (_, index) => String(offset + index))
  pagination.apply(state, page(ids(0), 'next'), { _tag: 'First', revision: 1 })

  for (const offset of [50, 100, 150, 200])
    pagination.apply(state, page(ids(offset), 'next'), { _tag: 'More', revision: 1 })
  expect(state.pulls).toHaveLength(250)
  expect(state.more).toBe(false)
  expect(pagination.snapshot(state)?.pages).toBe(5)
  pagination.clear()
  pagination.apply(state, page(['first'], 'next'), { _tag: 'First', revision: 2 })
  pagination.apply(state, page(['first', 'second'], 'last'), { _tag: 'More', revision: 2 })
  expect(state.pulls.map((item) => item.id)).toEqual(['first', 'second'])
})

it('rejects older first pages and late continuation pages from a superseded listing generation', () => {
  const state = new DashboardState()
  const pagination = new DashboardPagination()
  pagination.apply(state, page(['new'], 'new-next'), { _tag: 'First', revision: 2 })
  expect(pagination.apply(state, page(['late'], 'old-next'), { _tag: 'More', revision: 1 })).toBe(
    false,
  )
  expect(pagination.apply(state, page(['old'], 'old-next'), { _tag: 'First', revision: 1 })).toBe(
    false,
  )
  expect(state.pulls.map((item) => item.id)).toEqual(['new'])
  expect(Option.map(pagination.cursor, Redacted.value)).toEqual(Option.some('new-next'))
})
