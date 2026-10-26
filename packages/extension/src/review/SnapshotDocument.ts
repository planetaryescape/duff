import {
  DiscussionKey,
  Side,
  type DiscussionReview,
  sameComparison,
  sameDiscussion,
} from '@duff/core/discussion'
import { ComparisonIdentity, RepositoryIdentity } from '@duff/core/git-hosting-provider'
import { GitPath, Snapshot, type FileChange } from '@duff/core/review'
import { fileSnapshots } from '@duff/core/review-progress'
import { Option, Schema } from 'effect'

const Qualified = Schema.TaggedStruct('PrReview', {
  version: Schema.Literal(1),
  snapshot: Snapshot,
  discussion: DiscussionKey,
  comparison: ComparisonIdentity,
  logicalPath: GitPath,
  side: Side,
}).check(
  Schema.makeFilter(
    (value) =>
      value.discussion.providerId === value.comparison.providerId &&
      value.discussion.pullRequestId === value.comparison.pullRequestId &&
      value.discussion.repository.authority === value.comparison.authority &&
      value.discussion.repository.authority === value.comparison.targetRepository.authority &&
      value.discussion.repository.key === value.comparison.targetRepository.key &&
      value.snapshot.commit ===
        (value.side === 'base' ? value.comparison.baseRevision : value.comparison.sourceRevision),
  ),
)

const Legacy = Schema.TaggedStruct('Legacy', { snapshot: Snapshot })

export const SnapshotDocument = Schema.Union([Qualified, Legacy])

export type SnapshotDocument = Schema.Schema.Type<typeof SnapshotDocument>

export function decodeSnapshotDocument(query: string): Option.Option<SnapshotDocument> {
  const qualified = Schema.decodeUnknownOption(Schema.fromJsonString(Qualified))(query)

  if (Option.isSome(qualified)) return qualified

  const tagged = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
  )(query)

  if (Option.isSome(tagged)) return Option.none()

  return Option.map(
    Schema.decodeUnknownOption(Schema.fromJsonString(Snapshot))(query),
    (snapshot) => Legacy.make({ snapshot }),
  )
}

export function snapshotDocument(
  review: DiscussionReview,
  change: FileChange,
  side: Side,
): SnapshotDocument {
  const [base, head] = fileSnapshots(review.review, change)

  return Qualified.make({
    _tag: 'PrReview',
    version: 1,
    snapshot: side === 'base' ? base : head,
    discussion: review.key,
    comparison: review.comparison,
    logicalPath: change.path,
    side,
  })
}

export function encodeSnapshotDocument(document: SnapshotDocument): string {
  if (document._tag === 'Legacy') return JSON.stringify(document.snapshot)

  const repository = (value: DiscussionKey['repository']) =>
    RepositoryIdentity.make({
      authority: value.authority,
      key: value.key,
      displayName: value.key,
    })

  return JSON.stringify({
    _tag: 'PrReview',
    version: 1,
    snapshot: {
      root: document.snapshot.root,
      commit: document.snapshot.commit,
      path: document.snapshot.path,
    },
    discussion: {
      providerId: document.discussion.providerId,
      repository: repository(document.discussion.repository),
      pullRequestId: document.discussion.pullRequestId,
    },
    comparison: {
      providerId: document.comparison.providerId,
      authority: document.comparison.authority,
      targetRepository: repository(document.comparison.targetRepository),
      sourceRepository: repository(document.comparison.sourceRepository),
      pullRequestId: document.comparison.pullRequestId,
      targetRevision: document.comparison.targetRevision,
      sourceRevision: document.comparison.sourceRevision,
      baseRevision: document.comparison.baseRevision,
      mode: document.comparison.mode,
    },
    logicalPath: document.logicalPath,
    side: document.side,
  })
}

export function commentableDocument(document: SnapshotDocument, review: DiscussionReview): boolean {
  if (
    document._tag !== 'PrReview' ||
    !sameDiscussion(document.discussion, review.key) ||
    !sameComparison(document.comparison, review.comparison) ||
    document.snapshot.root !== review.review.root
  )
    return false
  const change = review.review.files.find((file) => file.path === document.logicalPath)

  if (!change) return false
  const expected = snapshotDocument(review, change, document.side)

  return (
    expected.snapshot.path === document.snapshot.path &&
    expected.snapshot.commit === document.snapshot.commit
  )
}
