import { expect, it } from '@effect/vitest'
import { Effect, Option, Redacted, type Schema } from 'effect'

import { AttemptId, ThreadId } from '../Discussion'
import {
  type MutationRequest,
  type ProviderHttp,
  ProviderResponse,
  MutationHttpResult,
} from '../ProviderHttp'
import { anchorFixture, discussionFixture } from '../testing/DiscussionFixtures'
import { makeGitHubDiscussion } from './GitHubDiscussion'

const review = discussionFixture()

const key = { discussion: review.key, id: ThreadId.make('thread-1') }

const comment = (id = 'root', databaseId = '9007199254740993123') => ({
  id,
  fullDatabaseId: databaseId,
  body: id,
  createdAt: '2026-10-25T00:00:00Z',
  author: null,
  commit: { oid: review.comparison.sourceRevision },
  pullRequestReview: { state: 'COMMENTED' },
  replyTo: id === 'root' ? null : { id: 'root' },
})

const info = (next: string | null = null) => ({ hasNextPage: next !== null, endCursor: next })

const thread = (id = 'thread-1') => ({
  id,
  path: 'file.ts',
  line: 1,
  startLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  isOutdated: false,
  isResolved: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: { nodes: [comment()], pageInfo: info() },
})

const pull = (nodes: ReadonlyArray<ReturnType<typeof thread>>, next: string | null = null) => ({
  data: {
    repository: {
      nameWithOwner: 'owner/repo',
      pullRequest: {
        number: 42,
        headRefOid: review.comparison.sourceRevision,
        headRepository: { nameWithOwner: 'owner/repo' },
        baseRefOid: review.comparison.targetRevision,
        reviewThreads: { nodes, pageInfo: info(next) },
      },
    },
  },
})

const bound = (value = thread(), number = 42) => ({
  data: {
    node: { ...value, pullRequest: { number, repository: { nameWithOwner: 'owner/repo' } } },
  },
})

const make = (http: ProviderHttp['Service']) =>
  makeGitHubDiscussion(review.key.repository, http, () =>
    Effect.succeed(Option.some(Redacted.make('test-token'))),
  )

const unexpected = () => Effect.die('Unexpected request')

it.effect('labels a pending root truthfully and keeps every thread write unavailable', () =>
  Effect.gen(function* () {
    const pendingThread = {
      ...thread(),
      viewerCanUnresolve: true,
      comments: {
        nodes: [{ ...comment(), pullRequestReview: { state: 'PENDING' } }],
        pageInfo: info(),
      },
    }

    const adapter = make({
      get: unexpected,
      mutate: unexpected,
      post: (_url, _token, body) =>
        Effect.succeed(
          ProviderResponse.make({
            body: JSON.stringify(body).includes('node(id:')
              ? bound(pendingThread)
              : pull([pendingThread]),
            headers: {},
          }),
        ),
    })

    const snapshot = yield* adapter.read(review)
    expect(snapshot.threads[0]?.comments[0]).toMatchObject({ id: 'root', publication: 'pending' })
    expect(snapshot.threads[0]?.reply._tag).toBe('Unavailable')
    expect(snapshot.threads[0]?.resolve._tag).toBe('Unavailable')
    expect(snapshot.threads[0]?.reopen._tag).toBe('Unavailable')
    expect(
      yield* adapter
        .reply({ attempt: AttemptId.make('reply-pending-root'), thread: key, body: 'reply' })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: 'permission' })
    expect(
      yield* adapter
        .setResolution({
          attempt: AttemptId.make('resolve-pending-root'),
          thread: key,
          expected: { _tag: 'Open', detail: 'unresolved' },
          desired: 'resolved',
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: 'permission' })
    expect(
      yield* adapter
        .setResolution({
          attempt: AttemptId.make('reopen-pending-root'),
          thread: key,
          expected: { _tag: 'Resolved', detail: 'resolved' },
          desired: 'open',
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: 'permission' })
  }),
)

it.effect(
  'labels a pending child without blocking writes to its published root or thread state',
  () =>
    Effect.gen(function* () {
      let resolved = false
      const writes: MutationRequest[] = []

      const currentThread = () => ({
        ...thread(),
        isResolved: resolved,
        viewerCanResolve: !resolved,
        viewerCanUnresolve: resolved,
        comments: {
          nodes: [
            comment(),
            { ...comment('pending-child', '2'), pullRequestReview: { state: 'PENDING' } },
          ],
          pageInfo: info(),
        },
      })

      const adapter = make({
        get: unexpected,
        post: (_url, _token, body) =>
          Effect.succeed(
            ProviderResponse.make({
              body: JSON.stringify(body).includes('node(id:')
                ? bound(currentThread())
                : pull([currentThread()]),
              headers: {},
            }),
          ),
        mutate: (request) => {
          writes.push(request)

          if (request.url !== 'https://api.github.com/graphql')
            return Effect.succeed(
              MutationHttpResult.make({
                _tag: 'Received',
                status: 201,
                body: { id: '124' },
                headers: {},
              }),
            )
          resolved = !resolved
          const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'

          return Effect.succeed(
            MutationHttpResult.make({
              _tag: 'Received',
              status: 200,
              body: {
                data: {
                  [operation]: {
                    clientMutationId: resolved ? 'resolve-pending-child' : 'reopen-pending-child',
                    thread: {
                      id: key.id,
                      isResolved: resolved,
                      pullRequest: { number: 42, repository: { nameWithOwner: 'owner/repo' } },
                    },
                  },
                },
              },
              headers: {},
            }),
          )
        },
      })

      const snapshot = yield* adapter.read(review)
      expect(snapshot.threads[0]?.comments.map((value) => value.publication)).toEqual([
        'published',
        'pending',
      ])
      expect(snapshot.threads[0]?.reply._tag).toBe('Allowed')
      expect(snapshot.threads[0]?.resolve._tag).toBe('Allowed')
      expect(
        yield* adapter.reply({
          attempt: AttemptId.make('reply-published-root'),
          thread: key,
          body: 'published reply',
        }),
      ).toMatchObject({ _tag: 'Comment', commentId: '124' })
      expect(writes[0]?.url).toBe(
        'https://api.github.com/repos/owner/repo/pulls/42/comments/9007199254740993123/replies',
      )
      expect(
        yield* adapter.setResolution({
          attempt: AttemptId.make('resolve-pending-child'),
          thread: key,
          expected: { _tag: 'Open', detail: 'unresolved' },
          desired: 'resolved',
        }),
      ).toMatchObject({ _tag: 'Resolution', resolution: { _tag: 'Resolved' } })
      expect(
        yield* adapter.setResolution({
          attempt: AttemptId.make('reopen-pending-child'),
          thread: key,
          expected: { _tag: 'Resolved', detail: 'resolved' },
          desired: 'open',
        }),
      ).toMatchObject({ _tag: 'Resolution', resolution: { _tag: 'Open' } })
      expect(writes).toHaveLength(3)
      expect(JSON.stringify(writes)).not.toContain('submitPullRequestReview')
      expect(JSON.stringify(writes)).not.toContain('pending-child/replies')
    }),
)

it.effect(
  'pages thread and child comment connections independently without losing roots or permissions',
  () =>
    Effect.gen(function* () {
      const requests: Schema.Json[] = []

      const adapter = make({
        get: unexpected,
        mutate: unexpected,
        post: (_url, _token, body) => {
          requests.push(body)

          if (requests.length === 1)
            return Effect.succeed(
              ProviderResponse.make({
                body: pull(
                  [{ ...thread(), comments: { nodes: [comment()], pageInfo: info('comments-2') } }],
                  'threads-2',
                ),
                headers: {},
              }),
            )

          if (requests.length === 2)
            return Effect.succeed(
              ProviderResponse.make({
                body: {
                  data: {
                    node: {
                      id: key.id,
                      pullRequest: { number: 42, repository: { nameWithOwner: 'owner/repo' } },
                      comments: { nodes: [comment('reply')], pageInfo: info() },
                    },
                  },
                },
                headers: {},
              }),
            )

          if (requests.length === 3)
            return Effect.succeed(
              ProviderResponse.make({
                body: pull([{ ...thread('thread-2'), isOutdated: true, viewerCanReply: false }]),
                headers: {},
              }),
            )

          return Effect.succeed(ProviderResponse.make({ body: pull([]), headers: {} }))
        },
      })

      const snapshot = yield* adapter.read(review)
      expect(snapshot.completeness).toEqual({ _tag: 'Complete' })
      expect(snapshot.threads).toHaveLength(2)
      expect(snapshot.threads[0]?.comments.map((value) => value.id)).toEqual(['root', 'reply'])
      expect(snapshot.threads[0]?.anchor._tag).toBe('Exact')
      expect(snapshot.threads[1]?.anchor).toEqual({ _tag: 'Unplaced', reason: 'outdated' })
      expect(snapshot.threads[1]?.reply._tag).toBe('Unavailable')
      expect(requests).toHaveLength(4)
    }),
)

it.effect('rejects repeated child cursors and cross-PR node identities', () =>
  Effect.gen(function* () {
    let count = 0

    const adapter = make({
      get: unexpected,
      mutate: unexpected,
      post: () => {
        count++

        return Effect.succeed(
          ProviderResponse.make({
            body:
              count === 1
                ? pull([
                    { ...thread(), comments: { nodes: [comment()], pageInfo: info('repeat') } },
                  ])
                : {
                    data: {
                      node: {
                        id: key.id,
                        pullRequest: { number: 42, repository: { nameWithOwner: 'owner/repo' } },
                        comments: { nodes: [], pageInfo: info('repeat') },
                      },
                    },
                  },
            headers: {},
          }),
        )
      },
    })

    expect((yield* adapter.read(review).pipe(Effect.flip))._tag).toBe('InvalidProviderResponse')
    expect(count).toBe(2)

    const wrong = make({
      get: unexpected,
      mutate: unexpected,
      post: () => Effect.succeed(ProviderResponse.make({ body: bound(thread(), 43), headers: {} })),
    })

    expect(
      yield* wrong
        .reply({ attempt: AttemptId.make('reply'), thread: key, body: 'hello' })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: 'DiscussionWriteRejected' })
  }),
)

it.effect(
  'pins REST creation to the displayed head and keeps contradictory placement as a receipt',
  () =>
    Effect.gen(function* () {
      const mutations: MutationRequest[] = []

      const adapter = make({
        post: unexpected,
        get: () =>
          Effect.succeed(
            ProviderResponse.make({
              body: {
                number: 42,
                head: { sha: review.comparison.sourceRevision, repo: { full_name: 'owner/repo' } },
                base: { sha: review.comparison.targetRevision, repo: { full_name: 'owner/repo' } },
              },
              headers: {},
            }),
          ),
        mutate: (request) => {
          mutations.push(request)

          return Effect.succeed(
            MutationHttpResult.make({
              _tag: 'Received',
              status: 201,
              body: {
                id: '123',
                path: 'other.ts',
                side: 'RIGHT',
                original_line: 1,
                original_commit_id: review.comparison.sourceRevision,
              },
              headers: {},
            }),
          )
        },
      })

      const input = {
        attempt: AttemptId.make('create'),
        review,
        anchor: anchorFixture(review),
        body: 'hello',
      }

      expect(yield* adapter.create(input)).toMatchObject({
        _tag: 'Comment',
        commentId: '123',
        placement: 'unverified',
      })
      expect(mutations[0]?.body).toEqual({
        body: 'hello',
        commit_id: review.comparison.sourceRevision,
        path: 'file.ts',
        line: 1,
        side: 'RIGHT',
      })
      expect(
        yield* adapter
          .create({ ...input, anchor: anchorFixture(review, 'base') })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: 'unsupported-anchor' })
      expect(mutations).toHaveLength(1)
    }),
)

it.effect('replies to the top-level decimal REST ID without unsafe number conversion', () =>
  Effect.gen(function* () {
    const mutations: MutationRequest[] = []

    const adapter = make({
      get: unexpected,
      post: () => Effect.succeed(ProviderResponse.make({ body: bound(), headers: {} })),
      mutate: (request) => {
        mutations.push(request)

        return Effect.succeed(
          MutationHttpResult.make({
            _tag: 'Received',
            status: 201,
            body: { id: '124' },
            headers: {},
          }),
        )
      },
    })

    expect(
      yield* adapter.reply({ attempt: AttemptId.make('reply'), thread: key, body: 'answer' }),
    ).toMatchObject({ _tag: 'Comment', commentId: '124' })
    expect(mutations[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/pulls/42/comments/9007199254740993123/replies',
    )
    expect(mutations[0]?.body).toEqual({ body: 'answer' })
  }),
)

it.effect('does not mistake GraphQL error-only HTTP 200 for resolution success', () =>
  Effect.gen(function* () {
    const mutations: MutationRequest[] = []

    const adapter = make({
      get: unexpected,
      post: () => Effect.succeed(ProviderResponse.make({ body: bound(), headers: {} })),
      mutate: (request) => {
        mutations.push(request)

        return Effect.succeed(
          MutationHttpResult.make({
            _tag: 'Received',
            status: 200,
            body: { errors: [{ message: 'private failure' }] },
            headers: {},
          }),
        )
      },
    })

    const error = yield* adapter
      .setResolution({
        attempt: AttemptId.make('resolve'),
        thread: key,
        expected: { _tag: 'Open', detail: 'unresolved' },
        desired: 'resolved',
      })
      .pipe(Effect.flip)

    expect(error).toMatchObject({ _tag: 'DiscussionWriteUncertain' })
    expect(JSON.stringify(error)).not.toContain('private failure')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.body).toMatchObject({ variables: { id: key.id, attempt: 'resolve' } })
  }),
)

it.effect(
  'returns a visible request limit while reserving the final revision-consistency read',
  () =>
    Effect.gen(function* () {
      let calls = 0

      const adapter = make({
        get: unexpected,
        mutate: unexpected,
        post: () => {
          calls++

          if (calls === 1)
            return Effect.succeed(
              ProviderResponse.make({
                body: pull([
                  { ...thread(), comments: { nodes: [comment()], pageInfo: info('child-1') } },
                ]),
                headers: {},
              }),
            )

          if (calls === 100)
            return Effect.succeed(ProviderResponse.make({ body: pull([]), headers: {} }))

          return Effect.succeed(
            ProviderResponse.make({
              body: {
                data: {
                  node: {
                    id: key.id,
                    pullRequest: { number: 42, repository: { nameWithOwner: 'owner/repo' } },
                    comments: { nodes: [comment()], pageInfo: info(`child-${calls}`) },
                  },
                },
              },
              headers: {},
            }),
          )
        },
      })

      const snapshot = yield* adapter.read(review)
      expect(snapshot.completeness).toEqual({ _tag: 'Limited', reason: 'requests' })
      expect(snapshot.threads[0]?.commentsComplete).toBe(false)
      expect(snapshot.threads[0]?.comments).toHaveLength(1)
      expect(calls).toBe(100)
    }),
)

it.effect('checks creation capability without dispatch and rejects moved comparisons', () =>
  Effect.gen(function* () {
    let mutations = 0

    const adapter = make({
      post: unexpected,
      get: () =>
        Effect.succeed(
          ProviderResponse.make({
            body: {
              number: 42,
              head: { sha: 'd'.repeat(40), repo: { full_name: 'owner/repo' } },
              base: { sha: review.comparison.targetRevision, repo: { full_name: 'owner/repo' } },
            },
            headers: {},
          }),
        ),
      mutate: () => {
        mutations++

        return Effect.succeed(MutationHttpResult.make({ _tag: 'Uncertain', reason: 'transport' }))
      },
    })

    expect(
      yield* adapter.checkCreate(review, anchorFixture(review)).pipe(Effect.flip),
    ).toMatchObject({ reason: 'comparison-changed' })
    expect(mutations).toBe(0)
  }),
)

it.effect(
  'confirms exact resolve and reopen receipts but does not rewrite an already observed desired state',
  () =>
    Effect.gen(function* () {
      let resolved = false
      const writes: MutationRequest[] = []

      const adapter = make({
        get: unexpected,
        post: () =>
          Effect.succeed(
            ProviderResponse.make({
              body: bound({
                ...thread(),
                isResolved: resolved,
                viewerCanResolve: !resolved,
                viewerCanUnresolve: resolved,
              }),
              headers: {},
            }),
          ),
        mutate: (request) => {
          writes.push(request)
          resolved = !resolved
          const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'

          return Effect.succeed(
            MutationHttpResult.make({
              _tag: 'Received',
              status: 200,
              body: {
                data: {
                  [operation]: {
                    clientMutationId: resolved ? 'resolve' : 'reopen',
                    thread: {
                      id: key.id,
                      isResolved: resolved,
                      pullRequest: { number: 42, repository: { nameWithOwner: 'owner/repo' } },
                    },
                  },
                },
              },
              headers: {},
            }),
          )
        },
      })

      expect(
        yield* adapter.setResolution({
          attempt: AttemptId.make('resolve'),
          thread: key,
          expected: { _tag: 'Open', detail: 'unresolved' },
          desired: 'resolved',
        }),
      ).toMatchObject({ _tag: 'Resolution', resolution: { _tag: 'Resolved' } })
      yield* adapter.setResolution({
        attempt: AttemptId.make('already-resolved'),
        thread: key,
        expected: { _tag: 'Open', detail: 'unresolved' },
        desired: 'resolved',
      })
      expect(writes).toHaveLength(1)
      expect(
        yield* adapter.setResolution({
          attempt: AttemptId.make('reopen'),
          thread: key,
          expected: { _tag: 'Resolved', detail: 'resolved' },
          desired: 'open',
        }),
      ).toMatchObject({ _tag: 'Resolution', resolution: { _tag: 'Open' } })
      expect(writes).toHaveLength(2)
    }),
)
