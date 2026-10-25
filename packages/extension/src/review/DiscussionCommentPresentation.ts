import { type DiscussionComment } from '@duff/core/discussion'

export function discussionCommentLabel(
  publication: DiscussionComment['publication'],
  complete: boolean,
): string | undefined {
  if (publication === 'pending')
    return complete
      ? 'Pending review, not published'
      : 'Pending review, not published · Partial thread'

  return complete ? undefined : 'Partial thread'
}
