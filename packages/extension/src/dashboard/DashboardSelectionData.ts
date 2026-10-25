import { DashboardData } from '@duff/core/dashboard-data'
import { type ChangeStatistics } from '@duff/core/git-hosting-provider'
import { Effect, Option } from 'effect'

import { type CommandRuntime, runOperation } from '../Operations'
import { DashboardSelectionData } from './DashboardSelection'
import { DashboardChangeSummary } from './DashboardState'

const unavailableReasons: Readonly<
  Record<Extract<ChangeStatistics['lines'], { readonly _tag: 'Unavailable' }>['reason'], string>
> = {
  'unsupported-comparison': 'Line totals are not supported for this comparison.',
  'incomplete-response': 'Line totals unavailable because the comparison response was incomplete.',
  'binary-content': 'Line totals unavailable because the comparison includes binary content.',
  'work-limit-exceeded':
    'Line totals unavailable because the comparison exceeds the statistics work limit.',
}

function changeSummary(value: ChangeStatistics): DashboardChangeSummary {
  return DashboardChangeSummary.of({
    comparison: value.comparison,
    files: Option.getOrUndefined(value.filesChanged),
    lines:
      value.lines._tag === 'Complete'
        ? { additions: value.lines.additions, deletions: value.lines.deletions }
        : undefined,
    reason: value.lines._tag === 'Unavailable' ? unavailableReasons[value.lines.reason] : '',
  })
}

export function dashboardSelectionData(runtime: CommandRuntime): DashboardSelectionData {
  return DashboardSelectionData.of({
    cachedStatistics: async (hosted, expected, options) => {
      const cached = await runOperation(
        runtime,
        'Duff.dashboard',
        DashboardData.use((data) => data.peekStatistics(hosted, expected)),
        undefined,
        options.signal,
      )

      return cached ? Option.getOrUndefined(Option.map(cached, changeSummary)) : undefined
    },
    cachedMetadata: async (hosted, id, options) => {
      const cached = await runOperation(
        runtime,
        'Duff.dashboard',
        DashboardData.use((data) => data.peekMetadata(hosted, id)),
        undefined,
        options.signal,
      )

      return cached ? Option.getOrUndefined(cached) : undefined
    },
    metadata: (hosted, id, options) =>
      runOperation(
        runtime,
        'Duff.dashboard',
        DashboardData.use((data) => data.metadata(hosted, id, options.force)),
        undefined,
        options.signal,
      ),
    statistics: (hosted, expected, options) =>
      runOperation(
        runtime,
        'Duff.dashboard',
        DashboardData.use((data) => data.statistics(hosted, expected, options.force)).pipe(
          Effect.map(changeSummary),
          Effect.catchTag('ComparisonChanged', () =>
            Effect.succeed<'ComparisonChanged'>('ComparisonChanged'),
          ),
        ),
        undefined,
        options.signal,
      ),
  })
}
