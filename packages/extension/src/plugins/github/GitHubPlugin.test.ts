import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { AuthenticationRequired, ProviderUnavailable, RateLimited, RepositoryUnavailable, type Remote } from "@duff/core/plugins";
import { ProviderAuthentication, type ProviderSession } from "../ProviderAuthentication";
import { ProviderHttp } from "../ProviderHttp";
import { GitHubPlugin } from "./GitHubPlugin";

const remote = (destination: string): Remote => ({ name: "origin", destination, transport: "ssh", credentials: { _tag: "NotApplicable" } });
const request = { scope: "repository", cursor: Option.none<Redacted.Redacted<string>>() } satisfies Parameters<import("@duff/core/plugins").ProviderRepository["listOpenPullRequests"]>[0];
const session = (token = "test-token", id = "session"): ProviderSession => ({
  id, token: Redacted.make(token), account: { id: "account", displayName: "Test account" },
});
const url = (page: number) => `https://api.github.com/repos/owner/repo/pulls?state=open&sort=created&direction=desc&per_page=30&page=${page}`;
const pull = {
  number: 17, title: "A pull request", draft: true, html_url: "https://evil.invalid/untrusted",
  head: { ref: "feature/topic", sha: "a".repeat(40), repo: { owner: { login: "fork-owner" }, name: "fork-repo" } },
  base: { ref: "main", sha: "b".repeat(40), repo: { owner: { login: "owner" }, name: "repo" } },
};
const make = Effect.fn("GitHubTest.make")(function* (
  auth: ProviderAuthentication["Service"] = { session: () => Effect.succeed(Option.none()) },
  http: ProviderHttp["Service"] = { get: () => Effect.succeed({ body: [], headers: {} }) },
) {
  const contributions = yield* GitHubPlugin.make.pipe(
    Effect.provideService(ProviderAuthentication, ProviderAuthentication.of(auth)),
    Effect.provideService(ProviderHttp, ProviderHttp.of(http)),
  );
  const provider = contributions[0];
  if (!provider) return yield* Effect.die("Missing provider");
  const repository = provider.recognizeRemote(remote("https://github.com/owner/repo.git"));
  if (Option.isNone(repository)) return yield* Effect.die("Missing repository");
  return { provider, repository: repository.value };
});

it.effect("construction and remote recognition do not authenticate or call HTTP", () => Effect.gen(function* () {
  const { provider } = yield* make({ session: () => Effect.die("Unexpected authentication") }, { get: () => Effect.die("Unexpected HTTP") });
  expect(GitHubPlugin.identity).toEqual({ id: "github", displayName: "GitHub" });
  for (const destination of ["https://github.com/owner/repo", "https://github.com/owner/repo.git/", "ssh://github.com/owner/repo.git", "ssh://git@github.com/owner/repo", "git@github.com:owner/repo.git", "github.com:owner/repo", "https://GITHUB.COM/owner/repo"]) {
    const recognized = provider.recognizeRemote(remote(destination));
    expect(Option.isSome(recognized)).toBe(true);
    if (Option.isSome(recognized)) expect(recognized.value.identity.key).toBe("owner/repo");
  }
  for (const destination of ["http://github.com/owner/repo", "https://github.enterprise/owner/repo", "https://github.com.evil/owner/repo", "https://user:secret@github.com/owner/repo", "https://github.com/owner/repo?secret=x", "https://github.com/owner/repo#x", "https://github.com/owner/repo/extra", "https://github.com/owner/%72epo", "https://github.com/owner/..", "ssh://github.com:22/owner/repo", "file:///owner/repo"]) {
    expect(Option.isNone(provider.recognizeRemote(remote(destination)))).toBe(true);
  }
}));

it.effect("reports only actual sessions and explicitly requests connect", () => Effect.gen(function* () {
  let active = Option.none<ProviderSession>();
  const modes: string[] = [];
  const { repository } = yield* make({ session: (provider, scopes, mode) => Effect.sync(() => {
    expect(provider).toBe("github"); expect(scopes).toEqual(["repo"]); modes.push(mode); return active;
  }) });
  expect(yield* repository.inspectAuthentication()).toEqual({ _tag: "Unauthenticated" });
  active = Option.some(session());
  expect(yield* repository.connectAuthentication()).toEqual({ _tag: "Authenticated", account: session().account });
  expect(modes).toEqual(["silent", "connect"]);
}));

it.effect("normalizes drafts, fork identities, full refs and revisions, and deleted sources", () => Effect.gen(function* () {
  const { repository } = yield* make(undefined, { get: (actualUrl, token, headers) => Effect.sync(() => {
    expect(actualUrl).toBe(url(1)); expect(Option.isNone(token)).toBe(true);
    expect(headers).toEqual({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Duff" });
    return { body: [pull, { ...pull, number: 18, head: { ...pull.head, repo: null } }], headers: {} };
  }) });
  const page = yield* repository.listOpenPullRequests(request);
  expect(page.items[0]).toEqual({ id: "17", title: pull.title, draft: true, url: "https://github.com/owner/repo/pull/17",
    source: { _tag: "Available", repository: { authority: "github.com", key: "fork-owner/fork-repo", displayName: "fork-owner/fork-repo" },
      ref: { name: "refs/heads/feature/topic", revision: Option.some("a".repeat(40)) } },
    target: { repository: repository.identity, ref: { name: "refs/heads/main", revision: Option.some("b".repeat(40)) } },
  });
  expect(page.items[1]?.source).toEqual({ _tag: "Unavailable" });
  expect(Option.isNone(page.next)).toBe(true);
}));

it.effect("rejects malformed provider data and inconsistent targets", () => Effect.gen(function* () {
  for (const body of [{ items: [] }, [null], [{ ...pull, number: 0 }], [{ ...pull, draft: "true" }], [{ ...pull, head: { ...pull.head, sha: "bad" } }], [{ ...pull, base: { ...pull.base, repo: null } }], [{ ...pull, base: { ...pull.base, repo: { owner: { login: "other" }, name: "repo" } } }]]) {
    const { repository } = yield* make(undefined, { get: () => Effect.succeed({ body, headers: {} }) });
    expect((yield* repository.listOpenPullRequests(request).pipe(Effect.flip))._tag).toBe("InvalidProviderResponse");
  }
}));

it.effect("continues with rebuilt URLs and refuses other repositories or replaced sessions", () => Effect.gen(function* () {
  let active = Option.some(session());
  const requests: string[] = [];
  const { provider, repository } = yield* make({ session: () => Effect.sync(() => active) }, { get: (actualUrl, token) => Effect.sync(() => {
    requests.push(actualUrl); expect(Option.isSome(token)).toBe(true);
    if (Option.isSome(token)) expect(Redacted.value(token.value)).toBe("test-token");
    const headers: Readonly<Record<string, string>> = actualUrl === url(1) ? { link: `<${url(2)}>; rel="next", <${url(3)}>; rel="last"` } : actualUrl === url(2) ? { link: `<${url(3)}>; rel="next"` } : {};
    return { body: [pull], headers };
  }) });
  const first = yield* repository.listOpenPullRequests(request);
  expect(Option.isSome(first.next)).toBe(true);
  const second = yield* repository.listOpenPullRequests({ ...request, cursor: first.next });
  const third = yield* repository.listOpenPullRequests({ ...request, cursor: second.next });
  expect(Option.isNone(third.next)).toBe(true); expect(requests).toEqual([url(1), url(2), url(3)]);
  const other = provider.recognizeRemote(remote("github.com:other/repo"));
  if (Option.isSome(other)) expect((yield* other.value.listOpenPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))._tag).toBe("InvalidContinuation");
  for (const replacement of [Option.some(session("new-token")), Option.some(session("test-token", "new-session")), Option.none<ProviderSession>()]) {
    active = replacement;
    expect((yield* repository.listOpenPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))._tag).toBe("InvalidContinuation");
  }
  expect(requests).toHaveLength(3);
  expect((yield* repository.listOpenPullRequests({ ...request, cursor: Option.some(Redacted.make("unissued")) }).pipe(Effect.flip))._tag).toBe("InvalidContinuation");
}));

it.effect("rejects unsafe, repeated, backwards and query-changing next links", () => Effect.gen(function* () {
  for (const next of [url(1), url(0), url(2).replace("api.github.com", "evil.invalid"), url(2).replace("owner/repo", "other/repo"), url(2).replace("state=open", "state=closed"), `${url(2)}&extra=x`, `${url(2)}#fragment`, url(2).replace("https://", "https://user:secret@"), `${url(2)}&page=3`]) {
    const { repository } = yield* make(undefined, { get: () => Effect.succeed({ body: [], headers: { link: `<${next}>; rel="next"` } }) });
    expect((yield* repository.listOpenPullRequests(request).pipe(Effect.flip))._tag).toBe("InvalidProviderResponse");
  }
  for (const link of ["malformed", `<${url(2)}>; rel="next", <${url(3)}>; rel="next"`]) {
    const { repository } = yield* make(undefined, { get: () => Effect.succeed({ body: [], headers: { link } }) });
    expect((yield* repository.listOpenPullRequests(request).pipe(Effect.flip))._tag).toBe("InvalidProviderResponse");
  }
  const { repository } = yield* make(undefined, { get: (actualUrl) => Effect.succeed({ body: [], headers: { link: `<${actualUrl === url(1) ? url(2) : url(1)}>; rel="next"` } }) });
  const first = yield* repository.listOpenPullRequests(request);
  expect((yield* repository.listOpenPullRequests({ ...request, cursor: first.next }).pipe(Effect.flip))._tag).toBe("InvalidProviderResponse");
}));

it.effect("propagates HTTP and authentication failures without anonymous fallback or retries", () => Effect.gen(function* () {
  for (const error of [new AuthenticationRequired(), new RepositoryUnavailable(), new ProviderUnavailable(), new RateLimited({ retryAfterSeconds: Option.none() })]) {
    let calls = 0;
    const { repository } = yield* make({ session: () => Effect.succeed(Option.some(session())) }, { get: () => Effect.sync(() => { calls++; }).pipe(Effect.andThen(Effect.fail(error))) });
    expect(yield* repository.listOpenPullRequests(request).pipe(Effect.flip)).toEqual(error); expect(calls).toBe(1);
  }
  const { repository } = yield* make({ session: () => Effect.fail(new ProviderUnavailable()) }, { get: () => Effect.die("Anonymous fallback") });
  expect((yield* repository.inspectAuthentication().pipe(Effect.flip))._tag).toBe("ProviderUnavailable");
  expect((yield* repository.connectAuthentication().pipe(Effect.flip))._tag).toBe("ProviderUnavailable");
  expect((yield* repository.listOpenPullRequests(request).pipe(Effect.flip))._tag).toBe("ProviderUnavailable");
}));

it.effect("honors successful Retry-After and failed rate-limit cooldown using the supplied clock", () => Effect.gen(function* () {
  for (const failed of [false, true]) {
    let calls = 0;
    const { repository } = yield* make(undefined, { get: () => {
      calls++;
      return failed ? Effect.fail(new RateLimited({ retryAfterSeconds: Option.some(10) })) : Effect.succeed({ body: [], headers: { "retry-after": "10" } });
    } });
    yield* repository.listOpenPullRequests(request).pipe(Effect.result);
    const error = yield* repository.listOpenPullRequests(request).pipe(Effect.flip);
    expect(error._tag).toBe("RateLimited"); expect(calls).toBe(1);
    yield* TestClock.adjust("10 seconds");
    yield* repository.listOpenPullRequests(request).pipe(Effect.result);
    expect(calls).toBe(2);
  }
}));

it.effect("uses the test clock for HTTP-date Retry-After and ignores malformed delays", () => Effect.gen(function* () {
  yield* TestClock.setTime(0);
  let calls = 0;
  const { repository } = yield* make(undefined, { get: () => Effect.sync(() => {
    calls++;
    return { body: [], headers: { "retry-after": calls === 1 ? "Thu, 01 Jan 1970 00:00:10 GMT" : "invalid" } };
  }) });
  yield* repository.listOpenPullRequests(request);
  expect(yield* repository.listOpenPullRequests(request).pipe(Effect.flip)).toEqual(new RateLimited({ retryAfterSeconds: Option.some(10) }));
  expect(calls).toBe(1);
  yield* TestClock.adjust("10 seconds");
  yield* repository.listOpenPullRequests(request);
  yield* repository.listOpenPullRequests(request);
  expect(calls).toBe(3);
}));

it.effect("preserves interruption and transport cleanup", () => Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  let cleaned = false;
  const { repository } = yield* make(undefined, { get: () => Deferred.succeed(started, undefined).pipe(
    Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { cleaned = true; })),
  ) });
  const fiber = yield* repository.listOpenPullRequests(request).pipe(Effect.forkScoped);
  yield* Deferred.await(started);
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
  expect(cleaned).toBe(true);
}));
