import { createHash } from 'node:crypto'

import { diffLines } from 'diff'
import { Effect, type Option, type Redacted, Schema } from 'effect'

import {
  ChangeStatistics,
  type ComparisonIdentity,
  InvalidProviderResponse,
} from '../GitHostingProvider'
import { type ProviderHttp } from '../ProviderHttp'

const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i))

const Item = Schema.Struct({
  path: Schema.NonEmptyString,
  commitId: Revision,
  objectId: Revision,
  gitObjectType: Schema.String,
  content: Schema.optionalKey(Schema.String),
  isTruncated: Schema.optionalKey(Schema.Boolean),
  truncated: Schema.optionalKey(Schema.Boolean),
  isPartial: Schema.optionalKey(Schema.Boolean),
  contentMetadata: Schema.optionalKey(
    Schema.Struct({
      encoding: Schema.optionalKey(Schema.Int),
      isBinary: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})

class AzureContentUnavailable extends Schema.TaggedError<AzureContentUnavailable>()(
  'AzureContentUnavailable',
  {
    reason: Schema.Literals([
      'binary-content',
      'incomplete-response',
      'unsupported-comparison',
      'work-limit-exceeded',
    ]),
  },
) {}

const physicalLines = (text: string) =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

export const makeAzureContentStatistics = Effect.fn('AzureDevOps.makeContentStatistics')(function* (
  http: ProviderHttp['Service'],
  token: Option.Option<Redacted.Redacted>,
  repositoryEndpoint: string,
  comparison: ComparisonIdentity,
) {
  let requests = 0
  let bytes = 0

  const read = Effect.fn('AzureDevOps.readStatisticsContent')(function* (
    path: string,
    revision: string,
  ) {
    if (path === '') return ''

    if (requests >= 20) return yield* new AzureContentUnavailable({ reason: 'work-limit-exceeded' })
    requests++
    const url = new URL(`${repositoryEndpoint}/items`)
    url.searchParams.set('path', path)
    url.searchParams.set('includeContent', 'true')
    url.searchParams.set('includeContentMetadata', 'true')
    url.searchParams.set('versionDescriptor.versionType', 'commit')
    url.searchParams.set('versionDescriptor.version', revision)
    url.searchParams.set('api-version', '7.1')
    const response = yield* http.get(url.toString(), token, {}, 'json', 512 * 1024)

    const item = yield* Schema.decodeUnknownEffect(Item)(response.body).pipe(
      Effect.mapError(() => new InvalidProviderResponse()),
    )

    if (item.path !== path || item.commitId !== revision)
      return yield* new InvalidProviderResponse()

    if (item.gitObjectType !== 'blob')
      return yield* new AzureContentUnavailable({ reason: 'unsupported-comparison' })

    if (item.contentMetadata?.isBinary)
      return yield* new AzureContentUnavailable({ reason: 'binary-content' })

    if (item.isTruncated || item.isPartial || item.truncated || item.content === undefined)
      return yield* new AzureContentUnavailable({ reason: 'incomplete-response' })
    const encoded = Buffer.from(item.content, 'utf8')
    bytes += encoded.byteLength

    if (
      encoded.byteLength > 256 * 1024 ||
      bytes > 2 * 1024 * 1024 ||
      physicalLines(item.content) > 10_000
    )
      return yield* new AzureContentUnavailable({ reason: 'work-limit-exceeded' })
    let ascii = true

    for (const character of item.content) {
      const code = character.charCodeAt(0)

      if (code < 32 && ![9, 10, 13].includes(code))
        return yield* new AzureContentUnavailable({ reason: 'binary-content' })

      if (code > 127) ascii = false
    }

    if (
      encoded.byteLength !== 0 &&
      item.contentMetadata?.encoding !== 65001 &&
      !([1252, 20127].includes(item.contentMetadata?.encoding ?? 0) && ascii)
    )
      return yield* new AzureContentUnavailable({ reason: 'unsupported-comparison' })

    const objectId = createHash(item.objectId.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${encoded.byteLength}\0`)
      .update(encoded)
      .digest('hex')

    if (objectId !== item.objectId.toLowerCase())
      return yield* new AzureContentUnavailable({ reason: 'incomplete-response' })

    return item.content
  })

  return Effect.fn('AzureDevOps.contentStatistics')(
    function* (paths: { readonly path: string; readonly originalPath: string }) {
      const original = yield* read(paths.originalPath, comparison.baseRevision)
      const modified = yield* read(paths.path, comparison.sourceRevision)

      if (paths.originalPath === '')
        return ChangeStatistics.fields.lines.make({
          _tag: 'Complete',
          additions: physicalLines(modified),
          deletions: 0,
        })

      if (paths.path === '')
        return ChangeStatistics.fields.lines.make({
          _tag: 'Complete',
          additions: 0,
          deletions: physicalLines(original),
        })

      const changes = diffLines(original, modified, {
        maxEditLength: 1000,
        timeout: 25,
        ignoreWhitespace: false,
        ignoreNewlineAtEof: false,
        stripTrailingCr: false,
        newlineIsToken: false,
      })

      if (changes === undefined)
        return yield* new AzureContentUnavailable({ reason: 'work-limit-exceeded' })
      let additions = 0
      let deletions = 0

      for (const change of changes) {
        if (change.added) additions += change.count

        if (change.removed) deletions += change.count
      }

      return ChangeStatistics.fields.lines.make({ _tag: 'Complete', additions, deletions })
    },
    Effect.catchTag('AzureContentUnavailable', (error) =>
      Effect.succeed(
        ChangeStatistics.fields.lines.make({ _tag: 'Unavailable', reason: error.reason }),
      ),
    ),
  )
})
