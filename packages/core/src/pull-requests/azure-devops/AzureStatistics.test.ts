import { createHash } from 'node:crypto'

import { expect, it } from '@effect/vitest'
import { Effect, Option, Redacted, Result, Schema } from 'effect'

import { type ProviderRepository, ProviderUnavailable } from '../GitHostingProvider'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { makeAzureDevOpsHttp } from './AzureDevOpsHttp'

const source = 'a'.repeat(40)

const target = 'b'.repeat(40)

const base = 'c'.repeat(40)

const contentResponse = (url: string, content: string) => {
  const request = new URL(url)
  const encoded = Buffer.from(content, 'utf8')

  return Effect.succeed({
    body: {
      path: request.searchParams.get('path'),
      commitId: request.searchParams.get('versionDescriptor.version'),
      objectId: createHash('sha1')
        .update(`blob ${encoded.byteLength}\0`)
        .update(encoded)
        .digest('hex'),
      gitObjectType: 'blob',
      content,
      contentMetadata: { encoding: 65001, isBinary: false },
    },
    headers: {},
  })
}

const metadata = {
  pullRequestId: 1,
  title: 'Feature',
  description: 'Description',
  status: 'active',
  sourceRefName: 'refs/heads/topic',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: source },
  lastMergeTargetCommit: { commitId: target },
}

const iteration = {
  id: 3,
  sourceRefCommit: { commitId: source },
  targetRefCommit: { commitId: target },
  commonRefCommit: { commitId: base },
}

const textFile = (path: string, originalPath = path) => ({
  path,
  originalPath,
  lineDiffBlocks: [
    { changeType: 'none', originalLinesCount: 50, modifiedLinesCount: 50 },
    { changeType: 'add', modifiedLinesCount: 3 },
    { changeType: 'delete', originalLinesCount: 2 },
    { changeType: 'edit', originalLinesCount: 4, modifiedLinesCount: 5 },
    { changeType: 'none', originalLinesCount: 10, modifiedLinesCount: 10 },
  ],
})

const make = Effect.fn('AzureStatisticsTest.make')(function* (
  http: Pick<ProviderHttp['Service'], 'get' | 'post'>,
) {
  const provider = yield* makeAzureDevOpsHttp.pipe(
    Effect.provideService(ProviderAuthentication, {
      session: () =>
        Effect.succeed(
          Option.some({ id: 'session', token: Redacted.make('secret'), account: Option.none() }),
        ),
    }),
    Effect.provideService(ProviderHttp, http),
  )

  return Option.getOrThrow(
    provider.recognizeRemote({
      name: 'origin',
      destination: 'https://dev.azure.com/org/project/_git/repo',
      transport: 'https',
      credentials: { _tag: 'NotApplicable' },
    }),
  )
})

const selected = Effect.fn('AzureStatisticsTest.selected')(function* (
  repository: ProviderRepository,
) {
  if (!repository.getPullRequestMetadata || !repository.getPullRequestStatistics)
    return yield* Effect.die('Missing statistics seam')
  const details = yield* repository.getPullRequestMetadata('1')

  return yield* repository.getPullRequestStatistics(details.pullRequest)
})

const get = (url: string) =>
  Effect.succeed({
    body: url.includes('/changes?')
      ? {
          changeEntries: [
            { item: { path: '/new' }, originalPath: '/old', changeType: 'rename, edit' },
          ],
          nextSkip: 0,
          nextTop: 0,
        }
      : url.includes('/iterations?')
        ? { value: [iteration] }
        : metadata,
    headers: {},
  })

it.effect(
  'publishes metadata without statistics and aggregates exact base/source rename blocks, caching only completed comparisons',
  () =>
    Effect.gen(function* () {
      const calls: string[] = []
      let posts = 0

      const repository = yield* make({
        get: (url) => {
          calls.push(url)

          return get(url)
        },
        post: (url, token, body) => {
          posts++
          expect(url).toContain('/fileDiffs?api-version=7.1-preview.1')
          expect(Option.isSome(token)).toBe(true)
          expect(body).toEqual({
            baseVersionCommit: base,
            targetVersionCommit: source,
            fileDiffParams: [{ path: '/new', originalPath: '/old' }],
          })

          return Effect.succeed({
            body: { count: 1, value: [textFile('/new', '/old')] },
            headers: {},
          })
        },
      })

      if (!repository.getPullRequestMetadata) return yield* Effect.die('Missing metadata seam')
      const details = yield* repository.getPullRequestMetadata('1')
      expect(details.description).toBe('Description')
      expect(calls).toHaveLength(1)
      expect(posts).toBe(0)
      const result = yield* selected(repository)
      expect(result.lines).toEqual({ _tag: 'Complete', additions: 8, deletions: 6 })
      expect(result.comparison).toMatchObject({
        baseRevision: base,
        sourceRevision: source,
        targetRevision: target,
        mode: 'merge-base-v1',
      })
      yield* selected(repository)
      expect(posts).toBe(1)
      expect(calls.filter((url) => url.includes('/changes?'))).toHaveLength(1)
    }),
)

for (const { name, body } of [
  { name: 'omitted file', body: { count: 0, value: [] } },
  { name: 'missing blocks', body: { count: 1, value: [{ path: '/new', originalPath: '/old' }] } },
  {
    name: 'empty blocks',
    body: { count: 1, value: [{ path: '/new', originalPath: '/old', lineDiffBlocks: [] }] },
  },
])
  it.effect(`keeps ${name} unavailable and retryable instead of zero`, () =>
    Effect.gen(function* () {
      let posts = 0

      const repository = yield* make({
        get,
        post: () => {
          posts++

          return Effect.succeed({ body, headers: {} })
        },
      })

      const first = yield* selected(repository)
      expect(first.lines).toEqual({ _tag: 'Unavailable', reason: 'incomplete-response' })
      expect(first.filesChanged).toEqual(Option.some(1))
      yield* selected(repository)
      expect(posts).toBe(2)
    }),
  )

for (const block of [
  { changeType: 'other', originalLinesCount: 0, modifiedLinesCount: 0 },
  { changeType: 'edit', originalLinesCount: -1, modifiedLinesCount: 0 },
  { changeType: 'add', modifiedLinesCount: 0.5 },
  { changeType: 'delete' },
  { changeType: 'add', modifiedLinesCount: Number.MAX_SAFE_INTEGER + 1 },
])
  it.effect(`rejects invalid line block ${JSON.stringify(block)}`, () =>
    Effect.gen(function* () {
      const repository = yield* make({
        get,
        post: () =>
          Effect.succeed({
            body: {
              count: 1,
              value: [{ path: '/new', originalPath: '/old', lineDiffBlocks: [block] }],
            },
            headers: {},
          }),
      })

      expect(yield* selected(repository).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidProviderResponse' },
      })
    }),
  )

it.effect('rejects sum overflow, duplicate files, and mismatched paths', () =>
  Effect.gen(function* () {
    for (const value of [
      [
        {
          path: '/new',
          originalPath: '/old',
          lineDiffBlocks: [
            { changeType: 'add', modifiedLinesCount: Number.MAX_SAFE_INTEGER },
            { changeType: 'add', modifiedLinesCount: 1 },
          ],
        },
      ],
      [textFile('/unexpected')],
    ]) {
      const repository = yield* make({
        get,
        post: () => Effect.succeed({ body: { count: 1, value }, headers: {} }),
      })

      expect(yield* selected(repository).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidProviderResponse' },
      })
    }
  }),
)

it.effect('rejects iteration movement before requesting changed paths or blocks', () =>
  Effect.gen(function* () {
    const repository = yield* make({
      get: (url) =>
        url.includes('/iterations?')
          ? Effect.succeed({
              body: { value: [{ ...iteration, sourceRefCommit: { commitId: 'd'.repeat(40) } }] },
              headers: {},
            })
          : get(url),
      post: () => Effect.die('Unexpected diff'),
    })

    expect(yield* selected(repository).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ComparisonChanged' },
    })
  }),
)

it.effect(
  'accepts a verified empty comparison without a POST and preserves provider failures',
  () =>
    Effect.gen(function* () {
      const empty = yield* make({
        get: (url) =>
          url.includes('/changes?')
            ? Effect.succeed({ body: { changeEntries: [], nextSkip: 0, nextTop: 0 }, headers: {} })
            : get(url),
        post: () => Effect.die('Unexpected diff'),
      })

      expect((yield* selected(empty)).lines).toEqual({
        _tag: 'Complete',
        additions: 0,
        deletions: 0,
      })
      const failed = yield* make({ get, post: () => Effect.fail(new ProviderUnavailable()) })
      const result = yield* selected(failed).pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure._tag).toBe('ProviderUnavailable')
    }),
)

it.effect(
  'pages the whole comparison, batches at ten, and uses empty sides for added and deleted files',
  () =>
    Effect.gen(function* () {
      const sizes: number[] = []

      const changes = [
        { changeType: 'add', item: { path: '/added' } },
        { changeType: 'delete', item: { path: '/deleted' } },
        ...Array.from({ length: 11 }, (_, index) => ({
          changeType: 'edit',
          item: { path: `/file-${index}` },
        })),
      ]

      const repository = yield* make({
        get: (url) =>
          url.includes('/items?')
            ? contentResponse(url, 'line\n')
            : url.includes('/changes?')
              ? Effect.succeed({
                  body: url.includes('$skip=0')
                    ? { changeEntries: changes.slice(0, 2), nextSkip: 2, nextTop: 2000 }
                    : { changeEntries: changes.slice(2), nextSkip: 0, nextTop: 0 },
                  headers: {},
                })
              : get(url),
        post: (_url, _token, body) => {
          const criteria = Schema.decodeUnknownSync(
            Schema.Struct({
              fileDiffParams: Schema.Array(
                Schema.Struct({ path: Schema.String, originalPath: Schema.String }),
              ),
            }),
          )(body)

          sizes.push(criteria.fileDiffParams.length)

          if (sizes.length === 1)
            expect(criteria.fileDiffParams.slice(0, 2)).toEqual([
              { path: '/added', originalPath: '' },
              { path: '', originalPath: '/deleted' },
            ])

          return Effect.succeed({
            body: {
              count: criteria.fileDiffParams.length,
              value: criteria.fileDiffParams.map((file) => textFile(file.path, file.originalPath)),
            },
            headers: {},
          })
        },
      })

      const result = yield* selected(repository)
      expect(result.filesChanged).toEqual(Option.some(13))
      expect(result.lines).toEqual({ _tag: 'Complete', additions: 89, deletions: 67 })
      expect(sizes).toEqual([10, 3])
    }),
)

it.effect('rejects ambiguous pagination, duplicates and unmatched response files', () =>
  Effect.gen(function* () {
    const invalidPaging = yield* make({
      get: (url) =>
        url.includes('/changes?')
          ? Effect.succeed({
              body: {
                changeEntries: [{ item: { path: '/new' }, changeType: 'edit' }],
                nextSkip: 100,
                nextTop: 2000,
              },
              headers: {},
            })
          : get(url),
      post: () => Effect.die('Unexpected diff'),
    })

    expect(yield* selected(invalidPaging).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidProviderResponse' },
    })

    const duplicate = yield* make({
      get,
      post: () =>
        Effect.succeed({
          body: { count: 2, value: [textFile('/new', '/old'), textFile('/new', '/old')] },
          headers: {},
        }),
    })

    expect(yield* selected(duplicate).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidProviderResponse' },
    })
  }),
)

it.effect('does not silently discard an unfamiliar partial-response signal', () =>
  Effect.gen(function* () {
    const repository = yield* make({
      get,
      post: () =>
        Effect.succeed({
          body: { count: 1, value: [{ ...textFile('/new', '/old'), isTruncated: true }] },
          headers: {},
        }),
    })

    expect(yield* selected(repository).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidProviderResponse' },
    })
  }),
)

it.effect(
  'confirms an added empty file through its exact blob even when diff blocks are omitted',
  () =>
    Effect.gen(function* () {
      const repository = yield* make({
        get: (url) =>
          url.includes('/items?')
            ? contentResponse(url, '')
            : url.includes('/changes?')
              ? Effect.succeed({
                  body: {
                    changeEntries: [{ changeType: 'add', item: { path: '/new' } }],
                    nextSkip: 0,
                    nextTop: 0,
                  },
                  headers: {},
                })
              : get(url),
        post: () =>
          Effect.succeed({
            body: { count: 1, value: [{ path: '/new', originalPath: '' }] },
            headers: {},
          }),
      })

      expect((yield* selected(repository)).lines).toEqual({
        _tag: 'Complete',
        additions: 0,
        deletions: 0,
      })
    }),
)

it.effect(
  'does not publish or cache partial totals when ambiguous content fails blob verification',
  () =>
    Effect.gen(function* () {
      let posts = 0
      let reads = 0

      const repository = yield* make({
        get: (url) => {
          if (url.includes('/items?')) {
            reads++

            return Effect.succeed({
              body: {
                path: '/new',
                commitId: source,
                objectId: 'e'.repeat(40),
                gitObjectType: 'blob',
                content: 'line\n',
                contentMetadata: { encoding: 65001, isBinary: false },
              },
              headers: {},
            })
          }

          return url.includes('/changes?')
            ? Effect.succeed({
                body: {
                  changeEntries: [{ changeType: 'add', item: { path: '/new' } }],
                  nextSkip: 0,
                  nextTop: 0,
                },
                headers: {},
              })
            : get(url)
        },
        post: () => {
          posts++

          return Effect.succeed({
            body: {
              count: 1,
              value: [
                {
                  path: '/new',
                  originalPath: '',
                  lineDiffBlocks: [{ changeType: 'add', modifiedLinesCount: 2 }],
                },
              ],
            },
            headers: {},
          })
        },
      })

      const first = yield* selected(repository)
      expect(first.filesChanged).toEqual(Option.some(1))
      expect(first.lines).toEqual({ _tag: 'Unavailable', reason: 'incomplete-response' })
      yield* selected(repository)
      expect(posts).toBe(2)
      expect(reads).toBe(2)
    }),
)

for (const fixture of [
  {
    name: 'added file with trailing newline',
    change: 'add',
    path: '/new',
    originalPath: '',
    blocks: [{ changeType: 'add', modifiedLinesCount: 69 }],
    original: '',
    modified: 'line\n'.repeat(68),
    additions: 68,
    deletions: 0,
  },
  {
    name: 'added file without trailing newline',
    change: 'add',
    path: '/new',
    originalPath: '',
    blocks: [{ changeType: 'add', modifiedLinesCount: 68 }],
    original: '',
    modified: 'line\n'.repeat(67) + 'last',
    additions: 68,
    deletions: 0,
  },
  {
    name: 'deleted file with trailing newline',
    change: 'delete',
    path: '',
    originalPath: '/new',
    blocks: [{ changeType: 'delete', originalLinesCount: 69 }],
    original: 'line\n'.repeat(68),
    modified: '',
    additions: 0,
    deletions: 68,
  },
  {
    name: 'deleted file without trailing newline',
    change: 'delete',
    path: '',
    originalPath: '/new',
    blocks: [{ changeType: 'delete', originalLinesCount: 68 }],
    original: 'line\n'.repeat(67) + 'last',
    modified: '',
    additions: 0,
    deletions: 68,
  },
  {
    name: 'edited EOF',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [{ changeType: 'edit', modifiedLinesCount: 2, originalLinesCount: 2 }],
    original: 'prefix\nold\n',
    modified: 'prefix\nnew\n',
    additions: 1,
    deletions: 1,
  },
  {
    name: 'added terminal newline',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [
      { changeType: 'none', originalLinesCount: 68, modifiedLinesCount: 68 },
      { changeType: 'add', modifiedLinesCount: 1 },
    ],
    original: 'line',
    modified: 'line\n',
    additions: 1,
    deletions: 1,
  },
  {
    name: 'removed terminal newline',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [
      { changeType: 'none', originalLinesCount: 68, modifiedLinesCount: 68 },
      { changeType: 'delete', originalLinesCount: 1 },
    ],
    original: 'line\n',
    modified: 'line',
    additions: 1,
    deletions: 1,
  },
  {
    name: 'ambiguous empty edit block',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [{ changeType: 'edit', originalLinesCount: 0, modifiedLinesCount: 0 }],
    original: '',
    modified: '',
    additions: 0,
    deletions: 0,
  },
  {
    name: 'empty added file',
    change: 'add',
    path: '/new',
    originalPath: '',
    blocks: [],
    original: '',
    modified: '',
    additions: 0,
    deletions: 0,
  },
  {
    name: 'empty deleted file',
    change: 'delete',
    path: '',
    originalPath: '/new',
    blocks: [],
    original: '',
    modified: '',
    additions: 0,
    deletions: 0,
  },
  {
    name: 'CRLF addition',
    change: 'add',
    path: '/new',
    originalPath: '',
    blocks: [{ changeType: 'add', modifiedLinesCount: 3 }],
    original: '',
    modified: 'a\r\nb\r\n',
    additions: 2,
    deletions: 0,
  },
  {
    name: 'CRLF to LF edit',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [{ changeType: 'edit', originalLinesCount: 3, modifiedLinesCount: 3 }],
    original: 'a\r\nb\r\n',
    modified: 'a\nb\n',
    additions: 2,
    deletions: 2,
  },
  {
    name: 'EOF edit without newline',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [{ changeType: 'edit', originalLinesCount: 1, modifiedLinesCount: 1 }],
    original: 'prefix\nold',
    modified: 'prefix\nnew',
    additions: 1,
    deletions: 1,
  },
  {
    name: 'one blank added line',
    change: 'add',
    path: '/new',
    originalPath: '',
    blocks: [{ changeType: 'add', modifiedLinesCount: 2 }],
    original: '',
    modified: '\n',
    additions: 1,
    deletions: 0,
  },
  {
    name: 'empty file gains newline',
    change: 'edit',
    path: '/new',
    originalPath: '/new',
    blocks: [{ changeType: 'add', modifiedLinesCount: 1 }],
    original: '',
    modified: '\n',
    additions: 1,
    deletions: 0,
  },
])
  it.effect(
    `counts ${fixture.name} using bounded immutable content instead of phantom segments`,
    () =>
      Effect.gen(function* () {
        let posts = 0
        const contentRequests: string[] = []

        const repository = yield* make({
          get: (url, token, _headers, _format, maxResponseBytes) => {
            if (url.includes('/items?')) {
              contentRequests.push(url)
              expect(Option.isSome(token)).toBe(true)
              expect(maxResponseBytes).toBe(512 * 1024)
              const request = new URL(url)
              expect(request.searchParams.get('versionDescriptor.versionType')).toBe('commit')
              const revision = request.searchParams.get('versionDescriptor.version')
              expect([base, source]).toContain(revision)
              expect(request.searchParams.get('path')).toBe(
                revision === base ? fixture.originalPath : fixture.path,
              )

              return contentResponse(url, revision === base ? fixture.original : fixture.modified)
            }

            return url.includes('/changes?')
              ? Effect.succeed({
                  body: {
                    changeEntries: [{ changeType: fixture.change, item: { path: '/new' } }],
                    nextSkip: 0,
                    nextTop: 0,
                  },
                  headers: {},
                })
              : get(url)
          },
          post: (_url, _token, body) => {
            posts++
            expect(body).toMatchObject({
              fileDiffParams: [{ path: fixture.path, originalPath: fixture.originalPath }],
            })

            return Effect.succeed({
              body: {
                count: 1,
                value: [
                  {
                    path: fixture.path,
                    originalPath: fixture.originalPath,
                    lineDiffBlocks: fixture.blocks,
                  },
                ],
              },
              headers: {},
            })
          },
        })

        const result = yield* selected(repository)
        expect(result.filesChanged).toEqual(Option.some(1))
        expect(result.lines).toEqual({
          _tag: 'Complete',
          additions: fixture.additions,
          deletions: fixture.deletions,
        })
        yield* selected(repository)
        expect(posts).toBe(1)
        expect(contentRequests).toHaveLength(fixture.change === 'edit' ? 2 : 1)
      }),
  )

it.effect(
  'does not fetch fork diff blocks and keeps unsupported statistics distinct from authentication',
  () =>
    Effect.gen(function* () {
      const repository = yield* make({
        get: (url) =>
          url.includes('/iterations?')
            ? get(url)
            : Effect.succeed({
                body: {
                  ...metadata,
                  forkSource: { repository: { name: 'fork', project: { name: 'project' } } },
                },
                headers: {},
              }),
        post: () => Effect.die('Unexpected fork diff'),
      })

      expect((yield* selected(repository)).lines).toEqual({
        _tag: 'Unavailable',
        reason: 'unsupported-comparison',
      })
    }),
)
