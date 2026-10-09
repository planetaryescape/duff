import { Context, Effect, Schema } from "effect";

export const ConfigValue = Schema.Struct({
  scope: Schema.Literals(["system", "global", "local", "worktree", "command", "unknown"]),
  origin: Schema.String,
  value: Schema.String,
});
export interface ConfigValue extends Schema.Schema.Type<typeof ConfigValue> {}

export const GitContextSnapshot = Schema.Struct({
  root: Schema.String,
  name: Schema.optional(ConfigValue),
  email: Schema.optional(ConfigValue),
  author: Schema.optional(Schema.String),
  committer: Schema.optional(Schema.String),
  remotes: Schema.Array(Schema.Struct({
    name: Schema.String,
    destination: Schema.String,
    transport: Schema.Literals(["https", "http", "ssh", "local", "other"]),
  })),
  helpers: Schema.Array(Schema.Struct({
    scope: ConfigValue.fields.scope,
    origin: Schema.String,
    target: Schema.Literals(["unqualified", "URL-scoped"]),
    strategy: Schema.String,
  })),
  sshCommandConfigured: Schema.Boolean,
});
export interface GitContextSnapshot extends Schema.Schema.Type<typeof GitContextSnapshot> {}

export class GitContextError extends Schema.TaggedError<GitContextError>()("GitContextError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class GitContext extends Context.Service<GitContext, {
  readonly inspect: (directory: string) => Effect.Effect<GitContextSnapshot, GitContextError>;
}>()("duff/GitContext") {}
