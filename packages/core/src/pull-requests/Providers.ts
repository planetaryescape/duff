import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { makeAzureDevOpsProvider } from './adapters/AzureDevOpsProvider'
import { makeGitHubProvider } from './adapters/GitHubProvider'
import { ProviderHttp } from './adapters/ProviderHttp'
import { makePullRequestsLayer } from './PullRequests'

export const pullRequestsLayer = Layer.unwrap(
  Effect.gen(function* () {
    return makePullRequestsLayer([yield* makeGitHubProvider, yield* makeAzureDevOpsProvider])
  }),
).pipe(
  Layer.provide(
    ProviderHttp.layer.pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'manual' })),
        ),
      ),
    ),
  ),
)
