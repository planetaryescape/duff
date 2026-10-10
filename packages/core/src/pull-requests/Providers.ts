import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { makePullRequestsLayer } from "./PullRequests";
import { ProviderHttp } from "./ProviderHttp";
import { makeGitHubHttp } from "./github/GitHubHttp";
import { makeAzureDevOpsHttp } from "./azure-devops/AzureDevOpsHttp";

export const pullRequestsLayer = Layer.unwrap(Effect.gen(function* () {
  return makePullRequestsLayer([yield* makeGitHubHttp, yield* makeAzureDevOpsHttp]);
})).pipe(Layer.provide(ProviderHttp.layer.pipe(Layer.provide(
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }))),
))));
