import { Effect, Schema, Scope } from "effect";
import type { ProviderContribution } from "./GitHostingProvider";

export const PluginIdentity = Schema.Struct({ id: Schema.NonEmptyString, displayName: Schema.NonEmptyString });
export interface PluginIdentity extends Schema.Schema.Type<typeof PluginIdentity> {}

export type PluginContribution = ProviderContribution;
export interface PluginInstance {
  readonly identity: PluginIdentity;
  readonly contributions: ReadonlyArray<PluginContribution>;
}
export interface PluginDefinition<R> {
  readonly identity: PluginIdentity;
  readonly make: Effect.Effect<ReadonlyArray<PluginContribution>, never, R | Scope.Scope>;
}
