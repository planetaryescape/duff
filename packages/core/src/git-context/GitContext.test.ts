import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { GitContext, makeGitContextLayer } from "./GitContext";

const execute = promisify(execFile);
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "duff-context-"));
    const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global.config") };
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    await execute("git", ["init", "-b", "feature", root], { env });
    return { root, env };
  }),
  ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);
const command = (root: string, env: NodeJS.ProcessEnv, ...args: string[]) => Effect.promise(
  () => execute("git", ["-C", root, ...args], { env }),
);
const write = (path: string, content: string) => Effect.promise(() => writeFile(path, content));

it.effect("reads conditional includes, worktree precedence, provenance, and separate environment identities", () => Effect.gen(function* () {
  const { root, env } = yield* fixture;
  const included = join(root, "included.config");
  yield* write(env.GIT_CONFIG_GLOBAL, `[user]\nname = Global Name\nemail = global@example.invalid\n[includeIf "onbranch:feature"]\npath = ${included}\n`);
  yield* write(included, "[user]\nname = Included Name\nemail = included@example.invalid\n");
  yield* command(root, env, "config", "user.email", "local@example.invalid");
  const conditional = yield* GitContext.use((service) => service.inspect(root)).pipe(Effect.provide(makeGitContextLayer(env)));
  expect(conditional.name).toEqual({ value: "Included Name", scope: "global", origin: `file:${included}` });
  expect(conditional.email?.value).toBe("local@example.invalid");
  expect(conditional.email?.scope).toBe("local");
  yield* command(root, env, "config", "extensions.worktreeConfig", "true");
  yield* command(root, env, "config", "--worktree", "user.name", "Worktree Name");
  const context = yield* GitContext.use((service) => service.inspect(root)).pipe(Effect.provide(makeGitContextLayer({
    ...env, GIT_AUTHOR_NAME: "Override Author", GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Override Committer", GIT_COMMITTER_EMAIL: "committer@example.invalid",
  })));
  expect(context.name?.value).toBe("Worktree Name");
  expect(context.name?.scope).toBe("worktree");
  expect(context.name?.origin).toContain("config.worktree");
  expect(context.author).toBe("Override Author <author@example.invalid>");
  expect(context.committer).toBe("Override Committer <committer@example.invalid>");
}));

it.effect("keeps ordered helper declarations and sanitized remotes without executing or exposing secrets", () => Effect.gen(function* () {
  const { root, env } = yield* fixture;
  yield* command(root, env, "config", "user.name", "Fixture");
  yield* command(root, env, "config", "user.email", "fixture@example.invalid");
  const marker = join(root, "helper-executed");
  yield* command(root, env, "config", "core.sshCommand", "ssh -i canary-secret");
  yield* command(root, env, "remote", "add", "origin", "https://user:canary-secret@example.invalid/org/repo.git?token=canary-secret#canary-secret");
  yield* command(root, env, "remote", "add", "ssh", "git@example.invalid:org/repo.git");
  yield* Effect.promise(() => appendFile(join(root, ".git", "config"),
    `[credential]\nhelper = osxkeychain\nhelper =\n[credential "https://canary-secret@example.invalid"]\nhelper = "!touch ${marker}; echo canary-secret"\n[credential]\nhelper = store --file=canary-secret\n`));
  const context = yield* GitContext.use((service) => service.inspect(root)).pipe(Effect.provide(makeGitContextLayer(env)));
  expect(context.remotes).toEqual([
    { name: "origin", destination: "https://example.invalid/org/repo.git", transport: "https" },
    { name: "ssh", destination: "example.invalid:org/repo.git", transport: "ssh" },
  ]);
  expect(context.helpers.map(({ strategy, target }) => ({ strategy, target }))).toEqual([
    { strategy: "osxkeychain", target: "unqualified" },
    { strategy: "Reset preceding helpers", target: "unqualified" },
    { strategy: "Custom shell helper (command hidden)", target: "URL-scoped" },
    { strategy: "Custom helper (command and arguments hidden)", target: "unqualified" },
  ]);
  expect(context.sshCommandConfigured).toBe(true);
  expect(JSON.stringify(context)).not.toContain("canary-secret");
  expect(existsSync(marker)).toBe(false);
}));

it.effect("accepts platform-provided helper scopes alongside local declarations", () => Effect.gen(function* () {
  const { root, env } = yield* fixture;
  yield* command(root, env, "config", "user.name", "Fixture");
  yield* command(root, env, "config", "user.email", "fixture@example.invalid");
  yield* command(root, env, "config", "credential.helper", "cache");
  const context = yield* GitContext.use((service) => service.inspect(root)).pipe(
    Effect.provide(makeGitContextLayer({ ...env, GIT_CONFIG_NOSYSTEM: "0" })),
  );
  expect(context.helpers[context.helpers.length - 1]).toEqual({
    scope: "local", origin: "file:.git/config",
    target: "unqualified", strategy: "cache",
  });
  expect(context.name?.value).toBe("Fixture");
}));

it.effect("distinguishes unset configuration from invalid configuration with safe failures", () => Effect.gen(function* () {
  const { root, env } = yield* fixture;
  yield* command(root, env, "config", "user.useConfigOnly", "true");
  const context = yield* GitContext.use((service) => service.inspect(root)).pipe(Effect.provide(makeGitContextLayer(env)));
  expect(context.name).toBeUndefined();
  expect(context.email).toBeUndefined();
  expect(context.author).toBeUndefined();
  expect(context.committer).toBeUndefined();
  expect(context.helpers).toEqual([]);
  expect(context.remotes).toEqual([]);
  yield* write(join(root, ".git", "config"), "[canary-secret invalid config");
  const failure = yield* GitContext.use((service) => service.inspect(root)).pipe(
    Effect.provide(makeGitContextLayer(env)), Effect.flip,
  );
  expect(failure._tag).toBe("GitContextError");
  expect(JSON.stringify(failure)).not.toContain("canary-secret");
}));
