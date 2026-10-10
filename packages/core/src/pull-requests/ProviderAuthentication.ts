import { Context, Effect, Option, Redacted } from "effect";
import { AuthenticationError } from "./GitHostingProvider";

export interface ProviderSession {
  readonly id: string;
  readonly token: Redacted.Redacted<string>;
  readonly account: { readonly id: string; readonly displayName: string };
}

export class ProviderAuthentication extends Context.Service<ProviderAuthentication, {
  readonly session: (provider: string, scopes: ReadonlyArray<string>, mode: "silent" | "connect") =>
    Effect.Effect<Option.Option<ProviderSession>, AuthenticationError>;
}>()("duff/ProviderAuthentication") {}
