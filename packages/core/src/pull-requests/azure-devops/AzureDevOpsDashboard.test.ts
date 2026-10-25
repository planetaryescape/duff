import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'

import { DashboardData } from '../../dashboard/DashboardData'
import {
  makeRepositoryDirectoryLayer,
  RepositoryDirectory,
} from '../../dashboard/RepositoryDirectory'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { makeAzureDevOpsHttp } from './AzureDevOpsHttp'

it.effect(
  'loads more cached Azure PRs after switching filters without invalidating either cursor',
  () =>
    Effect.gen(function* () {
      for (const state of ['closed', 'merged'] satisfies ReadonlyArray<'closed' | 'merged'>) {
        for (const count of [0, 50]) {
          const requests: string[] = []

          const provider = yield* makeAzureDevOpsHttp.pipe(
            Effect.provideService(ProviderAuthentication, {
              session: () =>
                Effect.succeed(
                  Option.some({
                    id: 'session',
                    account: Option.none(),
                    token: Redacted.make('test-token'),
                  }),
                ),
            }),
            Effect.provideService(ProviderHttp, {
              get: (url) =>
                Effect.sync(() => {
                  requests.push(url)
                  const query = new URL(url).searchParams
                  const status = query.get('searchCriteria.status')
                  const skip = query.get('$skip')
                  const size = skip === '50' ? 1 : status === 'active' ? 50 : count

                  return {
                    headers: {},
                    body: {
                      count: size,
                      value: Array.from({ length: size }, (_, index) => ({
                        pullRequestId: skip === '50' ? 51 : index + 1,
                        title: 'Feature',
                        status,
                        sourceRefName: 'refs/heads/feature',
                        targetRefName: 'refs/heads/main',
                      })),
                    },
                  }
                }),
              post: () => Effect.die('Unexpected POST'),
              mutate: () => Effect.die('Unexpected mutation'),
            }),
          )

          yield* Effect.gen(function* () {
            const directory = yield* RepositoryDirectory
            const data = yield* DashboardData

            const hosted = Option.getOrThrow(
              directory.recognize('https://dev.azure.com/acme/project/_git/repo'),
            )

            const first = yield* data.listVersioned(hosted, 'open')
            expect(first.page.items).toHaveLength(50)
            expect(Option.isSome(first.page.next)).toBe(true)
            const historical = yield* data.listVersioned(hosted, state)
            expect(historical.page.items).toHaveLength(count)
            const restored = yield* data.listVersioned(hosted, 'open')
            expect(restored).toBe(first)
            expect(requests).toHaveLength(2)

            expect(
              (yield* directory.list(hosted, state, restored.page.next).pipe(Effect.flip))._tag,
            ).toBe('InvalidContinuation')
            const next = yield* directory.list(hosted, 'open', restored.page.next)
            expect(next.items.map((pull) => [pull.id, pull.state])).toEqual([['51', 'open']])
            expect(Option.isNone(next.next)).toBe(true)
            expect(
              (yield* directory.list(hosted, 'open', restored.page.next).pipe(Effect.flip))._tag,
            ).toBe('InvalidContinuation')

            const status = state === 'closed' ? 'abandoned' : 'completed'

            const queries = [
              'searchCriteria.status=active&$top=50&$skip=0&api-version=7.1',
              `searchCriteria.status=${status}&$top=50&$skip=0&api-version=7.1`,
              'searchCriteria.status=active&$top=50&$skip=50&api-version=7.1',
            ]

            const cachedHistorical = yield* data.listVersioned(hosted, state)
            expect(cachedHistorical).toBe(historical)

            if (count === 50) {
              const last = yield* directory.list(hosted, state, cachedHistorical.page.next)
              expect(last.items.map((pull) => [pull.id, pull.state])).toEqual([['51', state]])
              expect(Option.isNone(last.next)).toBe(true)
              queries.push(`searchCriteria.status=${status}&$top=50&$skip=50&api-version=7.1`)
            }

            expect(requests.map((url) => url.split('?')[1])).toEqual(queries)
          }).pipe(
            Effect.provide(
              DashboardData.layer.pipe(
                Layer.provideMerge(makeRepositoryDirectoryLayer([provider])),
              ),
            ),
          )
        }
      }
    }),
)
