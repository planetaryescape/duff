import { ComparisonIdentity } from '@duff/core/git-hosting-provider'

export const comparison = ComparisonIdentity.make({
  providerId: 'fixture',
  authority: 'example.test',
  targetRepository: { authority: 'example.test', key: 'repo', displayName: 'repo' },
  sourceRepository: { authority: 'example.test', key: 'repo', displayName: 'repo' },
  pullRequestId: '1',
  sourceRevision: 'a'.repeat(40),
  targetRevision: 'a'.repeat(40),
  baseRevision: 'c'.repeat(40),
  mode: 'merge-base-v1',
})
