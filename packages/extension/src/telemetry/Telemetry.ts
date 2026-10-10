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

const resource = {
  serviceName: 'duff',
  attributes: { 'deployment.environment.name': 'development' },
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
                                attribute.key === 'operation' || attribute.key === 'outcome',
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

export const observabilityLayer = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.Redacted('OTEL_EXPORTER_OTLP_HEADERS'))

    if (Option.isNone(configured)) return Layer.empty

    const header = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^Authorization=Bearer [^\r\n,]+$/)),
    )(Redacted.value(configured.value))

    const headers = { Authorization: header.slice('Authorization='.length) }

    return Layer.merge(
      OtlpTracer.layer({ url: 'https://otel.planetaryescape.co.za/v1/traces', headers, resource }),
      OtlpLogger.layer({ url: 'https://otel.planetaryescape.co.za/v1/logs', headers, resource }),
    ).pipe(Layer.provide(serialization))
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning(
        'Duff telemetry authentication configuration is invalid; export is disabled.',
      ).pipe(Effect.as(Layer.empty)),
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

      return (
        outcome === 'failure'
          ? Effect.logWarning('Operation failed')
          : Effect.logInfo('Operation completed')
      ).pipe(Effect.annotateLogs({ operation, outcome }))
    }),
    Effect.withSpan(operation),
  )
