import { Match, Schema, Struct } from 'effect'

import { PullRequestState } from '../pull-requests/GitHostingProvider'

const Width = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 160, maximum: 4000 }),
)

export const DashboardColumnWidths = Schema.Struct({
  navigation: Schema.optionalKey(Width),
  details: Schema.optionalKey(Width),
})

export const DashboardPreferences = Schema.Struct({
  repositoryOrder: Schema.Array(Schema.NonEmptyString),
  repositoryId: Schema.String,
  pullRequestId: Schema.String,
  filter: PullRequestState,
  query: Schema.String.check(Schema.isMaxLength(1000)),
  columnWidths: DashboardColumnWidths,
})

export interface DashboardPreferences extends Schema.Schema.Type<typeof DashboardPreferences> {}

export const defaultDashboardPreferences = DashboardPreferences.make({
  repositoryOrder: [],
  repositoryId: '',
  pullRequestId: '',
  filter: 'open',
  query: '',
  columnWidths: {},
})

export const DashboardPreferenceChange = Schema.Union([
  Schema.TaggedStruct('FocusRepository', { repositoryId: Schema.NonEmptyString }),
  Schema.TaggedStruct('FocusPullRequest', {
    repositoryId: Schema.NonEmptyString,
    filter: PullRequestState,
    pullRequestId: Schema.String,
  }),
  Schema.TaggedStruct('SetFilter', {
    repositoryId: Schema.NonEmptyString,
    filter: PullRequestState,
  }),
  Schema.TaggedStruct('SetQuery', {
    repositoryId: Schema.NonEmptyString,
    query: DashboardPreferences.fields.query,
  }),
  Schema.TaggedStruct('ResizeColumns', { columnWidths: DashboardColumnWidths }),
  Schema.TaggedStruct('MoveRepository', {
    repositoryId: Schema.NonEmptyString,
    targetId: Schema.NonEmptyString,
    placement: Schema.Literals(['before', 'after']),
  }),
])

export type DashboardPreferenceChange = Schema.Schema.Type<typeof DashboardPreferenceChange>

export function reconcileDashboardPreferences(
  preferences: DashboardPreferences,
  ids: ReadonlyArray<string>,
): DashboardPreferences {
  const repositoryOrder = [
    ...new Set([...preferences.repositoryOrder.filter((id) => ids.includes(id)), ...ids]),
  ]

  const repositoryId = repositoryOrder.includes(preferences.repositoryId)
    ? preferences.repositoryId
    : (repositoryOrder[0] ?? '')

  const changed = repositoryId !== preferences.repositoryId

  return DashboardPreferences.make({
    repositoryOrder,
    repositoryId,
    pullRequestId: changed ? '' : preferences.pullRequestId,
    filter: preferences.filter,
    query: changed ? '' : preferences.query,
    columnWidths: preferences.columnWidths,
  })
}

export function changeDashboardPreferences(
  preferences: DashboardPreferences,
  change: DashboardPreferenceChange,
): DashboardPreferences {
  return Match.value(change).pipe(
    Match.tag('FocusRepository', ({ repositoryId }) => {
      if (
        !preferences.repositoryOrder.includes(repositoryId) ||
        repositoryId === preferences.repositoryId
      )
        return preferences

      return DashboardPreferences.make(
        Struct.assign(preferences, {
          repositoryId,
          pullRequestId: '',
          query: '',
        }),
      )
    }),
    Match.tag('FocusPullRequest', ({ repositoryId, filter, pullRequestId }) =>
      repositoryId === preferences.repositoryId && filter === preferences.filter
        ? DashboardPreferences.make(Struct.assign(preferences, { pullRequestId }))
        : preferences,
    ),
    Match.tag('SetFilter', ({ repositoryId, filter }) =>
      repositoryId === preferences.repositoryId && filter !== preferences.filter
        ? DashboardPreferences.make(
            Struct.assign(preferences, { filter, pullRequestId: '', query: '' }),
          )
        : preferences,
    ),
    Match.tag('SetQuery', ({ repositoryId, query }) =>
      repositoryId === preferences.repositoryId
        ? DashboardPreferences.make(Struct.assign(preferences, { query }))
        : preferences,
    ),
    Match.tag('ResizeColumns', ({ columnWidths }) =>
      DashboardPreferences.make(Struct.assign(preferences, { columnWidths })),
    ),
    Match.tag('MoveRepository', ({ repositoryId, targetId, placement }) => {
      if (
        repositoryId === targetId ||
        !preferences.repositoryOrder.includes(repositoryId) ||
        !preferences.repositoryOrder.includes(targetId)
      )
        return preferences
      const repositoryOrder = preferences.repositoryOrder.filter((id) => id !== repositoryId)
      repositoryOrder.splice(
        repositoryOrder.indexOf(targetId) + (placement === 'after' ? 1 : 0),
        0,
        repositoryId,
      )

      return DashboardPreferences.make(Struct.assign(preferences, { repositoryOrder }))
    }),
    Match.exhaustive,
  )
}
