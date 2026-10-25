import { Effect, Option, Schema } from 'effect'

import {
  CodeAnchor,
  DiscussionCommandRejected,
  type DiscussionReview,
  type LineRange,
  type Side,
  sameComparison,
  DiscussionThread,
  type PlacementReason,
  discussionPolicy,
} from '../pull-requests/Discussion'
import { BranchReview, FileChange } from './BranchReview'

export const reviewMatches = (input: DiscussionReview): boolean => {
  const { key, comparison, selection, review } = input

  return (
    key.providerId === selection.provider &&
    key.providerId === comparison.providerId &&
    key.repository.authority === selection.repository.authority &&
    key.repository.key === selection.repository.key &&
    key.repository.authority === comparison.authority &&
    key.repository.authority === comparison.targetRepository.authority &&
    key.repository.key === comparison.targetRepository.key &&
    key.pullRequestId === selection.id &&
    key.pullRequestId === comparison.pullRequestId &&
    comparison.sourceRevision === review.headCommit &&
    comparison.baseRevision === review.baseCommit &&
    [comparison.sourceRevision, comparison.targetRevision, comparison.baseRevision].every(
      (commit) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
    )
  )
}

export const anchorMatchesReview = (review: DiscussionReview, anchor: CodeAnchor): boolean => {
  if (Option.isNone(Schema.decodeUnknownOption(CodeAnchor)(anchor))) return false
  const changes = review.review.files.filter((change) => change.path === anchor.change.path)
  const change = changes[0]

  if (
    !reviewMatches(review) ||
    !sameComparison(review.comparison, anchor.comparison) ||
    changes.length !== 1 ||
    !change ||
    change.status !== anchor.change.status ||
    change.previousPath !== anchor.change.previousPath
  )
    return false
  const path = anchor.side === 'head' ? change.path : (change.previousPath ?? change.path)

  return (
    anchor.path === path &&
    anchor.commit ===
      (anchor.side === 'head' ? review.review.headCommit : review.review.baseCommit) &&
    !(anchor.side === 'head' && change.status === 'D') &&
    !(anchor.side === 'base' && change.status === 'A') &&
    !review.review.files.some(
      (other) =>
        other.path !== change.path &&
        (anchor.side === 'head' ? other.path : (other.previousPath ?? other.path)) === path,
    )
  )
}

export const validateDiscussionReview = Effect.fn('DiscussionPlacement.validateDiscussionReview')(
  function* (review: DiscussionReview) {
    if (!reviewMatches(review))
      return yield* new DiscussionCommandRejected({ reason: 'invalid-anchor' })
    const git = yield* BranchReview

    const actual = yield* git
      .prepare(
        review.review.root,
        {
          source: {
            commit: review.comparison.sourceRevision,
            ref: review.review.headBranch,
            remote: Option.none(),
          },
          target: {
            commit: review.comparison.targetRevision,
            ref: review.review.baseBranch,
            remote: Option.none(),
          },
        },
        'local-only',
      )
      .pipe(Effect.mapError(() => new DiscussionCommandRejected({ reason: 'invalid-anchor' })))

    if (
      actual.baseCommit !== review.comparison.baseRevision ||
      actual.headCommit !== review.comparison.sourceRevision ||
      !Schema.toEquivalence(Schema.Array(FileChange))(actual.files, review.review.files)
    )
      return yield* new DiscussionCommandRejected({ reason: 'invalid-anchor' })

    return review
  },
)

const validateAnchorContent = Effect.fn('DiscussionPlacement.validateAnchorContent')(function* (
  review: DiscussionReview,
  input: CodeAnchor,
) {
  const reject = () => new DiscussionCommandRejected({ reason: 'invalid-anchor' })
  const anchor = yield* Schema.decodeUnknownEffect(CodeAnchor)(input).pipe(Effect.mapError(reject))
  const changes = review.review.files.filter((change) => change.path === anchor.change.path)
  const change = changes[0]

  if (
    !reviewMatches(review) ||
    !sameComparison(review.comparison, anchor.comparison) ||
    changes.length !== 1 ||
    !change ||
    change.status !== anchor.change.status ||
    change.previousPath !== anchor.change.previousPath
  )
    return yield* reject()
  const path = anchor.side === 'head' ? change.path : (change.previousPath ?? change.path)
  const commit = anchor.side === 'head' ? review.review.headCommit : review.review.baseCommit

  if (
    anchor.path !== path ||
    anchor.commit !== commit ||
    (anchor.side === 'head' && change.status === 'D') ||
    (anchor.side === 'base' && change.status === 'A')
  )
    return yield* reject()

  if (
    review.review.files.some(
      (other) =>
        other.path !== change.path &&
        (anchor.side === 'head' ? other.path : (other.previousPath ?? other.path)) === path,
    )
  )
    return yield* reject()
  const git = yield* BranchReview
  const comparisons = yield* git.comparisons(review.review).pipe(Effect.mapError(reject))
  const comparison = comparisons.find((file) => file.change.path === change.path)
  const object = comparison?.[anchor.side]

  if (!object || Option.isNone(object) || !['100644', '100755'].includes(object.value.mode))
    return yield* reject()

  const content = yield* git
    .read({ root: review.review.root, commit, path })
    .pipe(Effect.mapError(reject))

  if (content.includes('\0') || content.includes('\ufffd') || content.length === 0)
    return yield* reject()
  const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0)

  if (anchor.range.end > lines) return yield* reject()

  return anchor
})

export const validateCodeAnchor = Effect.fn('DiscussionPlacement.validateCodeAnchor')(function* (
  review: DiscussionReview,
  anchor: CodeAnchor,
) {
  yield* validateDiscussionReview(review)

  return yield* validateAnchorContent(review, anchor)
})

export const validateDiscussionThreads = Effect.fn('DiscussionPlacement.validateDiscussionThreads')(
  function* (review: DiscussionReview, threads: ReadonlyArray<DiscussionThread>) {
    const comparison = yield* validateDiscussionReview(review).pipe(Effect.result)

    return yield* Effect.forEach(
      threads,
      Effect.fn('DiscussionPlacement.validateThread')(function* (thread) {
        if (thread.anchor._tag === 'Unplaced') return thread

        const unplace = (reason: PlacementReason) =>
          DiscussionThread.make({
            key: thread.key,
            comments: thread.comments,
            commentsComplete: thread.commentsComplete,
            resolution: thread.resolution,
            anchor: { _tag: 'Unplaced', reason },
            reply: thread.reply,
            resolve: thread.resolve,
            reopen: thread.reopen,
            providerPage: thread.providerPage,
          })

        if (comparison._tag === 'Failure') return unplace('different-comparison')

        const anchor = yield* validateAnchorContent(review, thread.anchor.anchor).pipe(
          Effect.result,
        )

        return anchor._tag === 'Success' ? thread : unplace('unsupported-content')
      }),
      { concurrency: discussionPolicy.concurrency },
    )
  },
)

export const makeCodeAnchor = Effect.fn('DiscussionPlacement.makeCodeAnchor')(function* (
  review: DiscussionReview,
  change: FileChange,
  side: Side,
  range: LineRange,
) {
  return yield* validateCodeAnchor(review, {
    comparison: review.comparison,
    change,
    side,
    range,
    path: side === 'head' ? change.path : (change.previousPath ?? change.path),
    commit: side === 'head' ? review.review.headCommit : review.review.baseCommit,
  })
})
