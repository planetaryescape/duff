import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

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

const execute = promisify(execFile);
const safeFailure = (operation: string) => new GitContextError({
  operation,
  message: `Cannot ${operation}. Check that Git is installed, the folder is a repository, and its configuration is valid. Raw Git diagnostics are hidden because they may contain credentials.`,
});

function helperStrategy(value: string): string {
  if (value === "") return "Reset preceding helpers";
  if (["osxkeychain", "manager", "manager-core", "wincred", "libsecret", "cache", "store"].includes(value)) return value;
  if (value.startsWith("!")) return "Custom shell helper (command hidden)";
  return "Custom helper (command and arguments hidden)";
}

function remoteDestination(raw: Redacted.Redacted<string>): {
  destination: string;
  transport: "https" | "http" | "ssh" | "local" | "other";
} {
  const value = Redacted.value(raw);
  try {
    const url = new URL(value);
    if (["https:", "http:", "ssh:"].includes(url.protocol)) {
      const transport = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : "ssh";
      return { destination: `${url.protocol}//${url.host}${url.pathname}`, transport };
    }
    if (url.protocol === "file:") return { destination: "Local repository (path hidden)", transport: "local" };
  } catch {
    const scp = /^(?:[^@/:]+@)?([a-zA-Z0-9.-]+):([^?#]+)(?:[?#].*)?$/.exec(value);
    if (scp?.[1] && scp[2]) return { destination: `${scp[1]}:${scp[2]}`, transport: "ssh" };
    if (/^(?:\/|\.\.?\/)/.test(value)) return { destination: "Local repository (path hidden)", transport: "local" };
  }
  return { destination: "Unsupported remote (URL hidden)", transport: "other" };
}

export const makeGitContextLayer = (environment: NodeJS.ProcessEnv) => Layer.effect(GitContext, Effect.gen(function* () {
  const env = { ...environment };
  const git = Effect.fn("GitContext.git")(function* (root: string, args: ReadonlyArray<string>, operation: string, emptyExit?: number) {
    const output = yield* Effect.tryPromise({
      try: async (signal) => {
        try {
          const result = await execute("git", ["--no-pager", "-C", root, ...args], {
            encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal, env,
          });
          return Redacted.make(result.stdout);
        } catch (cause) {
          if (emptyExit !== undefined && cause instanceof Error && "code" in cause && cause.code === emptyExit) return Redacted.make("");
          throw safeFailure(operation);
        }
      },
      catch: () => safeFailure(operation),
    });
    return output;
  });

  const config = Effect.fn("GitContext.config")(function* (root: string, key: string) {
    const raw = yield* git(root, ["config", "--includes", "--null", "--show-origin", "--show-scope", "--get", key], "read identity configuration", 1);
    const output = Redacted.value(raw);
    if (!output) return undefined;
    const fields = output.split("\0");
    return yield* Schema.decodeUnknownEffect(ConfigValue)({ scope: fields[0], origin: fields[1], value: fields[2] }).pipe(
      Effect.mapError(() => safeFailure("decode identity configuration")),
    );
  });

  const identity = Effect.fn("GitContext.identity")(function* (root: string, variable: string) {
    const raw = yield* git(root, ["var", variable], "resolve commit identity", 128);
    const output = Redacted.value(raw);
    if (!output) return undefined;
    const match = /^(.* <[^<>\n]*>) [0-9]+ [+-][0-9]{4}\n?$/.exec(output);
    return yield* Schema.decodeUnknownEffect(Schema.String)(match?.[1]).pipe(
      Effect.mapError(() => safeFailure("decode commit identity")),
    );
  });

  const inspect = Effect.fn("GitContext.inspect")(function* (directory: string) {
    const root = Redacted.value(yield* git(directory, ["rev-parse", "--show-toplevel"], "locate repository")).trim();
    const name = yield* config(root, "user.name");
    const email = yield* config(root, "user.email");
    const author = yield* identity(root, "GIT_AUTHOR_IDENT");
    const committer = yield* identity(root, "GIT_COMMITTER_IDENT");
    const names = Redacted.value(yield* git(root, ["remote"], "list remotes")).trim().split("\n").filter(Boolean);
    const remotes = yield* Effect.forEach(names, (name) => git(root, ["remote", "get-url", "--", name], "read remote destination").pipe(
      Effect.map((raw) => ({ name, ...remoteDestination(Redacted.make(Redacted.value(raw).trim())) })),
    ));
    const rawHelpers = yield* git(root, ["config", "--includes", "--null", "--show-origin", "--show-scope", "--get-regexp", "^credential(\\..*)?\\.helper$"], "read helper declarations", 1);
    const tokens = Redacted.value(rawHelpers).split("\0");
    const helpers: GitContextSnapshot["helpers"][number][] = [];
    for (let index = 0; index < tokens.length - 1; index += 3) {
      const entry = tokens[index + 2];
      const separator = entry?.indexOf("\n") ?? -1;
      if (!entry || separator === -1) return yield* safeFailure("decode helper declarations");
      const key = entry.slice(0, separator);
      const record = yield* Schema.decodeUnknownEffect(ConfigValue)({
        scope: tokens[index], origin: tokens[index + 1], value: entry.slice(separator + 1),
      }).pipe(Effect.mapError(() => safeFailure("decode helper declarations")));
      helpers.push({ scope: record.scope, origin: record.origin,
        target: key === "credential.helper" ? "unqualified" : "URL-scoped",
        strategy: helperStrategy(record.value),
      });
    }
    const sshCommand = yield* git(root, ["config", "--includes", "--get", "core.sshCommand"], "read SSH strategy", 1);
    return GitContextSnapshot.make({ root, ...(name ? { name } : {}), ...(email ? { email } : {}),
      ...(author ? { author } : {}), ...(committer ? { committer } : {}), remotes, helpers,
      sshCommandConfigured: Boolean(Redacted.value(sshCommand) || env.GIT_SSH_COMMAND || env.GIT_SSH),
    });
  });
  return GitContext.of({ inspect });
}));
