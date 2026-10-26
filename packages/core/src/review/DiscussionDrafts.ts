import { Context, Effect, Option, Schema } from 'effect'

import {
  AttemptId,
  DiscussionKey,
  DiscussionReview,
  DraftId,
  DraftStorageError,
  DraftTarget,
  ProviderReceipt,
  ResolutionInput,
  DiscussionWriteRejected,
  discussionPolicy,
  sameDiscussion,
} from '../pull-requests/Discussion'
import { anchorMatchesReview, reviewMatches } from './DiscussionPlacement'

const Version = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const Draft = Schema.Struct({
  id: DraftId,
  key: DiscussionKey,
  target: DraftTarget,
  origin: DiscussionReview,
  version: Version,
  body: Schema.String.check(
    Schema.makeFilter((body) => Buffer.byteLength(body, 'utf8') <= discussionPolicy.draftBytes),
  ),
}).check(
  Schema.makeFilter(
    (draft) =>
      reviewMatches(draft.origin) &&
      sameDiscussion(draft.key, draft.origin.key) &&
      (draft.target._tag === 'NewThread'
        ? anchorMatchesReview(draft.origin, draft.target.anchor)
        : sameDiscussion(draft.key, draft.target.thread.discussion)),
  ),
)

export interface Draft extends Schema.Schema.Type<typeof Draft> {}

export const AttemptIntent = Schema.Struct({
  id: AttemptId,
  key: DiscussionKey,
  input: Schema.Union([
    Schema.TaggedStruct('Draft', { draft: Draft }),
    Schema.TaggedStruct('Resolution', { command: ResolutionInput }),
  ]),
}).check(
  Schema.makeFilter((intent) =>
    intent.input._tag === 'Draft'
      ? sameDiscussion(intent.key, intent.input.draft.key)
      : intent.id === intent.input.command.attempt &&
        sameDiscussion(intent.key, intent.input.command.thread.discussion),
  ),
)

export interface AttemptIntent extends Schema.Schema.Type<typeof AttemptIntent> {}

export const Attempt = Schema.Union([
  Schema.TaggedStruct('Prepared', { intent: AttemptIntent }),
  Schema.TaggedStruct('Dispatching', { intent: AttemptIntent }),
  Schema.TaggedStruct('Uncertain', { intent: AttemptIntent }),
  Schema.TaggedStruct('Rejected', {
    intent: AttemptIntent,
    reason: DiscussionWriteRejected.fields.reason,
  }),
  Schema.TaggedStruct('Confirmed', { intent: AttemptIntent, receipt: ProviderReceipt }),
])

export type Attempt = Schema.Schema.Type<typeof Attempt>

const sameIntent = Schema.toEquivalence(AttemptIntent)

export const transitionAttempt = Effect.fn('DiscussionDrafts.transitionAttempt')(function* (
  previous: Attempt,
  next: Attempt,
) {
  const legal =
    previous._tag === 'Prepared'
      ? next._tag === 'Dispatching' || next._tag === 'Rejected'
      : previous._tag === 'Dispatching' &&
        (next._tag === 'Confirmed' || next._tag === 'Rejected' || next._tag === 'Uncertain')

  if (!legal || !sameIntent(previous.intent, next.intent))
    return yield* new DraftStorageError({ reason: 'conflict' })

  if (next._tag === 'Confirmed') {
    const thread =
      next.receipt._tag === 'Resolution' ? Option.some(next.receipt.thread) : next.receipt.thread

    if (Option.isSome(thread) && !sameDiscussion(next.intent.key, thread.value.discussion))
      return yield* new DraftStorageError({ reason: 'invalid' })
  }

  return next
})

export const DraftPage = Schema.Struct({
  drafts: Schema.Array(Draft),
  attempts: Schema.Array(Attempt),
  next: Schema.Option(Schema.String),
})

export interface DraftPage extends Schema.Schema.Type<typeof DraftPage> {}

export const DraftRecoveryPage = DraftPage.check(
  Schema.makeFilter(
    (page) =>
      page.drafts.length + page.attempts.length <= discussionPolicy.draftPageSize &&
      page.attempts.every(
        (attempt) =>
          attempt._tag === 'Prepared' ||
          attempt._tag === 'Dispatching' ||
          attempt._tag === 'Uncertain',
      ),
  ),
)

export interface DraftRecoveryPage extends Schema.Schema.Type<typeof DraftRecoveryPage> {}

export interface DraftSave {
  readonly id: DraftId
  readonly expectedVersion: number
  readonly body: string
}

export interface DraftVersion {
  readonly id: DraftId
  readonly expectedVersion: number
}

export class DiscussionDraftStore extends Context.Service<
  DiscussionDraftStore,
  {
    readonly listAll: (
      cursor: Option.Option<string>,
    ) => Effect.Effect<DraftRecoveryPage, DraftStorageError>
    readonly list: (
      key: DiscussionKey,
      cursor: Option.Option<string>,
    ) => Effect.Effect<DraftPage, DraftStorageError>
    readonly get: (id: DraftId) => Effect.Effect<Option.Option<Draft>, DraftStorageError>
    readonly create: (draft: Draft) => Effect.Effect<Draft, DraftStorageError>
    readonly save: (input: DraftSave) => Effect.Effect<Draft, DraftStorageError>
    readonly discard: (input: DraftVersion) => Effect.Effect<void, DraftStorageError>
    readonly prepare: (intent: AttemptIntent) => Effect.Effect<Attempt, DraftStorageError>
    readonly dispatch: (id: AttemptId) => Effect.Effect<Attempt, DraftStorageError>
    readonly finish: (attempt: Attempt) => Effect.Effect<void, DraftStorageError>
    readonly getAttempt: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, DraftStorageError>
    readonly acknowledgeUncertain: (id: AttemptId) => Effect.Effect<void, DraftStorageError>
  }
>()('duff/DiscussionDraftStore') {}

export class DiscussionIds extends Context.Service<
  DiscussionIds,
  { readonly draft: () => Effect.Effect<DraftId>; readonly attempt: () => Effect.Effect<AttemptId> }
>()('duff/DiscussionIds') {}

export const DraftEnvelope = Schema.Struct({ version: Schema.Literal(1), value: Draft })

export const AttemptEnvelope = Schema.Struct({ version: Schema.Literal(1), value: Attempt })

export { DraftStorageError } from '../pull-requests/Discussion'
