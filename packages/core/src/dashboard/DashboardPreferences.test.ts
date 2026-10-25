import { expect, it } from '@effect/vitest'

import {
  changeDashboardPreferences,
  defaultDashboardPreferences,
  reconcileDashboardPreferences,
} from './DashboardPreferences'

it('moves repositories relative to the latest order without changing focus or losing entries', () => {
  const initial = reconcileDashboardPreferences(defaultDashboardPreferences, ['a', 'b', 'c'])

  const focused = changeDashboardPreferences(initial, {
    _tag: 'FocusRepository',
    repositoryId: 'b',
  })

  const moved = changeDashboardPreferences(focused, {
    _tag: 'MoveRepository',
    repositoryId: 'c',
    targetId: 'a',
    placement: 'before',
  })

  const last = changeDashboardPreferences(moved, {
    _tag: 'MoveRepository',
    repositoryId: 'a',
    targetId: 'b',
    placement: 'after',
  })

  expect(moved.repositoryOrder).toEqual(['c', 'a', 'b'])
  expect(last.repositoryOrder).toEqual(['c', 'b', 'a'])
  expect(last.repositoryId).toBe('b')
  expect(
    changeDashboardPreferences(last, {
      _tag: 'MoveRepository',
      repositoryId: 'missing',
      targetId: 'a',
      placement: 'before',
    }),
  ).toEqual(last)
  expect(
    changeDashboardPreferences(last, {
      _tag: 'MoveRepository',
      repositoryId: 'b',
      targetId: 'b',
      placement: 'after',
    }),
  ).toEqual(last)
  expect(reconcileDashboardPreferences(last, ['a', 'c', 'new']).repositoryOrder).toEqual([
    'c',
    'a',
    'new',
  ])
  expect(reconcileDashboardPreferences(last, ['a', 'c', 'new']).repositoryId).toBe('c')
})

it('keeps selection-dependent state scoped to the current repository and filter', () => {
  const initial = reconcileDashboardPreferences(defaultDashboardPreferences, ['a', 'b'])

  const filtered = changeDashboardPreferences(initial, {
    _tag: 'SetFilter',
    repositoryId: 'a',
    filter: 'merged',
  })

  const selected = changeDashboardPreferences(filtered, {
    _tag: 'FocusPullRequest',
    repositoryId: 'a',
    filter: 'merged',
    pullRequestId: '42',
  })

  const searched = changeDashboardPreferences(selected, {
    _tag: 'SetQuery',
    repositoryId: 'a',
    query: 'fix',
  })

  const next = changeDashboardPreferences(searched, { _tag: 'FocusRepository', repositoryId: 'b' })

  expect(next).toMatchObject({ repositoryId: 'b', pullRequestId: '', query: '', filter: 'merged' })
  expect(
    changeDashboardPreferences(next, {
      _tag: 'FocusPullRequest',
      repositoryId: 'a',
      filter: 'merged',
      pullRequestId: '42',
    }),
  ).toEqual(next)
  expect(
    changeDashboardPreferences(next, { _tag: 'SetQuery', repositoryId: 'a', query: 'stale' }),
  ).toEqual(next)
  expect(
    changeDashboardPreferences(next, {
      _tag: 'FocusPullRequest',
      repositoryId: 'b',
      filter: 'open',
      pullRequestId: '3',
    }),
  ).toEqual(next)
})

it('renames repositories, clears blank labels, and forgets labels of removed repositories', () => {
  const initial = reconcileDashboardPreferences(defaultDashboardPreferences, ['a', 'b'])

  const renamed = changeDashboardPreferences(initial, {
    _tag: 'RenameRepository',
    repositoryId: 'a',
    label: '  Abstract Rhythm  ',
  })

  expect(renamed.repositoryLabels).toEqual({ a: 'Abstract Rhythm' })
  expect(
    changeDashboardPreferences(renamed, {
      _tag: 'RenameRepository',
      repositoryId: 'missing',
      label: 'Ignored',
    }),
  ).toEqual(renamed)
  expect(
    changeDashboardPreferences(renamed, { _tag: 'RenameRepository', repositoryId: 'a', label: ' ' })
      .repositoryLabels,
  ).toBeUndefined()
  expect(reconcileDashboardPreferences(renamed, ['b']).repositoryLabels).toBeUndefined()
  expect(reconcileDashboardPreferences(renamed, ['a', 'b']).repositoryLabels).toEqual({
    a: 'Abstract Rhythm',
  })
})
