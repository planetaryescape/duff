import { Effect, Option, type Redacted, Schema } from 'effect'

import { anchorMatchesReview } from '../../review/DiscussionPlacement'
import {
  AnchorEvidence,
  Availability,
  CodeAnchor,
  type CreateThreadInput,
  DiscussionSnapshot,
  type DiscussionReview,
  DiscussionWriteRejected,
  DiscussionWriteUncertain,
  ProviderDiscussion,
  ProviderReceipt,
  DiscussionComment,
  type ReplyInput,
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

const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.NonEmptyString),
})

const Comment = Schema.Struct({
  id: Schema.NonEmptyString,
  fullDatabaseId: Schema.NullOr(
    Schema.Union([
      Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
      Schema.Int.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
    ]),
  ),
  body: Schema.String,
  createdAt: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  commit: Schema.NullOr(Schema.Struct({ oid: Revision })),
  pullRequestReview: Schema.NullOr(Schema.Struct({ state: Schema.String })),
  replyTo: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString })),
})

const Comments = Schema.Struct({ nodes: Schema.Array(Comment), pageInfo: PageInfo })

const Thread = Schema.Struct({
  id: Schema.NonEmptyString,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  startLine: Schema.NullOr(Schema.Int),
  diffSide: Schema.String,
  startDiffSide: Schema.NullOr(Schema.String),
  isOutdated: Schema.Boolean,
  isResolved: Schema.Boolean,
  viewerCanReply: Schema.Boolean,
  viewerCanResolve: Schema.Boolean,
  viewerCanUnresolve: Schema.Boolean,
  comments: Comments,
})

type Thread = Schema.Schema.Type<typeof Thread>

const Pull = Schema.Struct({
  number: Schema.Int,
  headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
  headRefOid: Revision,
  baseRefOid: Revision,
  reviewThreads: Schema.Struct({ nodes: Schema.Array(Thread), pageInfo: PageInfo }),
})

const PullResult = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({ nameWithOwner: Schema.String, pullRequest: Pull }),
  }),
})

const BoundThread = Schema.Struct({
  ...Thread.fields,
  pullRequest: Schema.Struct({
    number: Schema.Int,
    repository: Schema.Struct({ nameWithOwner: Schema.String }),
  }),
})

const NodeResult = Schema.Struct({ data: Schema.Struct({ node: Schema.NullOr(BoundThread) }) })

const commentFields =
  'id fullDatabaseId body createdAt author { login } commit { oid } pullRequestReview { state } replyTo { id }'

const threadFields = `id path line startLine diffSide startDiffSide isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:${discussionPolicy.pageSize}) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }`

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'Duff',
}

const allowed = (value: boolean): Availability =>
  Availability.make(value ? { _tag: 'Allowed' } : { _tag: 'Unavailable', reason: 'permission' })

const RestComment = Schema.Struct({
  id: Schema.Union([
    Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ]),
  path: Schema.optionalKey(Schema.String),
  side: Schema.optionalKey(Schema.String),
  original_line: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  original_commit_id: Schema.optionalKey(Revision),
})

export const makeGitHubDiscussion = (
  repository: RepositoryIdentity,
  http: ProviderHttp['Service'],
  session: () => Effect.Effect<Option.Option<Redacted.Redacted>, DiscoveryError>,
): ProviderDiscussion => {
  const api = `https://api.github.com/repos/${repository.key}/pulls`
  const [owner, name] = repository.key.split('/')

  const check = (key: ThreadKey['discussion']) =>
    boundDiscussion(key, 'github', 'github.com', repository.key)

  const query = Effect.fn('GitHubDiscussion.query')(function* (body: Schema.Json) {
    const token = yield* session()

    return yield* http.post('https://api.github.com/graphql', token, body)
  })

  const readThread = Effect.fn('GitHubDiscussion.readThread')(function* (key: ThreadKey) {
    if (!check(key.discussion)) return yield* new InvalidProviderResponse()

    const response = yield* query({
      query: `query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread { ${threadFields} pullRequest { number repository { nameWithOwner } } } } }`,
      variables: { id: key.id },
    })

    const result = yield* decodeDiscussion(NodeResult)(response)
    const thread = result.data.node

    if (
      !thread ||
      thread.id !== key.id ||
      String(thread.pullRequest.number) !== key.discussion.pullRequestId ||
      thread.pullRequest.repository.nameWithOwner.toLowerCase() !== repository.key
    )
      return yield* new InvalidProviderResponse()

    return thread
  })

  const receipt = Effect.fn('GitHubDiscussion.commentReceipt')(function* (
    result: Schema.Schema.Type<typeof RestComment>,
    thread: Option.Option<ThreadKey>,
    anchor?: CodeAnchor,
  ): Effect.fn.Return<ProviderReceipt, DiscussionWriteUncertain> {
    return ProviderReceipt.make({
      _tag: 'Comment',
      commentId: String(result.id),
      thread,
      providerPage: Option.none(),
      placement:
        anchor &&
        result.path === anchor.path &&
        result.side === 'RIGHT' &&
        result.original_line === anchor.range.start &&
        result.original_commit_id === anchor.commit
          ? 'verified'
          : 'unverified',
    })
  })

  const read = Effect.fn('GitHubDiscussion.read')(
    function* (review: DiscussionReview) {
      if (!check(review.key)) return yield* new InvalidProviderResponse()
      const token = yield* session()
      const budget = yield* makeDiscussionBudget(http, token)
      const threads: DiscussionSnapshot['threads'][number][] = []
      const ids = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | null = null
      let total = 0
      let completeness: DiscussionSnapshot['completeness'] = { _tag: 'Complete' }
      let revisions: string | undefined
      let exact = false

      const queryPage = Effect.fn('GitHubDiscussion.threadPage')(function* (after: string | null) {
        const response = yield* budget.post('https://api.github.com/graphql', {
          query: `query($owner:String!,$name:String!,$number:Int!,$after:String){ repository(owner:$owner,name:$name){ nameWithOwner pullRequest(number:$number){ number headRefOid baseRefOid headRepository { nameWithOwner } reviewThreads(first:${discussionPolicy.pageSize},after:$after){ nodes { ${threadFields} } pageInfo { hasNextPage endCursor } } } } }`,
          variables: {
            owner: owner ?? '',
            name: name ?? '',
            number: Number(review.key.pullRequestId),
            after,
          },
        })

        const result = yield* decodeDiscussion(PullResult)(response)
        const pull = result.data.repository.pullRequest

        if (
          result.data.repository.nameWithOwner.toLowerCase() !== repository.key ||
          String(pull.number) !== review.key.pullRequestId
        )
          return yield* new InvalidProviderResponse()
        const pair = `${pull.baseRefOid}:${pull.headRefOid}:${pull.headRepository?.nameWithOwner.toLowerCase() ?? ''}`

        if (revisions !== undefined && revisions !== pair)
          return yield* new InvalidProviderResponse()
        revisions = pair
        exact =
          pull.baseRefOid === review.comparison.targetRevision &&
          pull.headRefOid === review.comparison.sourceRevision &&
          pull.headRepository?.nameWithOwner.toLowerCase() ===
            review.comparison.sourceRepository.key &&
          review.comparison.sourceRepository.authority === 'github.com'

        return pull.reviewThreads
      })

      while (true) {
        const page: Schema.Schema.Type<typeof Pull>['reviewThreads'] = yield* queryPage(cursor)

        if (page.nodes.length > discussionPolicy.pageSize)
          return yield* new InvalidProviderResponse()

        for (const raw of page.nodes) {
          if (ids.has(raw.id)) continue

          if (threads.length >= discussionPolicy.threads || total >= discussionPolicy.comments) {
            completeness = {
              _tag: 'Limited',
              reason: threads.length >= discussionPolicy.threads ? 'threads' : 'comments',
            }
            break
          }

          ids.add(raw.id)

          const comments = [
            ...new Map(raw.comments.nodes.map((comment) => [comment.id, comment])).values(),
          ]

          if (raw.comments.nodes.length > discussionPolicy.pageSize)
            return yield* new InvalidProviderResponse()
          const seenComments = new Set(comments.map((comment) => comment.id))
          const seen = new Set<string>()
          let info = raw.comments.pageInfo

          while (
            info.hasNextPage &&
            comments.length < discussionPolicy.commentsPerThread &&
            total + comments.length < discussionPolicy.comments
          ) {
            if (budget.available() <= 1) {
              completeness = { _tag: 'Limited', reason: 'requests' }
              break
            }

            if (info.endCursor === null || seen.has(info.endCursor))
              return yield* new InvalidProviderResponse()
            seen.add(info.endCursor)

            const response = yield* budget.post('https://api.github.com/graphql', {
              query: `query($id:ID!,$after:String!){ node(id:$id){ ... on PullRequestReviewThread { id pullRequest { number repository { nameWithOwner } } comments(first:${discussionPolicy.pageSize},after:$after){ nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } } }`,
              variables: { id: raw.id, after: info.endCursor },
            })

            const result = yield* decodeDiscussion(
              Schema.Struct({
                data: Schema.Struct({
                  node: Schema.Struct({
                    id: Schema.String,
                    pullRequest: BoundThread.fields.pullRequest,
                    comments: Comments,
                  }),
                }),
              }),
            )(response)

            const node = result.data.node

            if (
              node.id !== raw.id ||
              String(node.pullRequest.number) !== review.key.pullRequestId ||
              node.pullRequest.repository.nameWithOwner.toLowerCase() !== repository.key ||
              node.comments.nodes.length > discussionPolicy.pageSize
            )
              return yield* new InvalidProviderResponse()

            for (const comment of node.comments.nodes)
              if (!seenComments.has(comment.id)) {
                seenComments.add(comment.id)
                comments.push(comment)
              }

            info = node.comments.pageInfo
          }

          const remaining = Math.min(
            discussionPolicy.commentsPerThread,
            discussionPolicy.comments - total,
          )

          const selected = comments.slice(0, remaining)
          const complete = !info.hasNextPage && selected.length === comments.length

          if (!complete && completeness._tag === 'Complete')
            completeness = { _tag: 'Limited', reason: 'comments' }
          total += selected.length
          const root = selected.find((comment) => comment.replyTo === null)
          const pending = root?.pullRequestReview?.state === 'PENDING'
          const key = { discussion: review.key, id: ThreadId.make(raw.id) }
          threads.push({
            key,
            comments: selected.map((comment) =>
              DiscussionComment.make({
                publication:
                  comment.pullRequestReview?.state === 'PENDING' ? 'pending' : 'published',
                id: comment.id,
                author: comment.author?.login ?? 'Deleted user',
                body: comment.body,
                publishedAt: comment.createdAt,
                deleted: false,
              }),
            ),
            commentsComplete: complete,
            resolution: raw.isResolved
              ? { _tag: 'Resolved', detail: 'resolved' }
              : { _tag: 'Open', detail: 'unresolved' },
            anchor: place(review, raw, exact, root?.commit?.oid),
            reply: allowed(raw.viewerCanReply && !!root?.fullDatabaseId && !pending),
            resolve: allowed(raw.viewerCanResolve && !pending),
            reopen: allowed(raw.viewerCanUnresolve && !pending),
            providerPage: Option.some(
              `https://github.com/${repository.key}/pull/${review.key.pullRequestId}`,
            ),
          })
        }

        if (
          !page.pageInfo.hasNextPage ||
          threads.length >= discussionPolicy.threads ||
          total >= discussionPolicy.comments
        ) {
          if (page.pageInfo.hasNextPage && completeness._tag === 'Complete')
            completeness = { _tag: 'Limited', reason: 'threads' }
          break
        }

        const next: string | null = page.pageInfo.endCursor

        if (budget.available() <= 1) {
          completeness = { _tag: 'Limited', reason: 'requests' }
          break
        }

        if (next === null || cursors.has(next)) return yield* new InvalidProviderResponse()
        cursors.add(next)
        cursor = next
      }

      yield* queryPage(null)

      return DiscussionSnapshot.make({ key: review.key, threads, completeness })
    },
    Effect.timeoutOrElse({
      duration: discussionPolicy.refreshTimeout,
      orElse: () => Effect.fail(new InvalidProviderResponse()),
    }),
  )

  const prepareCreate = Effect.fn('GitHubDiscussion.prepareCreate')(function* (
    review: DiscussionReview,
    anchor: CodeAnchor,
  ) {
    if (
      !check(review.key) ||
      !anchorMatchesReview(review, anchor) ||
      anchor.side !== 'head' ||
      anchor.range.start !== anchor.range.end ||
      anchor.commit !== review.comparison.sourceRevision
    )
      return yield* new DiscussionWriteRejected({ reason: 'unsupported-anchor' })
    const token = yield* session().pipe(Effect.mapError(preflightFailure))

    if (Option.isNone(token))
      return yield* new DiscussionWriteRejected({ reason: 'authentication' })

    const response = yield* http
      .get(`${api}/${review.key.pullRequestId}`, token, headers)
      .pipe(Effect.mapError(preflightFailure))

    const pull = yield* decodeDiscussion(
      Schema.Struct({
        number: Schema.Int,
        head: Schema.Struct({
          sha: Revision,
          repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
        }),
        base: Schema.Struct({ sha: Revision, repo: Schema.Struct({ full_name: Schema.String }) }),
      }),
    )(response).pipe(Effect.mapError(preflightFailure))

    if (
      String(pull.number) !== review.key.pullRequestId ||
      pull.base.repo.full_name.toLowerCase() !== repository.key ||
      pull.head.sha !== review.comparison.sourceRevision ||
      pull.head.repo?.full_name.toLowerCase() !== review.comparison.sourceRepository.key ||
      review.comparison.sourceRepository.authority !== 'github.com' ||
      pull.base.sha !== review.comparison.targetRevision
    )
      return yield* new DiscussionWriteRejected({ reason: 'comparison-changed' })

    return token
  })

  const checkCreate = Effect.fn('GitHubDiscussion.checkCreate')(
    (review: DiscussionReview, anchor: CodeAnchor) =>
      prepareCreate(review, anchor).pipe(Effect.asVoid),
  )

  const create = Effect.fn('GitHubDiscussion.create')(function* (input: CreateThreadInput) {
    const { anchor, review } = input

    if (!validDiscussionBody(input.body))
      return yield* new DiscussionWriteRejected({ reason: 'invalid-body' })
    const token = yield* prepareCreate(review, anchor)

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'POST',
        url: `${api}/${review.key.pullRequestId}/comments`,
        token,
        headers,
        body: {
          body: input.body,
          commit_id: anchor.commit,
          path: anchor.path,
          line: anchor.range.start,
          side: 'RIGHT',
        },
      }),
    )

    const decoded = yield* Schema.decodeUnknownEffect(RestComment)(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    return yield* receipt(decoded, Option.none(), anchor)
  })

  const reply = Effect.fn('GitHubDiscussion.reply')(function* (input: ReplyInput) {
    if (!validDiscussionBody(input.body))
      return yield* new DiscussionWriteRejected({ reason: 'invalid-body' })
    const thread = yield* readThread(input.thread).pipe(Effect.mapError(preflightFailure))
    const root = thread.comments.nodes.find((comment) => comment.replyTo === null)

    if (
      !thread.viewerCanReply ||
      !root?.fullDatabaseId ||
      root.pullRequestReview?.state === 'PENDING'
    )
      return yield* new DiscussionWriteRejected({ reason: 'permission' })
    const token = yield* session().pipe(Effect.mapError(preflightFailure))

    if (Option.isNone(token))
      return yield* new DiscussionWriteRejected({ reason: 'authentication' })

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'POST',
        url: `${api}/${input.thread.discussion.pullRequestId}/comments/${root.fullDatabaseId}/replies`,
        token,
        headers,
        body: { body: input.body },
      }),
    )

    const decoded = yield* Schema.decodeUnknownEffect(RestComment)(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    return yield* receipt(decoded, Option.some(input.thread))
  })

  const setResolution = Effect.fn('GitHubDiscussion.setResolution')(function* (
    input: ResolutionInput,
  ): Effect.fn.Return<ProviderReceipt, DiscussionWriteRejected | DiscussionWriteUncertain> {
    const thread = yield* readThread(input.thread).pipe(Effect.mapError(preflightFailure))
    const desired = input.desired === 'resolved'

    const root = thread.comments.nodes.find((comment) => comment.replyTo === null)

    if (root?.pullRequestReview?.state === 'PENDING')
      return yield* new DiscussionWriteRejected({ reason: 'permission' })

    if (thread.isResolved === desired)
      return ProviderReceipt.make({
        _tag: 'Resolution',
        thread: input.thread,
        resolution: thread.isResolved
          ? { _tag: 'Resolved', detail: 'resolved' }
          : { _tag: 'Open', detail: 'unresolved' },
      })

    if (
      (input.expected._tag === 'Resolved') !== thread.isResolved ||
      input.expected._tag === 'Unknown'
    )
      return yield* new DiscussionWriteRejected({ reason: 'conflict' })

    if (!(desired ? thread.viewerCanResolve : thread.viewerCanUnresolve))
      return yield* new DiscussionWriteRejected({ reason: 'permission' })
    const token = yield* session().pipe(Effect.mapError(preflightFailure))

    if (Option.isNone(token))
      return yield* new DiscussionWriteRejected({ reason: 'authentication' })
    const operation = desired ? 'resolveReviewThread' : 'unresolveReviewThread'

    const body = yield* mutationBody(
      yield* http.mutate({
        method: 'POST',
        url: 'https://api.github.com/graphql',
        token,
        headers,
        body: {
          query: `mutation($id:ID!,$attempt:String!){ ${operation}(input:{threadId:$id,clientMutationId:$attempt}){ clientMutationId thread { id isResolved pullRequest { number repository { nameWithOwner } } } } }`,
          variables: { id: input.thread.id, attempt: input.attempt },
        },
      }),
    )

    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.Struct({
          [operation]: Schema.Struct({
            clientMutationId: Schema.String,
            thread: Schema.Struct({
              id: Schema.String,
              isResolved: Schema.Boolean,
              pullRequest: BoundThread.fields.pullRequest,
            }),
          }),
        }),
      }),
    )(body).pipe(
      Effect.mapError(() => new DiscussionWriteUncertain({ reason: 'invalid-response' })),
    )

    const returned = result.data[operation]

    if (
      !returned ||
      returned.clientMutationId !== input.attempt ||
      returned.thread.id !== input.thread.id ||
      returned.thread.isResolved !== desired ||
      String(returned.thread.pullRequest.number) !== input.thread.discussion.pullRequestId ||
      returned.thread.pullRequest.repository.nameWithOwner.toLowerCase() !== repository.key
    )
      return yield* new DiscussionWriteUncertain({ reason: 'invalid-response' })

    return ProviderReceipt.make({
      _tag: 'Resolution',
      thread: input.thread,
      resolution: desired
        ? { _tag: 'Resolved', detail: 'resolved' }
        : { _tag: 'Open', detail: 'unresolved' },
    })
  })

  return ProviderDiscussion.of({ read, checkCreate, create, reply, setResolution })
}

function place(
  review: DiscussionReview,
  thread: Thread,
  exact: boolean,
  commit: string | undefined,
): AnchorEvidence {
  if (thread.isOutdated) return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'outdated' })

  if (!exact) return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'different-comparison' })

  if (commit !== review.comparison.sourceRevision)
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'missing-revision' })

  if (thread.line === null) return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'file-level' })

  if (
    !['LEFT', 'RIGHT'].includes(thread.diffSide) ||
    (thread.startLine !== null && thread.startDiffSide !== thread.diffSide)
  )
    return AnchorEvidence.make({ _tag: 'Unplaced', reason: 'unsupported-range' })
  const side = thread.diffSide === 'RIGHT' ? 'head' : 'base'

  const changes = review.review.files.filter(
    (change) =>
      (side === 'head' ? change.path : (change.previousPath ?? change.path)) === thread.path ||
      change.path === thread.path,
  )

  const change = changes[0]

  if (changes.length !== 1 || !change)
    return AnchorEvidence.make({
      _tag: 'Unplaced',
      reason: changes.length > 1 ? 'ambiguous-rename' : 'missing-path',
    })

  const anchor = Schema.decodeUnknownOption(CodeAnchor)({
    comparison: review.comparison,
    change,
    side,
    path: side === 'head' ? change.path : (change.previousPath ?? change.path),
    commit: side === 'head' ? review.review.headCommit : review.review.baseCommit,
    range: { start: thread.startLine ?? thread.line, end: thread.line },
  })

  return AnchorEvidence.make(
    Option.isSome(anchor)
      ? { _tag: 'Exact', anchor: anchor.value, outdated: false }
      : { _tag: 'Unplaced', reason: 'invalid-location' },
  )
}
