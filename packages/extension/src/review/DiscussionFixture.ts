import { DiscussionReview } from '@duff/core/discussion'

export function discussionFixture(id = '22'): DiscussionReview {
  const repository = { authority: 'github.com', key: 'owner/repo', displayName: 'owner/repo' }
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)

  return DiscussionReview.make({
    key: { providerId: 'github', repository, pullRequestId: id },
    selection: { provider: 'github', repository, id, label: `PR #${id}` },
    comparison: {
      providerId: 'github',
      authority: 'github.com',
      targetRepository: repository,
      sourceRepository: repository,
      pullRequestId: id,
      targetRevision: base,
      sourceRevision: head,
      baseRevision: base,
      mode: 'merge-base-v1',
    },
    review: {
      root: '/fixture/repo',
      baseBranch: 'main',
      headBranch: 'feature',
      baseCommit: base,
      headCommit: head,
      files: [
        { status: 'M', path: 'src/main.ts' },
        { status: 'A', path: 'added.ts' },
        { status: 'D', path: 'deleted.ts' },
        { status: 'R', path: 'renamed.ts', previousPath: 'old.ts' },
      ],
    },
  })
}
