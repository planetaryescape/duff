import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Option, Redacted } from "effect";
import { GitContextSnapshot } from "../git-context/GitContext";
import { ProviderRepository, ProviderUnavailable, Remote } from "./GitHostingProvider";
import type { PluginInstance } from "./Plugin";
import { makeProviderDiscoveryLayer, ProviderDiscovery } from "./ProviderDiscovery";

const remote = (name: string): Remote => ({ name, destination: `https://example.invalid/${name}`, transport: "https", credentials: { _tag: "Unresolved", reason: "Fixture" } });
const context = (names: string[]): GitContextSnapshot => ({ root: "/fixture", remotes: names.map(remote), helpers: [], sshCommandConfigured: false });
const repository = (key: string, list: ProviderRepository["listOpenPullRequests"]): ProviderRepository => ({
  identity: { authority: "example.invalid", key, displayName: key },
  inspectAuthentication: () => Effect.succeed({ _tag: "Unauthenticated" }),
  connectAuthentication: () => Effect.succeed({ _tag: "Authenticated", account: { id: "fixture", displayName: "Fixture" } }),
  listOpenPullRequests: list,
});
const plugin = (id: string, recognize: (remote: Remote) => Option.Option<ProviderRepository>): PluginInstance => ({
  identity: { id, displayName: id }, contributions: [{ _tag: "Provider", recognizeRemote: recognize }],
});

it.effect("routes without provider switches and preserves independent ordered outcomes", () => Effect.gen(function* () {
  const first = plugin("first", (remote) => remote.name === "unsupported" ? Option.none() : Option.some(repository(remote.name,
    () => remote.name === "failed" ? new ProviderUnavailable() : Effect.succeed({ items: [], next: Option.none() }))));
  const second = plugin("second", (remote) => remote.name === "ambiguous" ? Option.some(repository("overlap", () => Effect.die("Ambiguous route performed I/O"))) : Option.none());
  yield* Effect.gen(function* () {
    const service = yield* ProviderDiscovery;
    const results = yield* service.discover(context(["success", "unsupported", "failed", "ambiguous"]));
    expect(results.map((row) => row._tag)).toEqual(["Discovered", "Unsupported", "Failed", "Ambiguous"]);
    const ambiguous = results[3];
    if (ambiguous?._tag === "Ambiguous") expect(ambiguous.candidates.map((plugin) => plugin.id)).toEqual(["first", "second"]);
    expect(yield* service.discover(context([]))).toEqual([]);
  }).pipe(Effect.provide(makeProviderDiscoveryLayer([first, second])));
}));

it.effect("validates issued continuations, keeps transient retries, and discards them on refresh", () => Effect.gen(function* () {
  const cursor = Redacted.make("private-cursor");
  let failed = true;
  const instance = plugin("fixture", (remote) => Option.some(repository(remote.name, (input) => {
    if (Option.isNone(input.cursor)) return Effect.succeed({ items: [], next: Option.some(cursor) });
    if (failed) { failed = false; return new ProviderUnavailable(); }
    return Effect.succeed({ items: [], next: Option.none() });
  })));
  yield* Effect.gen(function* () {
    const service = yield* ProviderDiscovery;
    const snapshot = context(["origin"]);
    yield* service.discover(snapshot);
    const unissued = yield* service.loadMore({ context: snapshot, remoteName: "origin", cursor: Redacted.make("private-cursor") });
    expect(unissued._tag).toBe("Failed");
    if (unissued._tag === "Failed") expect(unissued.error._tag).toBe("InvalidContinuation");
    const input = { context: snapshot, remoteName: "origin", cursor };
    expect((yield* service.loadMore(input))._tag).toBe("Failed");
    expect((yield* service.loadMore(input))._tag).toBe("Discovered");
    const consumed = yield* service.loadMore(input);
    expect(consumed._tag).toBe("Failed");
    const missing = yield* service.loadMore({ ...input, remoteName: "missing" }).pipe(Effect.flip);
    expect(missing._tag).toBe("RemoteNotFound");
    yield* service.discover(context([]));
    const stale = yield* service.loadMore(input);
    expect(stale._tag).toBe("Failed");
    if (stale._tag === "Failed") expect(stale.error._tag).toBe("InvalidContinuation");
  }).pipe(Effect.provide(makeProviderDiscoveryLayer([instance])));
}));

it.effect("rejects repeated cursors instead of permitting an infinite pagination cycle", () => Effect.gen(function* () {
  const cursor = Redacted.make("repeated");
  const instance = plugin("fixture", (remote) => Option.some(repository(remote.name, () => Effect.succeed({ items: [], next: Option.some(cursor) }))));
  yield* Effect.gen(function* () {
    const service = yield* ProviderDiscovery;
    const snapshot = context(["origin"]);
    yield* service.discover(snapshot);
    const result = yield* service.loadMore({ context: snapshot, remoteName: "origin", cursor });
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") expect(result.error._tag).toBe("InvalidContinuation");
  }).pipe(Effect.provide(makeProviderDiscoveryLayer([instance])));
}));

it.effect("interrupts provider work without converting cancellation into failed or empty discovery", () => Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const instance = plugin("fixture", (remote) => Option.some(repository(remote.name, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))));
  yield* Effect.gen(function* () {
    const service = yield* ProviderDiscovery;
    const fiber = yield* service.discover(context(["origin"])).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }).pipe(Effect.provide(makeProviderDiscoveryLayer([instance])));
}));
