import * as vscode from "vscode";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { InvalidProviderResponse, PluginDefinition, ProviderUnavailable } from "@duff/core/plugins";
import { makeProviderDiscoveryLayer } from "@duff/core/provider-discovery";
import { ProviderAuthentication } from "./ProviderAuthentication";
import { ProviderHttp } from "./ProviderHttp";
import { GitHubPlugin } from "./github/GitHubPlugin";
import { AzureDevOpsPlugin } from "./azure-devops/AzureDevOpsPlugin";

const Session = Schema.Struct({
  id: Schema.String, token: Schema.Redacted(Schema.NonEmptyString),
  account: Schema.Struct({ id: Schema.String, displayName: Schema.String }),
});
const authenticationLayer = Layer.effect(ProviderAuthentication, Effect.gen(function* () {
  const session = Effect.fn("ProviderAuthentication.session")(function* (provider: string, scopes: ReadonlyArray<string>, mode: "silent" | "connect") {
    const value = yield* Effect.tryPromise({
      try: async () => {
        const session = await vscode.authentication.getSession(provider, scopes, mode === "connect" ? { createIfNone: true } : { silent: true, createIfNone: false });
        return session ? { id: session.id, token: Redacted.make(session.accessToken), account: { id: session.account.id, displayName: session.account.label } } : undefined;
      },
      catch: () => new ProviderUnavailable(),
    }).pipe(Effect.timeoutOrElse({ duration: mode === "connect" ? "120 seconds" : "12 seconds", orElse: () => new ProviderUnavailable() }));
    if (!value) return Option.none();
    return Option.some(yield* Schema.decodeUnknownEffect(Session)(value).pipe(Effect.mapError(() => new InvalidProviderResponse())));
  });
  return ProviderAuthentication.of({ session });
}));

const definitions: ReadonlyArray<PluginDefinition<ProviderAuthentication | ProviderHttp>> = [GitHubPlugin, AzureDevOpsPlugin];
export const pluginLayer = Layer.unwrap(Effect.gen(function* () {
  const instances = yield* Effect.forEach(definitions, (definition) => definition.make.pipe(
    Effect.map((contributions) => ({ identity: definition.identity, contributions })),
  ));
  return makeProviderDiscoveryLayer(instances);
})).pipe(Layer.provide(Layer.merge(authenticationLayer, ProviderHttp.layer)));
