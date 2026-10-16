import { Context, Schema } from 'effect'
import { type Effect } from 'effect'

import { PullRequestSelection, ResolvedPullRequest } from '../pull-requests/PullRequests'
import { FileComparison, GitPath, RetentionPrefix, Review } from './BranchReview'

export const SavedReview = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  selection: PullRequestSelection,
  resolved: ResolvedPullRequest,
  review: Review,
  comparisons: Schema.Array(FileComparison),
  viewed: Schema.Array(GitPath),
  lastFile: Schema.Option(GitPath),
  updatedAt: Schema.Number,
  retention: RetentionPrefix,
})

export interface SavedReview extends Schema.Schema.Type<typeof SavedReview> {}

export const PendingRelease = Schema.Struct({ root: Schema.String, prefix: RetentionPrefix })

export interface PendingRelease extends Schema.Schema.Type<typeof PendingRelease> {}

export const SavedReviewCatalog = Schema.Struct({
  version: Schema.Literal(1),
  active: Schema.Option(Schema.String),
  sessions: Schema.Array(SavedReview),
  pendingRelease: Schema.Array(PendingRelease),
})

export interface SavedReviewCatalog extends Schema.Schema.Type<typeof SavedReviewCatalog> {}

export class ReviewStorageError extends Schema.TaggedError<ReviewStorageError>()(
  'ReviewStorageError',
  {
    reason: Schema.Literals(['unavailable', 'busy', 'invalid', 'write-failed']),
  },
) {}

export class SavedReviews extends Context.Service<
  SavedReviews,
  {
    readonly owner: string
    readonly load: () => Effect.Effect<SavedReviewCatalog, ReviewStorageError>
    readonly save: (catalog: SavedReviewCatalog) => Effect.Effect<void, ReviewStorageError>
  }
>()('duff/SavedReviews') {}
