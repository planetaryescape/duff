import { CatalogError } from '@duff/core/dashboard-repositories'
import { GitContextError } from '@duff/core/git-context'
import { DiscoveryError } from '@duff/core/git-hosting-provider'
import { ReviewError } from '@duff/core/review'
import { ReviewStorageError } from '@duff/core/saved-reviews'
import { Cause, Config, Data, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { HttpBody } from 'effect/http'
import { OtlpLogger, OtlpSerialization, OtlpTracer } from 'effect/observability'

export type Operation =
  | 'Duff.inspectContext'
  | 'Duff.listBranches'
  | 'Duff.compare'
  | 'Duff.refresh'
  | 'Duff.readSnapshot'
  | 'Duff.discoverProviders'
  | 'Duff.loadMoreProviders'
  | 'Duff.connectProvider'
  | 'Duff.preparePullRequest'
  | 'Duff.dashboard'
  | 'Duff.prepareWorkspace'
  | 'Duff.loadDashboardPullRequests'

const OperationError = Schema.Union([
  DiscoveryError,
  CatalogError,
  GitContextError,
  ReviewError,
  ReviewStorageError,
])

const developmentResource = {
  serviceName: 'duff',
  attributes: { 'deployment.environment.name': 'development' },
}

const productionResource = {
  serviceName: 'duff',
  attributes: { 'deployment.environment.name': 'production' },
}

class ExportedResourceSpans extends Data.Class<OtlpTracer.ResourceSpan> {}

class ExportedScopeSpans extends Data.Class<OtlpTracer.ScopeSpan> {}

class ExportedSpan extends Data.Class<OtlpTracer.ScopeSpan['spans'][number]> {}

class ExportedResourceLogs extends Data.Class<OtlpLogger.LogsData['resourceLogs'][number]> {}

class ExportedScopeLogs extends Data.Class<
  OtlpLogger.LogsData['resourceLogs'][number]['scopeLogs'][number]
> {}

class ExportedLog extends Data.Class<
  NonNullable<
    OtlpLogger.LogsData['resourceLogs'][number]['scopeLogs'][number]['logRecords']
  >[number]
> {}

const serialization = Layer.succeed(
  OtlpSerialization.OtlpSerialization,
  OtlpSerialization.OtlpSerialization.of({
    traces: (data) =>
      HttpBody.jsonUnsafe({
        resourceSpans: data.resourceSpans.map(
          (resource) =>
            new ExportedResourceSpans({
              ...resource,
              scopeSpans: resource.scopeSpans.map(
                (scope) =>
                  new ExportedScopeSpans({
                    ...scope,
                    spans: scope.spans.map(
                      (span) =>
                        new ExportedSpan({
                          ...span,
                          attributes: [],
                          events: [],
                          links: [],
                          status: { code: span.status.code },
                        }),
                    ),
                  }),
              ),
            }),
        ),
      }),
    logs: (data) =>
      HttpBody.jsonUnsafe({
        resourceLogs: data.resourceLogs.map(
          (resource) =>
            new ExportedResourceLogs({
              ...resource,
              scopeLogs: resource.scopeLogs?.map(
                (scope) =>
                  new ExportedScopeLogs({
                    ...scope,
                    logRecords: scope.logRecords
                      ?.filter(
                        (record) =>
                          record.body?.stringValue === 'Operation completed' ||
                          record.body?.stringValue === 'Operation failed',
                      )
                      .map(
                        (record) =>
                          new ExportedLog({
                            ...record,
                            attributes: record.attributes?.filter(
                              (attribute) =>
                                attribute.key === 'operation' ||
                                attribute.key === 'outcome' ||
                                attribute.key === 'error.type',
                            ),
                          }),
                      ),
                  }),
              ),
            }),
        ),
      }),
    metrics: (data) => HttpBody.jsonUnsafe(data),
  }),
)

const localExport = (resource: typeof developmentResource) =>
  Layer.merge(
    OtlpTracer.layer({
      url: 'http://127.0.0.1:14318/v1/traces',
      resource,
    }),
    OtlpLogger.layer({ url: 'http://127.0.0.1:14320/v1/logs', resource }),
  ).pipe(Layer.provide(serialization))

export const installedObservabilityLayer = localExport(productionResource)

export const observabilityLayer = Layer.unwrap(
  Effect.gen(function* () {
    const destination = yield* Config.Literals(['local', 'hetzner', 'off'], 'DUFF_TELEMETRY').pipe(
      Config.withDefault('hetzner'),
    )

    if (destination === 'off') return Layer.empty

    if (destination === 'local') return localExport(developmentResource)

    const configured = yield* Config.option(Config.Redacted('OTEL_EXPORTER_OTLP_HEADERS'))

    if (Option.isNone(configured)) return Layer.empty

    const header = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^Authorization=Bearer [^\r\n,]+$/)),
    )(Redacted.value(configured.value))

    const headers = { Authorization: header.slice('Authorization='.length) }

    return Layer.merge(
      OtlpTracer.layer({
        url: 'https://otel.planetaryescape.co.za/v1/traces',
        headers,
        resource: developmentResource,
      }),
      OtlpLogger.layer({
        url: 'https://otel.planetaryescape.co.za/v1/logs',
        headers,
        resource: developmentResource,
      }),
    ).pipe(Layer.provide(serialization))
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning('Duff telemetry configuration is invalid; export is disabled.').pipe(
        Effect.as(Layer.empty),
      ),
    ),
  ),
)

export const observeOperation = <A, E, R>(
  operation: Operation,
  work: Effect.Effect<A, E, R>,
  summarize?: (value: A) => 'success' | 'partial',
) =>
  work.pipe(
    Effect.onExit((exit) => {
      const outcome =
        exit._tag === 'Success'
          ? (summarize?.(exit.value) ?? 'success')
          : Cause.hasInterruptsOnly(exit.cause)
            ? 'interrupted'
            : 'failure'

      const error =
        exit._tag === 'Failure'
          ? Option.flatMap(
              Cause.findErrorOption(exit.cause),
              Schema.decodeUnknownOption(OperationError),
            )
          : Option.none()

      const attributes =
        outcome === 'failure'
          ? {
              operation,
              outcome,
              'error.type': Option.isSome(error) ? error.value._tag : 'UnexpectedFailure',
            }
          : { operation, outcome }

      return (
        outcome === 'failure'
          ? Effect.logWarning('Operation failed')
          : Effect.logInfo('Operation completed')
      ).pipe(Effect.annotateLogs(attributes))
    }),
    Effect.withSpan(operation),
  )
