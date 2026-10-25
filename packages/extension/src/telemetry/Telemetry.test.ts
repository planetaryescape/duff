import { ProviderRedirected } from '@duff/core/git-hosting-provider'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Ref, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { observabilityLayer, observeOperation } from './Telemetry'

const TracePayload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              traceId: Schema.String,
              spanId: Schema.String,
              parentSpanId: Schema.optional(Schema.String),
              status: Schema.Struct({ code: Schema.Number }),
            }),
          ),
        }),
      ),
    }),
  ),
})

const LogPayload = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(
        Schema.Struct({
          logRecords: Schema.Array(
            Schema.Struct({
              traceId: Schema.String,
              spanId: Schema.String,
              attributes: Schema.Array(
                Schema.Struct({
                  key: Schema.String,
                  value: Schema.Struct({ stringValue: Schema.String }),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
})

it.effect(
  'exports correlated outcomes and nested spans without private payloads or exception text',
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<Array<{ url: string; body: string }>>([])

      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.headers.authorization).toBe('Bearer canary-auth')

          if (request.body._tag !== 'Uint8Array')
            return yield* Effect.die('Expected JSON telemetry body')
          const body = new TextDecoder().decode(request.body.body)
          yield* Ref.update(deliveries, (entries) => [...entries, { url: request.url, body }])

          return HttpClientResponse.fromWeb(request, new Response('{}'))
        }),
      )

      const layer = observabilityLayer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer canary-auth',
            }),
          ),
        ),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = Effect.fn('GitContext.inspect')(function* () {
            yield* Effect.annotateCurrentSpan('private', 'canary-secret')

            return 'canary-secret'
          })

          expect(
            yield* observeOperation('Duff.inspectContext', child()).pipe(
              Effect.annotateLogs({ 'private.email': 'canary-secret' }),
            ),
          ).toBe('canary-secret')

          const failure = yield* observeOperation('Duff.compare', Effect.die('canary-secret')).pipe(
            Effect.exit,
          )

          expect(failure._tag).toBe('Failure')
          yield* observeOperation(
            'Duff.discoverProviders',
            Effect.succeed('canary-secret'),
            () => 'partial',
          )
          yield* Effect.logInfo('canary-secret')
        }).pipe(Effect.provide(layer)),
      )
      const sent = yield* Ref.get(deliveries)
      expect(sent.map(({ url }) => url)).toContain('https://otel.planetaryescape.co.za/v1/traces')
      expect(sent.map(({ url }) => url)).toContain('https://otel.planetaryescape.co.za/v1/logs')
      expect(JSON.stringify(sent)).not.toContain('canary-secret')
      expect(JSON.stringify(sent)).not.toContain('canary-auth')

      const traces = yield* Effect.forEach(
        sent.filter(({ url }) => url.endsWith('/traces')),
        ({ body }) => Schema.decodeUnknownEffect(Schema.fromJsonString(TracePayload))(body),
      )

      const spans = traces.flatMap((data) =>
        data.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      )

      const root = spans.find((span) => span.name === 'Duff.inspectContext')
      const child = spans.find((span) => span.name === 'GitContext.inspect')
      expect(root).toBeDefined()
      expect(child?.parentSpanId).toBe(root?.spanId)
      expect(spans.find((span) => span.name === 'Duff.compare')?.status.code).toBe(2)

      const logs = yield* Effect.forEach(
        sent.filter(({ url }) => url.endsWith('/logs')),
        ({ body }) => Schema.decodeUnknownEffect(Schema.fromJsonString(LogPayload))(body),
      )

      const records = logs.flatMap((data) =>
        data.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
        ),
      )

      expect(records).toHaveLength(3)
      expect(
        records.some((record) => record.traceId === root?.traceId && record.spanId === root.spanId),
      ).toBe(true)
      expect(
        records.flatMap((record) =>
          record.attributes.map((attribute) => attribute.value.stringValue),
        ),
      ).toContain('failure')
      expect(
        records.flatMap((record) =>
          record.attributes.map((attribute) => attribute.value.stringValue),
        ),
      ).toContain('partial')
    }),
)

it.effect(
  'exports local traces and correlated typed failures without forwarding remote credentials',
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<Array<{ url: string; body: string }>>([])

      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.headers.authorization).toBeUndefined()

          if (request.body._tag !== 'Uint8Array') return yield* Effect.die('Expected JSON body')
          const body = new TextDecoder().decode(request.body.body)
          yield* Ref.update(deliveries, (entries) => [...entries, { url: request.url, body }])

          return HttpClientResponse.fromWeb(request, new Response('{}'))
        }),
      )

      const layer = observabilityLayer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              DUFF_TELEMETRY: 'local',
              OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer canary-remote-credential',
            }),
          ),
        ),
      )

      yield* Effect.scoped(
        observeOperation(
          'Duff.loadDashboardPullRequests',
          Effect.fail(new ProviderRedirected()),
        ).pipe(Effect.exit, Effect.provide(layer)),
      )

      const sent = yield* Ref.get(deliveries)
      expect(sent.map(({ url }) => url)).toContain('http://127.0.0.1:14318/v1/traces')
      expect(sent.map(({ url }) => url)).toContain('http://127.0.0.1:14320/v1/logs')
      expect(JSON.stringify(sent)).toContain('ProviderRedirected')
      expect(JSON.stringify(sent)).toContain('error.type')
      expect(JSON.stringify(sent)).not.toContain('canary-remote-credential')
      expect(JSON.stringify(sent)).not.toContain('otel.planetaryescape')

      const traces = yield* Effect.forEach(
        sent.filter(({ url }) => url.endsWith('/traces')),
        ({ body }) => Schema.decodeUnknownEffect(Schema.fromJsonString(TracePayload))(body),
      )

      expect(
        traces.flatMap((data) =>
          data.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        ),
      ).toContainEqual(
        expect.objectContaining({ name: 'Duff.loadDashboardPullRequests', status: { code: 2 } }),
      )
    }),
)

it.effect('does not export when disabled, unconfigured, or given an invalid destination', () =>
  Effect.gen(function* () {
    for (const configuration of [
      {},
      { DUFF_TELEMETRY: 'off', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer canary' },
      { DUFF_TELEMETRY: 'https://untrusted.invalid' },
    ]) {
      const client = HttpClient.make(() => Effect.die('Unexpected telemetry request'))

      const layer = observabilityLayer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
      )

      yield* Effect.scoped(
        observeOperation('Duff.dashboard', Effect.void).pipe(Effect.provide(layer)),
      )
    }
  }),
)
