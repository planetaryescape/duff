import { DraftStorageError, DiscussionCommandRejected } from '@duff/core/discussion'
import { type Attempt } from '@duff/core/discussion-drafts'
import { Cause, Option } from 'effect'

export function discussionFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause)

  if (Option.isSome(error) && error.value instanceof DraftStorageError) {
    if (error.value.reason === 'conflict')
      return 'Another window changed this draft or reserved its destination. Your text was not overwritten. Copy any dirty text before loading the latest saved version.'

    if (error.value.reason === 'invalid')
      return 'Discussion storage is invalid or uses an unsupported version. It has been preserved. Keep or copy any dirty text before reloading.'

    return 'Discussion storage could not confirm the change. Keep your draft open and check disk access. No automatic send retry will run.'
  }

  if (Option.isSome(error) && error.value instanceof DiscussionCommandRejected)
    return `Discussion action was not accepted (${error.value.reason}). Save your text and refresh the discussion before choosing another action.`

  return 'Discussion action did not complete. If a send had started, its outcome may be uncertain. Inspect the saved attempt before sending again.'
}

export function attemptMessage(attempt: Attempt): string {
  switch (attempt._tag) {
    case 'Confirmed':
      return attempt.receipt._tag === 'Comment'
        ? `Posted.${attempt.receipt.placement === 'unverified' ? ' Provider placement could not be verified. Do not repost; inspect the provider page.' : ''}`
        : 'Thread state confirmed.'
    case 'Rejected':
      return `Not posted: ${attempt.reason}. Your draft is retained.`
    case 'Prepared':
      return 'Not dispatched. The saved attempt requires an explicit decision before another send.'
    case 'Dispatching':
    case 'Uncertain':
      return 'Outcome uncertain. The provider may have accepted this action. Your draft and recovery record are retained. Check the provider before choosing to send again.'
  }
}
