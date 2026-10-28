import { Effect, Option, type Redacted, Schema } from 'effect'

import {
  ChangeCount,
  ChangeStatistics,
  ComparisonChanged,
  ComparisonIdentity,
  InvalidProviderResponse,
  type OpenPullRequest,
} from '../GitHostingProvider'
import { type ProviderHttp } from '../ProviderHttp'
import { makeAzureContentStatistics } from './AzureContentStatistics'

const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i))

const Count = ChangeCount.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const Commit = Schema.Struct({ commitId: Revision })

const Iterations = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      sourceRefCommit: Commit,
      targetRefCommit: Commit,
      commonRefCommit: Commit,
    }),
  ),
})

const Changes = Schema.Struct({
  changeEntries: Schema.Array(
    Schema.Struct({
      item: Schema.Struct({
        path: Schema.NonEmptyString,
        isFolder: Schema.optionalKey(Schema.Boolean),
      }),
      originalPath: Schema.optionalKey(Schema.NonEmptyString),
      changeType: Schema.Literals([
        'add',
        'delete',
        'edit',
        'rename',
        'rename, edit',
        'edit, rename',
      ]),
    }),
  ),
  nextSkip: Schema.optionalKey(Count),
  nextTop: Schema.optionalKey(Count),
})

const CommitDiff = Schema.Struct({
  baseCommit: Revision,
  targetCommit: Revision,
  commonCommit: Revision,
  allChangesIncluded: Schema.optionalKey(Schema.Boolean),
  changes: Changes.fields.changeEntries,
})

const Block = Schema.Struct({
  changeType: Schema.Literals(['none', 'add', 'delete', 'edit', 0, 1, 2, 3]),
  originalLineNumberStart: Schema.optionalKey(Count),
  modifiedLineNumberStart: Schema.optionalKey(Count),
  originalLinesCount: Schema.optionalKey(Count),
  modifiedLinesCount: Schema.optionalKey(Count),
})

const FileDiffs = Schema.Struct({
  count: Count,
  value: Schema.Array(
    Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      originalPath: Schema.optionalKey(Schema.String),
      lineDiffBlocks: Schema.optionalKey(Schema.Array(Block)),
    }),
  ),
})

export const azureStatistics = Effect.fn('AzureDevOps.statistics')(function* (
  http: Pick<ProviderHttp['Service'], 'get' | 'post'>,
  token: Option.Option<Redacted.Redacted>,
  endpoint: string,
  expected: OpenPullRequest,
  completed: {
    readonly get: (comparison: ComparisonIdentity) => Effect.Effect<Option.Option<ChangeStatistics>>
    readonly set: (value: ChangeStatistics) => Effect.Effect<void>
  },
) {
  if (
    expected.source._tag !== 'Available' ||
    Option.isNone(expected.source.ref.revision) ||
    Option.isNone(expected.target.ref.revision)
  )
    return yield* new ComparisonChanged()
  const response = yield* http.get(`${endpoint}/${expected.id}/iterations?api-version=7.1`, token)

  const iterations = yield* Schema.decodeUnknownEffect(Iterations)(response.body).pipe(
    Effect.mapError(() => new InvalidProviderResponse()),
  )

  const sorted = [...iterations.value].sort((a, b) => b.id - a.id)
  const latest = sorted[0]

  if (!latest || new Set(sorted.map((item) => item.id)).size !== sorted.length)
    return yield* new InvalidProviderResponse()

  if (latest.sourceRefCommit.commitId !== expected.source.ref.revision.value)
    return yield* new ComparisonChanged()

  const sourceRevision = expected.source.ref.revision.value
  const targetRevision = expected.target.ref.revision.value
  const repositoryEndpoint = endpoint.slice(0, -'/pullrequests'.length)
  const advancedTarget = latest.targetRefCommit.commitId !== targetRevision

  const sameRepository =
    expected.source.repository.key === expected.target.repository.key &&
    expected.source.repository.authority === expected.target.repository.authority

  const exactDiff = Effect.fn('AzureDevOps.exactDiff')(function* (skip: number) {
    const response = yield* http.get(
      `${repositoryEndpoint}/diffs/commits?baseVersion=${targetRevision}&baseVersionType=commit&targetVersion=${sourceRevision}&targetVersionType=commit&diffCommonCommit=true&$top=2000&$skip=${skip}&api-version=7.1`,
      token,
    )

    const result = yield* Schema.decodeUnknownEffect(CommitDiff)(response.body).pipe(
      Effect.mapError(() => new InvalidProviderResponse()),
    )

    if (result.baseCommit !== targetRevision || result.targetCommit !== sourceRevision)
      return yield* new ComparisonChanged()

    return result
  })

  // An iteration can retain an older target. The pinned PR target needs its
  // own merge base and changed paths, not a relabelled iteration diff.
  const firstDiff = advancedTarget && sameRepository ? yield* exactDiff(0) : undefined

  const comparison = ComparisonIdentity.make({
    providerId: 'azure-devops',
    authority: expected.target.repository.authority,
    targetRepository: expected.target.repository,
    sourceRepository: expected.source.repository,
    pullRequestId: expected.id,
    targetRevision,
    sourceRevision,
    baseRevision: firstDiff?.commonCommit ?? latest.commonRefCommit.commitId,
    mode: 'merge-base-v1',
  })

  const cached = yield* completed.get(comparison)

  if (Option.isSome(cached)) return cached.value

  const unavailable = (
    reason: Extract<ChangeStatistics['lines'], { _tag: 'Unavailable' }>['reason'],
    filesChanged = Option.none<number>(),
  ): ChangeStatistics =>
    ChangeStatistics.make({
      comparison,
      filesChanged,
      lines: { _tag: 'Unavailable', reason },
    })

  if (!sameRepository) return unavailable('unsupported-comparison')
  const files: Array<{ readonly path: string; readonly originalPath: string }> = []
  const paths = new Set<string>()
  let skip = 0
  let top = 2000

  for (let page = 0; ; page++) {
    if (page >= 5) return unavailable('work-limit-exceeded')

    const exact = firstDiff ? (page === 0 ? firstDiff : yield* exactDiff(skip)) : undefined

    if (exact && exact.commonCommit !== comparison.baseRevision)
      return yield* new ComparisonChanged()

    const response = exact
      ? {
          body: {
            changeEntries: exact.changes,
            nextSkip: exact.allChangesIncluded ? 0 : skip + exact.changes.length,
            nextTop: exact.allChangesIncluded ? 0 : top,
          },
        }
      : yield* http.get(
          `${endpoint}/${expected.id}/iterations/${latest.id}/changes?$compareTo=0&$top=${top}&$skip=${skip}&api-version=7.1`,
          token,
        )

    const changes = yield* Schema.decodeUnknownEffect(Changes)(response.body).pipe(
      Effect.mapError(() => new InvalidProviderResponse()),
    )

    if (changes.changeEntries.length > top) return yield* new InvalidProviderResponse()

    for (const change of changes.changeEntries) {
      if (change.item.isFolder === true) continue

      if (paths.has(change.item.path)) return yield* new InvalidProviderResponse()
      paths.add(change.item.path)

      if (change.changeType.includes('rename') && change.originalPath === undefined)
        return yield* new InvalidProviderResponse()
      files.push({
        path: change.changeType === 'delete' ? '' : change.item.path,
        originalPath: change.changeType === 'add' ? '' : (change.originalPath ?? change.item.path),
      })
    }

    if (changes.nextSkip === 0 && changes.nextTop === 0) break

    if (
      changes.nextSkip === undefined &&
      changes.nextTop === undefined &&
      changes.changeEntries.length < top
    )
      break

    if (
      changes.nextSkip !== skip + changes.changeEntries.length ||
      changes.nextSkip <= skip ||
      changes.nextTop === undefined ||
      changes.nextTop === 0 ||
      changes.nextTop > 2000
    )
      return yield* new InvalidProviderResponse()
    skip = changes.nextSkip
    top = changes.nextTop
  }

  const filesChanged = Option.some(files.length)

  if (files.length > 200) return unavailable('work-limit-exceeded', filesChanged)

  let additions = 0
  let deletions = 0

  const contentStatistics = yield* makeAzureContentStatistics(
    http,
    token,
    endpoint.slice(0, -'/pullrequests'.length),
    comparison,
  )

  for (let offset = 0; offset < files.length; offset += 10) {
    const batch = files.slice(offset, offset + 10)

    const response = yield* http.post(
      `${endpoint.slice(0, -'/pullrequests'.length)}/fileDiffs?api-version=7.1-preview.1`,
      token,
      {
        baseVersionCommit: comparison.baseRevision,
        targetVersionCommit: comparison.sourceRevision,
        fileDiffParams: batch,
      },
    )

    const result = yield* Schema.decodeUnknownEffect(FileDiffs, { onExcessProperty: 'error' })(
      response.body,
    ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

    if (result.count !== result.value.length || result.value.length > batch.length)
      return yield* new InvalidProviderResponse()

    if (result.value.length !== batch.length)
      return unavailable('incomplete-response', filesChanged)
    const seen = new Set<string>()

    for (const file of result.value) {
      const fileKey = JSON.stringify([file.path ?? '', file.originalPath ?? ''])

      const requested = batch.find(
        (item) =>
          item.path === (file.path ?? '') && item.originalPath === (file.originalPath ?? ''),
      )

      if (!requested || seen.has(fileKey)) return yield* new InvalidProviderResponse()
      seen.add(fileKey)

      const blocks = file.lineDiffBlocks ?? []

      if (blocks.length === 0 && requested.path !== '' && requested.originalPath !== '')
        return unavailable('incomplete-response', filesChanged)

      let fileAdditions = 0
      let fileDeletions = 0

      for (const block of blocks) {
        const add = ['add', 'edit', 1, 3].includes(block.changeType)
        const del = ['delete', 'edit', 2, 3].includes(block.changeType)

        if (
          (add && block.modifiedLinesCount === undefined) ||
          (del && block.originalLinesCount === undefined)
        )
          return yield* new InvalidProviderResponse()
        fileAdditions += add ? (block.modifiedLinesCount ?? 0) : 0
        fileDeletions += del ? (block.originalLinesCount ?? 0) : 0

        if (!Number.isSafeInteger(fileAdditions) || !Number.isSafeInteger(fileDeletions))
          return yield* new InvalidProviderResponse()
      }

      const trailing = blocks[blocks.length - 1]

      if (
        requested.path === '' ||
        requested.originalPath === '' ||
        !trailing ||
        !['none', 0].includes(trailing.changeType) ||
        trailing.originalLinesCount === undefined ||
        trailing.originalLinesCount === 0 ||
        trailing.modifiedLinesCount !== trailing.originalLinesCount
      ) {
        const lines = yield* contentStatistics(requested)

        if (lines._tag === 'Unavailable') return unavailable(lines.reason, filesChanged)
        fileAdditions = lines.additions
        fileDeletions = lines.deletions
      }

      additions += fileAdditions
      deletions += fileDeletions

      if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions))
        return yield* new InvalidProviderResponse()
    }
  }

  const value = ChangeStatistics.make({
    comparison,
    filesChanged,
    lines: { _tag: 'Complete', additions, deletions },
  })

  yield* completed.set(value)

  return value
})
