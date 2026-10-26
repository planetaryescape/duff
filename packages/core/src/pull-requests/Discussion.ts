import { type Effect, Schema } from 'effect'

import { Commit, FileChange, GitPath, Review } from '../review/BranchReview'
import {
  ComparisonIdentity,
  DiscoveryError,
  RepositoryIdentity,
  PullRequestSelection,
} from './GitHostingProvider'

export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionThreadId'))

export type ThreadId = Schema.Schema.Type<typeof ThreadId>

export const DraftId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionDraftId'))

export type DraftId = Schema.Schema.Type<typeof DraftId>

export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand('DiscussionAttemptId'))

export type AttemptId = Schema.Schema.Type<typeof AttemptId>

export const LineNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export type LineNumber = Schema.Schema.Type<typeof LineNumber>

export const DiscussionKey = Schema.Struct({
  providerId: Schema.NonEmptyString,
  repository: RepositoryIdentity,
  pullRequestId: Schema.NonEmptyString,
})

export interface DiscussionKey extends Schema.Schema.Type<typeof DiscussionKey> {}

export const ThreadKey = Schema.Struct({ discussion: DiscussionKey, id: ThreadId })

export interface ThreadKey extends Schema.Schema.Type<typeof ThreadKey> {}

export const LineRange = Schema.Struct({ start: LineNumber, end: LineNumber }).check(
  Schema.makeFilter((range) => range.start <= range.end),
)

export interface LineRange extends Schema.Schema.Type<typeof LineRange> {}

export const Side = Schema.Literals(['base', 'head'])

export type Side = Schema.Schema.Type<typeof Side>

export const ExactCommit = Commit.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))

export const CodeAnchor = Schema.Struct({
  comparison: ComparisonIdentity,
  change: FileChange,
  side: Side,
  path: GitPath,
  commit: ExactCommit,
  range: LineRange,
})

export interface CodeAnchor extends Schema.Schema.Type<typeof CodeAnchor> {}

export const DiscussionReview = Schema.Struct({
  key: DiscussionKey,
  selection: PullRequestSelection,
  comparison: ComparisonIdentity,
  review: Review,
})

export interface DiscussionReview extends Schema.Schema.Type<typeof DiscussionReview> {}

export const DraftTarget = Schema.Union([
  Schema.TaggedStruct('NewThread', { anchor: CodeAnchor }),
  Schema.TaggedStruct('Reply', { thread: ThreadKey }),
])

export type DraftTarget = Schema.Schema.Type<typeof DraftTarget>

export const Resolution = Schema.Union([
  Schema.TaggedStruct('Open', { detail: Schema.Literals(['active', 'pending', 'unresolved']) }),
  Schema.TaggedStruct('Resolved', {
    detail: Schema.Literals(['fixed', 'wontFix', 'closed', 'byDesign', 'resolved']),
  }),
  Schema.TaggedStruct('Unknown', {}),
])

export type Resolution = Schema.Schema.Type<typeof Resolution>

export const Availability = Schema.Union([
  Schema.TaggedStruct('Allowed', {}),
  Schema.TaggedStruct('CheckOnSend', {}),
  Schema.TaggedStruct('Unavailable', {
    reason: Schema.Literals(['permission', 'unsupported', 'deleted', 'read-only']),
  }),
])

export type Availability = Schema.Schema.Type<typeof Availability>

export const DiscussionComment = Schema.Struct({
  publication: Schema.Literals(['pending', 'published']),
  id: Schema.NonEmptyString,
  author: Schema.String,
  body: Schema.String,
  publishedAt: Schema.String,
  deleted: Schema.Boolean,
})

export interface DiscussionComment extends Schema.Schema.Type<typeof DiscussionComment> {}

export const PlacementReason = Schema.Literals([
  'file-level',
  'outdated',
  'different-comparison',
  'missing-revision',
  'missing-path',
  'ambiguous-rename',
  'unsupported-range',
  'invalid-location',
  'unsupported-content',
  'legacy-azure-context',
])

export type PlacementReason = Schema.Schema.Type<typeof PlacementReason>

export const AnchorEvidence = Schema.Union([
  Schema.TaggedStruct('Exact', { anchor: CodeAnchor, outdated: Schema.Boolean }),
  Schema.TaggedStruct('Unplaced', { reason: PlacementReason }),
])

export type AnchorEvidence = Schema.Schema.Type<typeof AnchorEvidence>

export const DiscussionThread = Schema.Struct({
  key: ThreadKey,
  comments: Schema.Array(DiscussionComment),
  commentsComplete: Schema.Boolean,
  resolution: Resolution,
  anchor: AnchorEvidence,
  reply: Availability,
  resolve: Availability,
  reopen: Availability,
  providerPage: Schema.Option(Schema.String),
})

export interface DiscussionThread extends Schema.Schema.Type<typeof DiscussionThread> {}

export const Completeness = Schema.Union([
  Schema.TaggedStruct('Complete', {}),
  Schema.TaggedStruct('Limited', {
    reason: Schema.Literals(['threads', 'comments', 'bytes', 'requests', 'iterations', 'changes']),
  }),
])

export type Completeness = Schema.Schema.Type<typeof Completeness>

export const DiscussionSnapshot = Schema.Struct({
  key: DiscussionKey,
  threads: Schema.Array(DiscussionThread),
  completeness: Completeness,
})

export interface DiscussionSnapshot extends Schema.Schema.Type<typeof DiscussionSnapshot> {}

export class DiscussionUnsupported extends Schema.TaggedError<DiscussionUnsupported>()(
  'DiscussionUnsupported',
  {},
) {}

export class DiscussionLimitExceeded extends Schema.TaggedError<DiscussionLimitExceeded>()(
  'DiscussionLimitExceeded',
  {},
) {}

export const DiscussionReadError = Schema.Union([
  DiscoveryError,
  DiscussionUnsupported,
  DiscussionLimitExceeded,
])

export type DiscussionReadError = Schema.Schema.Type<typeof DiscussionReadError>

export class DiscussionWriteRejected extends Schema.TaggedError<DiscussionWriteRejected>()(
  'DiscussionWriteRejected',
  {
    reason: Schema.Literals([
      'authentication',
      'permission',
      'missing-thread',
      'unsupported-anchor',
      'comparison-changed',
      'invalid-body',
      'rate-limited',
      'conflict',
    ]),
  },
) {}

export class DiscussionWriteUncertain extends Schema.TaggedError<DiscussionWriteUncertain>()(
  'DiscussionWriteUncertain',
  { reason: Schema.Literals(['transport', 'timeout', 'interrupted', 'invalid-response']) },
) {}

export type DiscussionWriteError = DiscussionWriteRejected | DiscussionWriteUncertain

export class DraftStorageError extends Schema.TaggedError<DraftStorageError>()(
  'DraftStorageError',
  {
    reason: Schema.Literals([
      'unavailable',
      'busy',
      'invalid',
      'conflict',
      'write-failed',
      'limit',
    ]),
  },
) {}

export class DiscussionCommandRejected extends Schema.TaggedError<DiscussionCommandRejected>()(
  'DiscussionCommandRejected',
  {
    reason: Schema.Literals([
      'inactive',
      'stale-command',
      'busy',
      'unsaved',
      'uncertain-attempt',
      'invalid-anchor',
      'invalid-body',
    ]),
  },
) {}

export const CreateThreadInput = Schema.Struct({
  attempt: AttemptId,
  review: DiscussionReview,
  anchor: CodeAnchor,
  body: Schema.String,
})

export interface CreateThreadInput extends Schema.Schema.Type<typeof CreateThreadInput> {}

export const ReplyInput = Schema.Struct({
  attempt: AttemptId,
  thread: ThreadKey,
  body: Schema.String,
})

export interface ReplyInput extends Schema.Schema.Type<typeof ReplyInput> {}

export const ResolutionInput = Schema.Struct({
  attempt: AttemptId,
  thread: ThreadKey,
  desired: Schema.Literals(['resolved', 'open']),
  expected: Resolution,
})

export interface ResolutionInput extends Schema.Schema.Type<typeof ResolutionInput> {}

export const ProviderReceipt = Schema.Union([
  Schema.TaggedStruct('Comment', {
    commentId: Schema.NonEmptyString,
    thread: Schema.Option(ThreadKey),
    providerPage: Schema.Option(Schema.String),
    placement: Schema.Literals(['verified', 'unverified']),
  }),
  Schema.TaggedStruct('Resolution', { thread: ThreadKey, resolution: Resolution }),
])

export type ProviderReceipt = Schema.Schema.Type<typeof ProviderReceipt>

export interface ProviderDiscussion {
  readonly checkCreate: (
    review: DiscussionReview,
    anchor: CodeAnchor,
  ) => Effect.Effect<void, DiscussionWriteRejected>
  readonly read: (
    review: DiscussionReview,
  ) => Effect.Effect<DiscussionSnapshot, DiscussionReadError>
  readonly create: (
    input: CreateThreadInput,
  ) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
  readonly reply: (input: ReplyInput) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
  readonly setResolution: (
    input: ResolutionInput,
  ) => Effect.Effect<ProviderReceipt, DiscussionWriteError>
}

export const ProviderDiscussion = {
  of: (implementation: ProviderDiscussion): ProviderDiscussion => implementation,
}

export const DiscussionState = Schema.Union([
  Schema.TaggedStruct('Inactive', {}),
  Schema.TaggedStruct('Loading', { review: DiscussionReview }),
  Schema.TaggedStruct('Ready', { review: DiscussionReview, snapshot: DiscussionSnapshot }),
  Schema.TaggedStruct('Refreshing', { review: DiscussionReview, snapshot: DiscussionSnapshot }),
  Schema.TaggedStruct('Stale', {
    review: DiscussionReview,
    snapshot: DiscussionSnapshot,
    error: DiscussionReadError,
  }),
  Schema.TaggedStruct('Failed', { review: DiscussionReview, error: DiscussionReadError }),
])

export type DiscussionState = Schema.Schema.Type<typeof DiscussionState>

export const discussionKey = (key: DiscussionKey): string =>
  JSON.stringify([key.providerId, key.repository.authority, key.repository.key, key.pullRequestId])

export const sameDiscussion = (left: DiscussionKey, right: DiscussionKey): boolean =>
  discussionKey(left) === discussionKey(right)

export const sameComparison = (left: ComparisonIdentity, right: ComparisonIdentity): boolean =>
  left.providerId === right.providerId &&
  left.authority === right.authority &&
  left.targetRepository.authority === right.targetRepository.authority &&
  left.targetRepository.key === right.targetRepository.key &&
  left.sourceRepository.authority === right.sourceRepository.authority &&
  left.sourceRepository.key === right.sourceRepository.key &&
  left.pullRequestId === right.pullRequestId &&
  left.sourceRevision === right.sourceRevision &&
  left.targetRevision === right.targetRevision &&
  left.baseRevision === right.baseRevision &&
  left.mode === right.mode

export const discussionPolicy = Object.freeze({
  requestTimeout: 20000,
  refreshTimeout: 60000,
  responseBytes: 4 * 1024 * 1024,
  requests: 100,
  concurrency: 4,
  pageSize: 50,
  threads: 500,
  commentsPerThread: 500,
  comments: 5000,
  iterations: 1000,
  changes: 10000,
  changesPage: 100,
  draftBytes: 64 * 1024,
  draftPageSize: 100,
})

export const validDiscussionBody = (body: string): boolean =>
  body.trim().length > 0 && Buffer.byteLength(body, 'utf8') <= discussionPolicy.draftBytes
