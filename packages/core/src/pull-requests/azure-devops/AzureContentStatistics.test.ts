import { createHash } from 'node:crypto'

import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Redacted, Schema } from 'effect'

import { AuthenticationRequired, ComparisonIdentity } from '../GitHostingProvider'
import { type ProviderHttp } from '../ProviderHttp'
import { makeAzureContentStatistics } from './AzureContentStatistics'

const identity = { authority: 'dev.azure.com', key: 'org/project/repo', displayName: 'Repo' }

const comparison = ComparisonIdentity.make({
  providerId: 'azure-devops',
  authority: identity.authority,
  sourceRepository: identity,
  targetRepository: identity,
  pullRequestId: '1',
  baseRevision: 'a'.repeat(40),
  sourceRevision: 'b'.repeat(40),
  targetRevision: 'c'.repeat(40),
  mode: 'merge-base-v1',
})

const item = (content: string) => {
  const encoded = Buffer.from(content, 'utf8')

  return Schema.Struct({
    path: Schema.String,
    commitId: Schema.String,
    objectId: Schema.String,
    gitObjectType: Schema.String,
    content: Schema.String,
    contentMetadata: Schema.Struct({ encoding: Schema.Int, isBinary: Schema.Boolean }),
  }).make({
    path: '/file',
    commitId: comparison.sourceRevision,
    objectId: createHash('sha1')
      .update(`blob ${encoded.byteLength}\0`)
      .update(encoded)
      .digest('hex'),
    gitObjectType: 'blob',
    content,
    contentMetadata: { encoding: 65001, isBinary: false },
  })
}

const make = (get: ProviderHttp['Service']['get']) =>
  makeAzureContentStatistics(
    { get, post: () => Effect.die('Unexpected POST') },
    Option.some(Redacted.make('fixture-token')),
    'https://dev.azure.com/org/project/_apis/git/repositories/repo',
    comparison,
  )

for (const fixture of [
  {
    name: 'binary metadata',
    body: { ...item('text'), contentMetadata: { encoding: 65001, isBinary: true } },
    reason: 'binary-content',
  },
  { name: 'NUL content', body: item('a\0b'), reason: 'binary-content' },
  {
    name: 'unsupported encoding',
    body: { ...item('text'), contentMetadata: { encoding: 1200, isBinary: false } },
    reason: 'unsupported-comparison',
  },
  {
    name: 'non-ASCII legacy encoding',
    body: { ...item('é'), contentMetadata: { encoding: 1252, isBinary: false } },
    reason: 'unsupported-comparison',
  },
  {
    name: 'truncated flag',
    body: { ...item('text'), isTruncated: true },
    reason: 'incomplete-response',
  },
  {
    name: 'partial flag',
    body: { ...item('text'), isPartial: true },
    reason: 'incomplete-response',
  },
  {
    name: 'blob hash mismatch',
    body: { ...item('text'), objectId: 'd'.repeat(40) },
    reason: 'incomplete-response',
  },
  {
    name: 'per-file byte budget',
    body: item('x'.repeat(256 * 1024 + 1)),
    reason: 'work-limit-exceeded',
  },
  { name: 'line budget', body: item('x\n'.repeat(10_001)), reason: 'work-limit-exceeded' },
])
  it.effect(`leaves ${fixture.name} unavailable rather than caching partial content`, () =>
    Effect.gen(function* () {
      const count = yield* make(() => Effect.succeed({ body: fixture.body, headers: {} }))
      expect(yield* count({ path: '/file', originalPath: '' })).toEqual({
        _tag: 'Unavailable',
        reason: fixture.reason,
      })
    }),
  )

it.effect('accepts lossless ASCII legacy encoding and verified UTF-8 text', () =>
  Effect.gen(function* () {
    for (const body of [
      item('héllo\n'),
      { ...item('ascii\n'), contentMetadata: { encoding: 1252, isBinary: false } },
    ]) {
      const count = yield* make(() => Effect.succeed({ body, headers: {} }))
      expect(yield* count({ path: '/file', originalPath: '' })).toEqual({
        _tag: 'Complete',
        additions: 1,
        deletions: 0,
      })
    }
  }),
)

it.effect('accepts an independently verified empty blob without guessing its encoding', () =>
  Effect.gen(function* () {
    const empty = item('')

    const count = yield* make(() =>
      Effect.succeed({
        body: {
          path: empty.path,
          commitId: empty.commitId,
          objectId: empty.objectId,
          gitObjectType: empty.gitObjectType,
          content: '',
        },
        headers: {},
      }),
    )

    expect(yield* count({ path: '/file', originalPath: '' })).toEqual({
      _tag: 'Complete',
      additions: 0,
      deletions: 0,
    })
  }),
)

it.effect(
  'rejects mismatched immutable paths and commits and preserves authentication failure',
  () =>
    Effect.gen(function* () {
      for (const body of [
        { ...item('text'), path: '/another' },
        { ...item('text'), commitId: 'e'.repeat(40) },
      ]) {
        const count = yield* make(() => Effect.succeed({ body, headers: {} }))
        expect(yield* count({ path: '/file', originalPath: '' }).pipe(Effect.result)).toMatchObject(
          { _tag: 'Failure', failure: { _tag: 'InvalidProviderResponse' } },
        )
      }

      const count = yield* make(() => Effect.fail(new AuthenticationRequired()))
      expect(yield* count({ path: '/file', originalPath: '' }).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'AuthenticationRequired' },
      })
    }),
)

it.effect('caps requests and cumulative decoded bytes across one comparison', () =>
  Effect.gen(function* () {
    let requests = 0

    const requestBound = yield* make(() => {
      requests++

      return Effect.succeed({ body: item('line\n'), headers: {} })
    })

    for (let index = 0; index < 20; index++)
      yield* requestBound({ path: '/file', originalPath: '' })
    expect(yield* requestBound({ path: '/file', originalPath: '' })).toEqual({
      _tag: 'Unavailable',
      reason: 'work-limit-exceeded',
    })
    expect(requests).toBe(20)

    const byteBound = yield* make(() =>
      Effect.succeed({ body: item('x'.repeat(256 * 1024)), headers: {} }),
    )

    for (let index = 0; index < 8; index++) yield* byteBound({ path: '/file', originalPath: '' })
    expect(yield* byteBound({ path: '/file', originalPath: '' })).toEqual({
      _tag: 'Unavailable',
      reason: 'work-limit-exceeded',
    })
  }),
)

it.effect('caps edited-file diff work instead of returning a partial edit count', () =>
  Effect.gen(function* () {
    const count = yield* make((url) => {
      const original =
        new URL(url).searchParams.get('versionDescriptor.version') === comparison.baseRevision

      return Effect.succeed({
        body: {
          ...item(
            Array.from(
              { length: 600 },
              (_, index) => `${original ? 'old' : 'new'}-${index}\n`,
            ).join(''),
          ),
          commitId: original ? comparison.baseRevision : comparison.sourceRevision,
        },
        headers: {},
      })
    })

    expect(yield* count({ path: '/file', originalPath: '/file' })).toEqual({
      _tag: 'Unavailable',
      reason: 'work-limit-exceeded',
    })
  }),
)

it.effect('propagates caller interruption through an ambiguous-file content read', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()

    const count = yield* make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    )

    const pending = yield* count({ path: '/file', originalPath: '' }).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(pending)
    expect(yield* Deferred.isDone(interrupted)).toBe(true)
  }),
)
