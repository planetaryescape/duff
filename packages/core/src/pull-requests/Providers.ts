import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { makeRepositoryDirectoryLayer } from '../dashboard/RepositoryDirectory'
import { makeAzureDevOpsHttp } from './azure-devops/AzureDevOpsHttp'
import { makeGitHubHttp } from './github/GitHubHttp'
import { ProviderHttp } from './ProviderHttp'
import { makePullRequestsLayer } from './PullRequests'

export const pullRequestsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const providers = [yield* makeGitHubHttp, yield* makeAzureDevOpsHttp]

    return Layer.merge(makePullRequestsLayer(providers), makeRepositoryDirectoryLayer(providers))
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
