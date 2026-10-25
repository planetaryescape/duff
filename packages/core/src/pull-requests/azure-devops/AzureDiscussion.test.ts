import { expect, it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'

import { AttemptId, ThreadId } from '../Discussion'
import {
  type MutationRequest,
  MutationHttpResult,
  type ProviderHttp,
  ProviderResponse,
} from '../ProviderHttp'
import { anchorFixture, discussionFixture } from '../testing/DiscussionFixtures'
import { makeAzureDiscussion } from './AzureDiscussion'

const review = discussionFixture('azure-devops')

const endpoint = 'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullrequests'

const key = { discussion: review.key, id: ThreadId.make('10') }

const position = { line: 1, offset: 0 }

const iteration = {
  id: 3,
  sourceRefCommit: { commitId: review.comparison.sourceRevision },
  targetRefCommit: { commitId: review.comparison.targetRevision },
  commonRefCommit: { commitId: review.comparison.baseRevision },
}

const thread = (status: string | number = 'active') => ({
  id: 10,
  status,
  comments: [
    {
      id: 1,
      parentCommentId: 0,
      content: 'root',
      publishedDate: '2026-10-25',
      commentType: 'text',
    },
  ],
  threadContext: { filePath: '/file.ts', rightFileStart: position, rightFileEnd: position },
  pullRequestThreadContext: {
    changeTrackingId: 7,
    iterationContext: { firstComparingIteration: 3, secondComparingIteration: 3 },
  },
})

const unexpected = () => Effect.die('Unexpected request')

const make = (http: ProviderHttp['Service']) =>
  makeAzureDiscussion(
    review.key.repository,
    endpoint,
    'https://dev.azure.com/org/project/_git/repo',
    http,
    () => Effect.succeed(Option.some(Redacted.make('test-token'))),
  )

const response = (body: ProviderResponse['body']) =>
  Effect.succeed(ProviderResponse.make({ body, headers: {} }))

it.effect('uses the exact retained iteration and pages advancing change evidence', () =>
  Effect.gen(function* () {
    const urls: string[] = []

    const adapter = make({
      post: unexpected,
      mutate: unexpected,
      get: (url) => {
        urls.push(url)

        if (url.includes('/iterations?'))
          return response({
            value: [
              iteration,
              { ...iteration, id: 4, sourceRefCommit: { commitId: 'd'.repeat(40) } },
            ],
          })

        if (url.includes('$skip=0'))
          return response({ changeEntries: [], nextSkip: 100, nextTop: 100 })

        if (url.includes('$skip=100'))
          return response({
            changeEntries: [{ changeTrackingId: 7, item: { path: '/file.ts' } }],
            nextSkip: 0,
            nextTop: 0,
          })

        return response({
          value: [
            thread('pending'),
            { ...thread('wontFix'), id: 11 },
            { ...thread('new-status'), id: 12 },
          ],
        })
      },
    })

    const snapshot = yield* adapter.read(review)
    expect(
      snapshot.threads.every((value) =>
        value.comments.every((comment) => comment.publication === 'published'),
      ),
    ).toBe(true)
    expect(snapshot.threads[0]?.anchor._tag).toBe('Exact')
    expect(snapshot.threads.map((value) => value.resolution)).toEqual([
      { _tag: 'Open', detail: 'pending' },
      { _tag: 'Resolved', detail: 'wontFix' },
      { _tag: 'Unknown' },
    ])
    expect(snapshot.threads[2]?.resolve._tag).toBe('Unavailable')
    expect(urls[3]).toContain('$iteration=3&$baseIteration=3')
    expect(urls[1]).toContain('/iterations/3/changes?$compareTo=0&$top=100&$skip=0')
  }),
)

it.effect('never reads latest tracked positions into an old comparison', () =>
  Effect.gen(function* () {
    const adapter = make({
      post: unexpected,
      mutate: unexpected,
      get: (url) => {
        if (url.includes('/iterations?'))
          return response({
            value: [{ ...iteration, commonRefCommit: { commitId: 'd'.repeat(40) } }],
          })

        return response({ value: [thread()] })
      },
    })

    const snapshot = yield* adapter.read(review)
    expect(snapshot.threads[0]?.anchor).toEqual({
      _tag: 'Unplaced',
      reason: 'different-comparison',
    })
    expect(snapshot.threads[0]?.comments[0]?.body).toBe('root')
  }),
)

it.effect('creates a whole-line base thread with the proven iteration and change-tracking ID', () =>
  Effect.gen(function* () {
    const writes: MutationRequest[] = []

    const adapter = make({
      post: unexpected,
      get: (url) =>
        url.includes('/iterations?')
          ? response({ value: [iteration] })
          : response({
              changeEntries: [{ changeTrackingId: 7, item: { path: '/file.ts' } }],
              nextSkip: 0,
              nextTop: 0,
            }),
      mutate: (request) => {
        writes.push(request)

        return Effect.succeed(
          MutationHttpResult.make({
            _tag: 'Received',
            status: 201,
            body: {
              ...thread(),
              threadContext: {
                filePath: '/file.ts',
                leftFileStart: position,
                leftFileEnd: position,
              },
            },
            headers: {},
          }),
        )
      },
    })

    expect(
      yield* adapter.create({
        attempt: AttemptId.make('create'),
        review,
        anchor: anchorFixture(review, 'base'),
        body: 'question',
      }),
    ).toMatchObject({ _tag: 'Comment', placement: 'verified' })
    expect(writes[0]?.body).toEqual({
      comments: [{ parentCommentId: 0, content: 'question', commentType: 1 }],
      status: 'active',
      threadContext: {
        filePath: '/file.ts',
        leftFileStart: { line: 1, offset: 0 },
        leftFileEnd: { line: 1, offset: 0 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 7,
        iterationContext: { firstComparingIteration: 3, secondComparingIteration: 3 },
      },
    })
    expect(writes).toHaveLength(1)
  }),
)

it.effect('fresh-checks replies and writes only status for resolve and reopen', () =>
  Effect.gen(function* () {
    const writes: MutationRequest[] = []
    let status = 'pending'

    const adapter = make({
      post: unexpected,
      get: () => response(thread(status)),
      mutate: (request) => {
        writes.push(request)

        if (request.method === 'POST')
          return Effect.succeed(
            MutationHttpResult.make({
              _tag: 'Received',
              status: 201,
              body: { id: 2, parentCommentId: 1, content: 'answer' },
              headers: {},
            }),
          )
        status = status === 'pending' ? 'fixed' : 'active'

        return Effect.succeed(
          MutationHttpResult.make({
            _tag: 'Received',
            status: 200,
            body: { id: 10, status },
            headers: {},
          }),
        )
      },
    })

    yield* adapter.reply({ attempt: AttemptId.make('reply'), thread: key, body: 'answer' })
    expect(writes[0]?.body).toEqual({ content: 'answer', parentCommentId: 1, commentType: 1 })
    expect(
      yield* adapter.setResolution({
        attempt: AttemptId.make('resolve'),
        thread: key,
        expected: { _tag: 'Open', detail: 'pending' },
        desired: 'resolved',
      }),
    ).toMatchObject({ _tag: 'Resolution', resolution: { _tag: 'Resolved', detail: 'fixed' } })
    expect(writes[1]?.body).toEqual({ status: 'fixed' })
    yield* adapter.setResolution({
      attempt: AttemptId.make('reopen'),
      thread: key,
      expected: { _tag: 'Resolved', detail: 'fixed' },
      desired: 'open',
    })
    expect(writes[2]?.body).toEqual({ status: 'active' })
    yield* adapter.setResolution({
      attempt: AttemptId.make('noop'),
      thread: key,
      expected: { _tag: 'Open', detail: 'active' },
      desired: 'open',
    })
    expect(writes).toHaveLength(3)
  }),
)

it.effect('rejects nonadvancing change pages rather than inventing complete evidence', () =>
  Effect.gen(function* () {
    const adapter = make({
      post: unexpected,
      mutate: unexpected,
      get: (url) =>
        url.includes('/iterations?')
          ? response({ value: [iteration] })
          : response({ changeEntries: [], nextSkip: 0, nextTop: 100 }),
    })

    expect((yield* adapter.read(review).pipe(Effect.flip))._tag).toBe('InvalidProviderResponse')
  }),
)
