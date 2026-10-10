import { Effect, Layer } from "effect";
import { makePullRequestsLayer } from "./PullRequests";
import { ProviderHttp } from "./ProviderHttp";
import { makeGitHub } from "./github/GitHub";
import { makeAzureDevOps } from "./azure-devops/AzureDevOps";

export const pullRequestsLayer = Layer.unwrap(Effect.gen(function* () {
  return makePullRequestsLayer([yield* makeGitHub, yield* makeAzureDevOps]);
})).pipe(Layer.provide(ProviderHttp.layer));
