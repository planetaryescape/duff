import { Effect, Option, type Redacted, Schema } from 'effect'

import { anchorMatchesReview } from '../../review/DiscussionPlacement'
import {
  AnchorEvidence,
  Availability,
  CodeAnchor,
  type CreateThreadInput,
  type DiscussionReview,
  DiscussionSnapshot,
  Completeness,
  type DiscussionLimitExceeded,
  DiscussionComment,
  DiscussionWriteRejected,
  DiscussionWriteUncertain,
  ProviderDiscussion,
  ProviderReceipt,
  type ReplyInput,
  Resolution,
  type ResolutionInput,
  ThreadId,
  type ThreadKey,
  discussionPolicy,
  validDiscussionBody,
} from '../Discussion'
import {
  boundDiscussion,
  decodeDiscussion,
  makeDiscussionBudget,
  mutationBody,
  preflightFailure,
} from '../DiscussionHttp'
import {
  type DiscoveryError,
  InvalidProviderResponse,
  type RepositoryIdentity,
} from '../GitHostingProvider'
import { type ProviderHttp } from '../ProviderHttp'

const Id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))

const Iteration = Schema.Struct({
  id: Id,
  sourceRefCommit: Schema.Struct({ commitId: Revision }),
  targetRefCommit: Schema.Struct({ commitId: Revision }),
  commonRefCommit: Schema.Struct({ commitId: Revision }),
})

const Position = Schema.Struct({ line: Id, offset: Count })

const Context = Schema.Struct({
  filePath: Schema.String,
  leftFileStart: Schema.optionalKey(Schema.NullOr(Position)),
  leftFileEnd: Schema.optionalKey(Schema.NullOr(Position)),
  rightFileStart: Schema.optionalKey(Schema.NullOr(Position)),
  rightFileEnd: Schema.optionalKey(Schema.NullOr(Position)),
})

const Pair = Schema.Struct({ firstComparingIteration: Id, secondComparingIteration: Id })

const Tracking = Schema.Struct({
  ...Pair.fields,
  origFilePath: Schema.optionalKey(Schema.String),
  origLeftFileStart: Schema.optionalKey(Schema.NullOr(Position)),
  origLeftFileEnd: Schema.optionalKey(Schema.NullOr(Position)),
  origRightFileStart: Schema.optionalKey(Schema.NullOr(Position)),
  origRightFileEnd: Schema.optionalKey(Schema.NullOr(Position)),
})

const PrContext = Schema.Struct({
  changeTrackingId: Schema.optionalKey(Id),
  iterationContext: Schema.optionalKey(Schema.NullOr(Pair)),
  trackingCriteria: Schema.optionalKey(Schema.NullOr(Tracking)),
})

const Comment = Schema.Struct({
  id: Id,
  parentCommentId: Schema.optionalKey(Count),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  author: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ displayName: Schema.optionalKey(Schema.String) })),
  ),
  publishedDate: Schema.optionalKey(Schema.String),
  isDeleted: Schema.optionalKey(Schema.Boolean),
  commentType: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
})

const Thread = Schema.Struct({
  id: Id,
  comments: Schema.Array(Comment),
  status: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
  isDeleted: Schema.optionalKey(Schema.Boolean),
  threadContext: Schema.optionalKey(Schema.NullOr(Context)),
  pullRequestThreadContext: Schema.optionalKey(Schema.NullOr(PrContext)),
})

type Thread = Schema.Schema.Type<typeof Thread>

const Change = Schema.Struct({
  changeTrackingId: Id,
  item: Schema.Struct({ path: Schema.String }),
  originalPath: Schema.optionalKey(Schema.String),
})

type Change = Schema.Schema.Type<typeof Change>

const Changes = Schema.Struct({
  changeEntries: Schema.Array(Change),
  nextSkip: Schema.optionalKey(Count),
  nextTop: Schema.optionalKey(Count),
})

const resolution = (status: string | number | undefined): Resolution => {
  switch (status) {
    case 'active':
    case 1:
      return Resolution.make({ _tag: 'Open', detail: 'active' })
    case 'pending':
    case 6:
      return Resolution.make({ _tag: 'Open', detail: 'pending' })
    case 'fixed':
    case 2:
      return Resolution.make({ _tag: 'Resolved', detail: 'fixed' })
    case 'wontFix':
    case 3:
      return Resolution.make({ _tag: 'Resolved', detail: 'wontFix' })
    case 'closed':
    case 4:
      return Resolution.make({ _tag: 'Resolved', detail: 'closed' })
    case 'byDesign':
    case 5:
      return Resolution.make({ _tag: 'Resolved', detail: 'byDesign' })
    default:
      return Resolution.make({ _tag: 'Unknown' })
  }
}

const available = (yes: boolean): Availability =>
  Availability.make(yes ? { _tag: 'CheckOnSend' } : { _tag: 'Unavailable', reason: 'unsupported' })

const Evidence = Schema.Struct({
  iteration: Schema.UndefinedOr(Id),
  changes: Schema.Array(Change),
  completeness: Completeness,
})

type Evidence = Schema.Schema.Type<typeof Evidence>

const ThreadRead = Schema.Struct({
  thread: Thread,
  token: Schema.Option(Schema.Redacted(Schema.String)),
})

const CreateEvidence = Schema.Struct({
  proof: Evidence,
  token: Schema.Option(Schema.Redacted(Schema.String)),
  change: Change,
  iteration: Id,
})

export const makeAzureDiscussion = (
  repository: RepositoryIdentity,
  endpoint: string,
  page: string,
  http: ProviderHttp['Service'],
  session: () => Effect.Effect<Option.Option<Redacted.Redacted>, DiscoveryError>,
): ProviderDiscussion => {
  const check = (key: ThreadKey['discussion']) =>
    boundDiscussion(key, 'azure-devops', 'dev.azure.com', repository.key)

  const evidence = Effect.fn('AzureDiscussion.evidence')(function* (
    review: DiscussionReview,
    budget: Effect.Success<ReturnType<typeof makeDiscussionBudget>>,
  ): Effect.fn.Return<Evidence, DiscoveryError | DiscussionLimitExceeded> {
    const response = yield* budget.get(
      `${endpoint}/${review.key.pullRequestId}/iterations?api-version=7.1`,
    )

    const iterations = yield* decodeDiscussion(Schema.Struct({ value: Schema.Array(Iteration) }))(
      response,
    )

    if (iterations.value.length > discussionPolicy.iterations)
      return Evidence.make({
        iteration: undefined,
        changes: [],
        completeness: { _tag: 'Limited', reason: 'iterations' },
      })

    const matches = iterations.value.filter(
      (iteration) =>
        iteration.sourceRefCommit.commitId === review.comparison.sourceRevision &&
        iteration.targetRefCommit.commitId === review.comparison.targetRevision &&
        iteration.commonRefCommit.commitId === review.comparison.baseRevision,
    )

    const iteration = matches[0]

    if (!iteration || matches.length !== 1)
      return Evidence.make({
        iteration: undefined,
        changes: [],
        completeness: { _tag: 'Complete' },
      })
    const changes: Change[] = []
    let skip = 0
    let top: number = discussionPolicy.changesPage

    while (true) {
      if (budget.available() <= 1)
        return Evidence.make({
          iteration: undefined,
          changes: [],
          completeness: { _tag: 'Limited', reason: 'requests' },
        })

      const response = yield* budget.get(
        `${endpoint}/${review.key.pullRequestId}/iterations/${iteration.id}/changes?$compareTo=0&$top=${top}&$skip=${skip}&api-version=7.1`,
      )

      const result = yield* decodeDiscussion(Changes)(response)

      if (result.changeEntries.length > top) return yield* new InvalidProviderResponse()
      changes.push(...result.changeEntries)

      if (changes.length > discussionPolicy.changes)
        return Evidence.make({
          iteration: undefined,
          changes: [],
          completeness: { _tag: 'Limited', reason: 'changes' },
        })

      if (
        (result.nextSkip === 0 && result.nextTop === 0) ||
        (result.nextSkip === undefined &&
          result.nextTop === undefined &&
          result.changeEntries.length < top)
      )
        break

      if (
        result.nextSkip === undefined ||
        result.nextTop === undefined ||
        result.nextSkip <= skip ||
        result.nextTop < 1 ||
        result.nextTop > discussionPolicy.changesPage
      )
        return yield* new InvalidProviderResponse()
      skip = result.nextSkip
      top = result.nextTop
    }

    return Evidence.make({ iteration: iteration.id, changes, completeness: { _tag: 'Complete' } })
  })

  const read = Effect.fn('AzureDiscussion.read')(
    function* (review: DiscussionReview) {
      if (!check(review.key)) return yield* new InvalidProviderResponse()
      const token = yield* session()
      const budget = yield* makeDiscussionBudget(http, token)
      const proof = yield* evidence(review, budget)

      const tracking =
        proof.iteration === undefined
          ? ''
          : `&$iteration=${proof.iteration}&$baseIteration=${proof.iteration}`

      const response = yield* budget.get(
        `${endpoint}/${review.key.pullRequestId}/threads?api-version=7.1${tracking}`,
      )

      const result = yield* decodeDiscussion(Schema.Struct({ value: Schema.Array(Thread) }))(
        response,
      )

      const threads: DiscussionSnapshot['threads'][number][] = []
      let completeness = proof.completeness
      let total = 0
      const ids = new Set<number>()

      for (const raw of result.value) {
        if (ids.has(raw.id)) continue
        ids.add(raw.id)

        if (threads.length >= discussionPolicy.threads || total >= discussionPolicy.comments) {
          completeness = {
            _tag: 'Limited',
            reason: threads.length >= discussionPolicy.threads ? 'threads' : 'comments',
          }
          break
        }

        const comments = [
          ...new Map(raw.comments.map((comment) => [comment.id, comment])).values(),
        ].slice(0, Math.min(discussionPolicy.commentsPerThread, discussionPolicy.comments - total))

        total += comments.length

        const complete =
          comments.length === raw.comments.length &&
          comments.length < discussionPolicy.commentsPerThread

        if (!complete) completeness = { _tag: 'Limited', reason: 'comments' }
        const state = resolution(raw.status)

        const root = raw.comments.find(
          (comment) =>
            comment.parentCommentId === 0 &&
            comment.isDeleted !== true &&
            (comment.commentType === 'text' || comment.commentType === 1),
        )

        threads.push({
          key: { discussion: review.key, id: ThreadId.make(String(raw.id)) },
          comments: comments.map((comment) =>
            DiscussionComment.make({
              publication: 'published',
              id: String(comment.id),
              author: comment.author?.displayName ?? 'Deleted user',
              body: comment.content ?? '',
              publishedAt: comment.publishedDate ?? '',
              deleted: comment.isDeleted ?? false,
            }),
          ),
          commentsComplete: complete,
          resolution: state,
          anchor: place(review, raw, proof),
          reply: available(
            raw.isDeleted !== true &&
              root !== undefined &&
              raw.comments.length < discussionPolicy.commentsPerThread,
          ),
          resolve: available(raw.isDeleted !== true && state._tag !== 'Unknown'),
          reopen: available(raw.isDeleted !== true && state._tag !== 'Unknown'),
          providerPage: Option.some(`${page}/pullrequest/${review.key.pullRequestId}`),
        })
      }

      return DiscussionSnapshot.make({ key: review.key, threads, completeness })
    },
    Effect.timeoutOrElse({
      duration: discussionPolicy.refreshTimeout,
      orElse: () => Effect.fail(new InvalidProviderResponse()),
    }),
  )

  const readThread = Effect.fn('AzureDiscussion.readThread')(
    function* (key: ThreadKey) {
      if (
        !check(key.discussion) ||
        !/^[1-9][0-9]*$/.test(key.id) ||
        !Number.isSafeInteger(Number(key.id))
      )
        return yield* new InvalidProviderResponse()
      const token = yield* session()

      if (Option.isNone(token))
        return yield* new DiscussionWriteRejected({ reason: 'authentication' })

      const response = yield* http.get(
        `${endpoint}/${key.discussion.pullRequestId}/threads/${key.id}?api-version=7.1`,
        token,
      )

      const thread = yield* decodeDiscussion(Thread)(response)

      if (String(thread.id) !== key.id) return yield* new InvalidProviderResponse()

      return ThreadRead.make({ thread, token })
    },
    Effect.mapError((error) =>
      error._tag === 'DiscussionWriteRejected' ? error : preflightFailure(error),
    ),
  )

  const prepareCreate = Effect.fn('AzureDiscussion.prepareCreate')(function* (
    review: DiscussionReview,
    anchor: CodeAnchor,
  ) {
    if (
      !check(review.key) ||
      !anchorMatchesReview(review, anchor) ||
      anchor.range.start !== anchor.range.end
    )
      return yield* new DiscussionWriteRejected({ reason: 'unsupported-anchor' })
    const token = yield* session().pipe(Effect.mapError(preflightFailure))

    if (Option.isNone(token))
      return yield* new DiscussionWriteRejected({ reason: 'authentication' })

    const proof = yield* Effect.gen(function* () {
      return yield* evidence(review, yield* makeDiscussionBudget(http, token))
    }).pipe(Effect.mapError(preflightFailure))

    const changes = proof.changes.filter(
      (change) => change.item.path.replace(/^\//, '') === anchor.change.path,
    )

    const change = changes[0]

    if (proof.iteration === undefined || changes.length !== 1 || !change)
      return yield* new DiscussionWriteRejected({ reason: 'unsupported-anchor' })

    if (
      anchor.side === 'base' &&
      anchor.change.previousPath !== undefined &&
      change.originalPath?.replace(/^\//, '') !== anchor.change.previousPath
    )
      return yield* new DiscussionWriteRejected({ reason: 'unsupported-anchor' })

    return CreateEvidence.make({ proof, token, change, iteration: proof.iteration })
  })

  const checkCreate = Effect.fn('AzureDiscussion.checkCreate')(
    (review: DiscussionReview, anchor: CodeAnchor) =>
      prepareCreate(review, anchor).pipe(Effect.asVoid),
  )

  const create = Effect.fn('AzureDiscussion.create')(function* (
    input: CreateThreadInput,
  ): Effect.fn.Return<ProviderReceipt, DiscussionWriteRejected | DiscussionWriteUncertain> {
    const { review, anchor } = input

    if (!validDiscussionBody(input.body))
      return yield* new DiscussionWriteRejected({ reason: 'invalid-body' })
    const { token, proof, change, iteration } = yield* prepareCreate(review, anchor)
    const position = { line: anchor.range.start, offset: 0 }

    const context: Schema.Json =
      anchor.side === 'head'
        ? { filePath: `/${anchor.path}`, rightFileStart: position, rightFileEnd: position }
        : { filePath: `/${anchor.path}`, leftFileStart: position, leftFileEnd: position }

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'POST',
        url: `${endpoint}/${review.key.pullRequestId}/threads?api-version=7.1`,
        token,
        headers: {},
        body: {
          comments: [{ parentCommentId: 0, content: input.body, commentType: 1 }],
          status: 'active',
          threadContext: context,
          pullRequestThreadContext: {
            changeTrackingId: change.changeTrackingId,
            iterationContext: {
              firstComparingIteration: iteration,
              secondComparingIteration: iteration,
            },
          },
        },
      }),
    )

    const returned = yield* Schema.decodeUnknownEffect(Thread)(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    const comment = returned.comments.find((comment) => comment.parentCommentId === 0)

    if (!comment) return yield* new DiscussionWriteUncertain({ reason: 'invalid-response' })
    const placement = place(review, returned, proof)

    const verified =
      placement._tag === 'Exact' &&
      placement.anchor.side === anchor.side &&
      placement.anchor.path === anchor.path &&
      placement.anchor.range.start === anchor.range.start &&
      placement.anchor.range.end === anchor.range.end

    return ProviderReceipt.make({
      _tag: 'Comment',
      commentId: String(comment.id),
      thread: Option.some({ discussion: review.key, id: ThreadId.make(String(returned.id)) }),
      providerPage: Option.some(`${page}/pullrequest/${review.key.pullRequestId}`),
      placement: verified ? 'verified' : 'unverified',
    })
  })

  const reply = Effect.fn('AzureDiscussion.reply')(function* (
    input: ReplyInput,
  ): Effect.fn.Return<ProviderReceipt, DiscussionWriteRejected | DiscussionWriteUncertain> {
    if (!validDiscussionBody(input.body))
      return yield* new DiscussionWriteRejected({ reason: 'invalid-body' })
    const { thread, token } = yield* readThread(input.thread)

    const root = thread.comments.find(
      (comment) =>
        comment.parentCommentId === 0 &&
        comment.isDeleted !== true &&
        (comment.commentType === 'text' || comment.commentType === 1),
    )

    if (thread.isDeleted || !root || thread.comments.length >= discussionPolicy.commentsPerThread)
      return yield* new DiscussionWriteRejected({ reason: 'missing-thread' })

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'POST',
        url: `${endpoint}/${input.thread.discussion.pullRequestId}/threads/${input.thread.id}/comments?api-version=7.1`,
        token,
        headers: {},
        body: { content: input.body, parentCommentId: root.id, commentType: 1 },
      }),
    )

    const comment = yield* Schema.decodeUnknownEffect(Comment)(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    if (comment.parentCommentId !== root.id)
      return yield* new DiscussionWriteUncertain({ reason: 'invalid-response' })

    return ProviderReceipt.make({
      _tag: 'Comment',
      commentId: String(comment.id),
      thread: Option.some(input.thread),
      providerPage: Option.some(`${page}/pullrequest/${input.thread.discussion.pullRequestId}`),
      placement: 'verified',
    })
  })

  const setResolution = Effect.fn('AzureDiscussion.setResolution')(function* (
    input: ResolutionInput,
  ): Effect.fn.Return<ProviderReceipt, DiscussionWriteRejected | DiscussionWriteUncertain> {
    const { thread, token } = yield* readThread(input.thread)
    const current = resolution(thread.status)

    if (thread.isDeleted || current._tag === 'Unknown')
      return yield* new DiscussionWriteRejected({ reason: 'missing-thread' })
    const desired = input.desired === 'resolved' ? 'Resolved' : 'Open'

    if (current._tag === desired)
      return ProviderReceipt.make({ _tag: 'Resolution', thread: input.thread, resolution: current })

    if (current._tag !== input.expected._tag || current.detail !== input.expected.detail)
      return yield* new DiscussionWriteRejected({ reason: 'conflict' })

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'PATCH',
        url: `${endpoint}/${input.thread.discussion.pullRequestId}/threads/${input.thread.id}?api-version=7.1`,
        token,
        headers: {},
        body: { status: input.desired === 'resolved' ? 'fixed' : 'active' },
      }),
    )

    const returned = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ id: Id, status: Schema.Union([Schema.String, Schema.Int]) }),
    )(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    const state = resolution(returned.status)

    if (String(returned.id) !== input.thread.id || state._tag !== desired)
      return yield* new DiscussionWriteUncertain({ reason: 'invalid-response' })

    return ProviderReceipt.make({ _tag: 'Resolution', thread: input.thread, resolution: state })
  })

  return ProviderDiscussion.of({ read, checkCreate, create, reply, setResolution })
}

function place(review: DiscussionReview, thread: Thread, proof: Evidence): AnchorEvidence {
  const context = thread.threadContext
  const pr = thread.pullRequestThreadContext

  if (!context) return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'file-level' })

  if (proof.iteration === undefined)
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'different-comparison' })

  if (!pr?.changeTrackingId || !pr.iterationContext)
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'legacy-azure-context' })

  const matches = (pair: Schema.Schema.Type<typeof Pair> | null | undefined) =>
    pair !== null &&
    pair !== undefined &&
    pair.firstComparingIteration === proof.iteration &&
    pair.secondComparingIteration === proof.iteration

  let selected = context

  if (!matches(pr.trackingCriteria)) {
    if (!matches(pr.iterationContext))
      return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'different-comparison' })

    if (pr.trackingCriteria) {
      if (!pr.trackingCriteria.origFilePath)
        return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'missing-path' })
      selected = {
        filePath: pr.trackingCriteria.origFilePath,
        leftFileStart: pr.trackingCriteria.origLeftFileStart,
        leftFileEnd: pr.trackingCriteria.origLeftFileEnd,
        rightFileStart: pr.trackingCriteria.origRightFileStart,
        rightFileEnd: pr.trackingCriteria.origRightFileEnd,
      }
    }
  }

  if (
    (selected.leftFileStart || selected.leftFileEnd) &&
    (selected.rightFileStart || selected.rightFileEnd)
  )
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'unsupported-range' })
  const side = selected.rightFileStart ? 'head' : 'base'
  const start = side === 'head' ? selected.rightFileStart : selected.leftFileStart
  const end = side === 'head' ? selected.rightFileEnd : selected.leftFileEnd

  if (!start || !end) return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'invalid-location' })

  if (start.offset !== 0 || end.offset !== 0)
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'unsupported-range' })
  const path = selected.filePath.replace(/^\//, '')
  const changes = proof.changes.filter((change) => change.changeTrackingId === pr.changeTrackingId)
  const entry = changes[0]

  const files = review.review.files.filter(
    (change) => (side === 'head' ? change.path : (change.previousPath ?? change.path)) === path,
  )

  const change = files[0]

  if (
    !change ||
    files.length !== 1 ||
    changes.length !== 1 ||
    !entry ||
    entry.item.path.replace(/^\//, '') !== change.path ||
    (side === 'base' &&
      change.previousPath !== undefined &&
      entry.originalPath?.replace(/^\//, '') !== change.previousPath)
  )
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'missing-path' })

  const anchor = Schema.decodeUnknownOption(CodeAnchor)({
    comparison: review.comparison,
    change,
    side,
    path,
    commit: side === 'head' ? review.review.headCommit : review.review.baseCommit,
    range: { start: start.line, end: end.line },
  })

  return AnchorEvidence.make(
    Option.isSome(anchor)
      ? { _tag: 'Exact', anchor: anchor.value, outdated: false }
      : { _tag: 'Unplaced', reason: 'invalid-location' },
  )
}
