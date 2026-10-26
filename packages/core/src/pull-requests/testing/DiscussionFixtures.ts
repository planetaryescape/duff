import { DiscussionReview, CodeAnchor } from '../Discussion'

export const discussionFixture = (
  provider: 'github' | 'azure-devops' = 'github',
): DiscussionReview => {
  const repository = {
    authority: provider === 'github' ? 'github.com' : 'dev.azure.com',
    key: provider === 'github' ? 'owner/repo' : 'org/project/repo',
    displayName: 'Fixture',
  }

  const comparison = {
    providerId: provider,
    authority: repository.authority,
    targetRepository: repository,
    sourceRepository: repository,
    pullRequestId: '42',
    sourceRevision: 'a'.repeat(40),
    targetRevision: 'b'.repeat(40),
    baseRevision: 'c'.repeat(40),
    mode: 'merge-base-v1',
  } satisfies DiscussionReview['comparison']

  return DiscussionReview.make({
    key: { providerId: provider, repository, pullRequestId: '42' },
    selection: { provider, repository, id: '42', label: 'Fixture' },
    comparison,
    review: {
      root: '/fixture',
      baseBranch: 'main',
      headBranch: 'feature',
      baseCommit: comparison.baseRevision,
      headCommit: comparison.sourceRevision,
      files: [{ status: 'M', path: 'file.ts' }],
    },
  })
}

export const anchorFixture = (
  review: DiscussionReview,
  side: 'head' | 'base' = 'head',
): CodeAnchor =>
  CodeAnchor.make({
    comparison: review.comparison,
    change: { status: 'M', path: 'file.ts' },
    side,
    path: 'file.ts',
    commit: side === 'head' ? review.review.headCommit : review.review.baseCommit,
    range: { start: 1, end: 1 },
  })
