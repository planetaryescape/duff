import * as vscode from "vscode";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { InvalidProviderResponse, ProviderUnavailable } from "@duff/core/git-hosting-provider";
import { ProviderAuthentication } from "@duff/core/provider-authentication";

const Session = Schema.Struct({
  id: Schema.String, token: Schema.Redacted(Schema.NonEmptyString),
  account: Schema.Struct({ id: Schema.String, displayName: Schema.String }),
});
export const authenticationLayer = Layer.effect(ProviderAuthentication, Effect.gen(function* () {
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
