import { Context, Effect, Layer, Option, Redacted, Ref } from "effect";
import { GitContextSnapshot } from "../git-context/GitContext";
import { Authentication, AuthenticationError, InvalidContinuation, Remote, RemoteDiscovery, RemoteNotFound } from "./GitHostingProvider";
import type { PluginInstance } from "./Plugin";

export class ProviderDiscovery extends Context.Service<ProviderDiscovery, {
  readonly discover: (context: GitContextSnapshot) => Effect.Effect<ReadonlyArray<RemoteDiscovery>>;
  readonly loadMore: (input: {
    readonly context: GitContextSnapshot; readonly remoteName: string; readonly cursor: Redacted.Redacted<string>;
  }) => Effect.Effect<RemoteDiscovery, RemoteNotFound>;
  readonly connect: (context: GitContextSnapshot, remoteName: string) => Effect.Effect<Authentication, AuthenticationError | RemoteNotFound>;
}>()("duff/ProviderDiscovery") {}

export const makeProviderDiscoveryLayer = (instances: ReadonlyArray<PluginInstance>) => Layer.effect(ProviderDiscovery, Effect.gen(function* () {
  const plugins = [...instances];
  if (new Set(plugins.map((plugin) => plugin.identity.id)).size !== plugins.length || plugins.some((plugin) => plugin.contributions.length > 1)) {
    return yield* Effect.die(new Error("Duff built-in plugin registration is invalid."));
  }
  const current = yield* Ref.make({ generation: 0, root: "", rows: new Map<string, RemoteDiscovery>() });
  const route = (remote: Remote) => plugins.flatMap((plugin) => plugin.contributions.flatMap((contribution) => {
    const repository = contribution.recognizeRemote(remote);
    return Option.isSome(repository) ? [{ plugin: plugin.identity, repository: repository.value }] : [];
  }));
  const read = Effect.fn("ProviderDiscovery.read")(function* (remote: Remote, cursor: Option.Option<Redacted.Redacted<string>>): Effect.fn.Return<RemoteDiscovery> {
    const matches = route(remote);
    if (matches.length === 0) return { _tag: "Unsupported", remote };
    if (matches.length > 1) return { _tag: "Ambiguous", remote, candidates: matches.map((match) => match.plugin) };
    const match = matches[0];
    if (!match) return yield* Effect.die(new Error("Duff provider routing invariant failed."));
    const result = yield* Effect.result(Effect.gen(function* () {
      const authentication = yield* match.repository.inspectAuthentication();
      const page = yield* match.repository.listOpenPullRequests({ scope: "repository", cursor });
      if (Option.isSome(cursor) && Option.isSome(page.next) && Redacted.value(cursor.value) === Redacted.value(page.next.value)) {
        return yield* new InvalidContinuation();
      }
      return { authentication, page };
    }));
    const common = { remote, plugin: match.plugin, repository: match.repository.identity };
    return result._tag === "Success" ? { _tag: "Discovered", ...common, ...result.success } : { _tag: "Failed", ...common, error: result.failure };
  });
  const discover = Effect.fn("ProviderDiscovery.discover")(function* (context: GitContextSnapshot) {
    const generation = yield* Ref.modify(current, (state) => [state.generation + 1, { generation: state.generation + 1, root: context.root, rows: new Map() }]);
    const rows = yield* Effect.forEach(context.remotes, (remote) => read(remote, Option.none()), { concurrency: 1 });
    yield* Ref.update(current, (state) => state.generation === generation ? { ...state, rows: new Map(rows.map((row) => [row.remote.name, row])) } : state);
    return rows;
  });
  const loadMore = Effect.fn("ProviderDiscovery.loadMore")(function* (input: {
    readonly context: GitContextSnapshot; readonly remoteName: string; readonly cursor: Redacted.Redacted<string>;
  }): Effect.fn.Return<RemoteDiscovery, RemoteNotFound> {
    const remote = input.context.remotes.find((item) => item.name === input.remoteName);
    if (!remote) return yield* new RemoteNotFound();
    const state = yield* Ref.get(current);
    const previous = state.rows.get(remote.name);
    const matches = route(remote);
    const match = matches[0];
    if (matches.length !== 1 || !match) return yield* read(remote, Option.some(input.cursor));
    const valid = state.root === input.context.root && previous?._tag === "Discovered" && previous.remote.destination === remote.destination &&
      previous.plugin.id === match.plugin.id && previous.repository.key === match.repository.identity.key &&
      Option.isSome(previous.page.next) && previous.page.next.value === input.cursor;
    if (!valid) return { _tag: "Failed", remote, plugin: match.plugin, repository: match.repository.identity, error: new InvalidContinuation() };
    const row = yield* read(remote, Option.some(input.cursor));
    yield* Ref.update(current, (latest) => {
      if (latest.generation !== state.generation) return latest;
      const rows = new Map(latest.rows);
      if (row._tag === "Discovered" || row._tag === "Failed" && ["AuthenticationRequired", "InvalidContinuation"].includes(row.error._tag)) rows.set(remote.name, row);
      return { ...latest, rows };
    });
    return row;
  });
  const connect = Effect.fn("ProviderDiscovery.connect")(function* (context: GitContextSnapshot, remoteName: string) {
    const remote = context.remotes.find((item) => item.name === remoteName);
    if (!remote) return yield* new RemoteNotFound();
    const matches = route(remote);
    const match = matches[0];
    if (matches.length !== 1 || !match) return yield* new RemoteNotFound();
    yield* Ref.update(current, (state) => ({ ...state, generation: state.generation + 1, rows: new Map() }));
    return yield* match.repository.connectAuthentication();
  });
  return ProviderDiscovery.of({ discover, loadMore, connect });
}));
