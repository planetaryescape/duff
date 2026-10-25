import {
  DiscussionCommandRejected,
  type DiscussionState,
  sameComparison,
  sameDiscussion,
} from '@duff/core/discussion'
import { type Draft } from '@duff/core/discussion-drafts'
import { validateCodeAnchor } from '@duff/core/discussion-placement'
import { Effect } from 'effect'

export const draftDiffAnchor = Effect.fn('DiscussionDraftNavigation.anchor')(function* (
  draft: Draft,
  state: DiscussionState,
) {
  if (draft.target._tag === 'NewThread')
    return yield* validateCodeAnchor(draft.origin, draft.target.anchor)

  if (
    state._tag !== 'Ready' ||
    !sameComparison(state.review.comparison, draft.origin.comparison) ||
    !sameDiscussion(state.review.key, draft.key)
  )
    return yield* new DiscussionCommandRejected({ reason: 'invalid-anchor' })
  const id = draft.target.thread.id

  const thread = state.snapshot.threads.find(
    (entry) => entry.key.id === id && sameDiscussion(entry.key.discussion, draft.key),
  )

  if (thread?.anchor._tag !== 'Exact')
    return yield* new DiscussionCommandRejected({ reason: 'invalid-anchor' })

  return yield* validateCodeAnchor(draft.origin, thread.anchor.anchor)
})
