import { createHash } from "node:crypto";
import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import {
  Authentication, InvalidContinuation, InvalidProviderResponse, OpenPullRequest, PullRequestPage, RateLimited,
  type GitHostingProvider, type ProviderRepository, type RepositoryIdentity,
} from "../GitHostingProvider";
import { ProviderAuthentication } from "../ProviderAuthentication";
import { ProviderHttp } from "../ProviderHttp";

const Segment = Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/));
const Repository = Schema.Struct({ owner: Schema.Struct({ login: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)) }), name: Segment });
const Ref = Schema.Struct({
  ref: Schema.NonEmptyString,
  sha: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)),
  repo: Schema.NullOr(Repository),
});
const Cursor = Schema.fromJsonString(Schema.Struct({
  repository: Schema.String, query: Schema.Literal("open/created/desc/30"), binding: Schema.String,
  page: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
}));
const PullRequests = Schema.Array(Schema.Struct({
  number: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  title: Schema.String, draft: Schema.Boolean, head: Ref, base: Ref,
}));

function identity(owner: string, repo: string): RepositoryIdentity {
  return { authority: "github.com", key: `${owner}/${repo}`.toLowerCase(), displayName: `${owner}/${repo}` };
}

function recognize(destination: string): Option.Option<RepositoryIdentity> {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|(?:git@)?github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/i.exec(destination);
  const owner = match?.[1];
  const repo = match?.[2];
  return owner && repo && repo !== "." && repo !== ".." ? Option.some(identity(owner, repo)) : Option.none();
}

function requestUrl(repository: RepositoryIdentity, page: number): string {
  return `https://api.github.com/repos/${repository.key}/pulls?state=open&sort=created&direction=desc&per_page=30&page=${page}`;
}

const nextPage = Effect.fn("GitHub.nextPage")(function* (link: string | undefined, repository: RepositoryIdentity, page: number) {
  if (link === undefined) return Option.none<number>();
  let next = Option.none<number>();
  for (const entry of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z ]+)"\s*$/.exec(entry);
    if (!match?.[1] || !match[2]) return yield* new InvalidProviderResponse();
    if (!match[2].split(" ").includes("next")) continue;
    if (Option.isSome(next)) return yield* new InvalidProviderResponse();
    const url = yield* Effect.try({ try: () => new URL(match[1] ?? ""), catch: () => new InvalidProviderResponse() });
    const rawPage = url.searchParams.get("page");
    const value = rawPage && /^[1-9][0-9]*$/.test(rawPage) ? Number(rawPage) : NaN;
    if (!Number.isSafeInteger(value) || value <= page) return yield* new InvalidProviderResponse();
    const expected = new URL(requestUrl(repository, value));
    url.searchParams.sort();
    expected.searchParams.sort();
    if (url.href !== expected.href) return yield* new InvalidProviderResponse();
    next = Option.some(value);
  }
  return next;
});

export const makeGitHub = Effect.gen(function* (): Effect.gen.Return<GitHostingProvider, never, ProviderAuthentication | ProviderHttp> {
    const auth = yield* ProviderAuthentication;
    const http = yield* ProviderHttp;
    let cooldown = 0;
    const session = Effect.fn("GitHub.session")(function* (mode: "silent" | "connect") {
      return yield* auth.session("github", ["repo"], mode);
    });
    const authentication = Effect.fn("GitHub.authentication")(function* (mode: "silent" | "connect") {
      const current = yield* session(mode);
      return yield* Schema.decodeUnknownEffect(Authentication)(Option.isSome(current)
        ? { _tag: "Authenticated", account: current.value.account } : { _tag: "Unauthenticated" }
      ).pipe(Effect.mapError(() => new InvalidProviderResponse()));
    });
    const bind = (repository: RepositoryIdentity): ProviderRepository => ({
      identity: repository,
      inspectAuthentication: Effect.fn("GitHub.inspectAuthentication")(function* () { return yield* authentication("silent"); }),
      connectAuthentication: Effect.fn("GitHub.connectAuthentication")(function* () { return yield* authentication("connect"); }),
      listOpenPullRequests: Effect.fn("GitHub.listOpenPullRequests")(function* (input) {
        const current = yield* session("silent");
        const token = Option.map(current, (value) => value.token);
        const binding = Option.isSome(current)
          ? JSON.stringify([current.value.id, createHash("sha256").update(Redacted.value(current.value.token)).digest("hex")])
          : "anonymous";
        let page = 1;
        if (Option.isSome(input.cursor)) {
          const cursor = yield* Schema.decodeUnknownEffect(Cursor)(Redacted.value(input.cursor.value)).pipe(Effect.mapError(() => new InvalidContinuation()));
          if (cursor.repository !== repository.key || cursor.binding !== binding) return yield* new InvalidContinuation();
          page = cursor.page;
        }
        const now = yield* Clock.currentTimeMillis;
        if (now < cooldown) return yield* new RateLimited({ retryAfterSeconds: Option.some((cooldown - now) / 1000) });
        const response = yield* http.get(requestUrl(repository, page), token, {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Duff",
        }).pipe(Effect.catchTag("RateLimited", Effect.fn("GitHub.rateLimited")(function* (error) {
          if (Option.isSome(error.retryAfterSeconds)) cooldown = (yield* Clock.currentTimeMillis) + error.retryAfterSeconds.value * 1000;
          return yield* error;
        })));
        const delay = response.headers["retry-after"];
        if (delay !== undefined) {
          const time = yield* Clock.currentTimeMillis;
          const until = /^\d+$/.test(delay) ? time + Number(delay) * 1000
            : Option.getOrElse(Option.map(DateTime.make(delay), DateTime.toEpochMillis), () => NaN);
          if (Number.isFinite(until)) cooldown = Math.max(cooldown, until);
        }
        const decoded = yield* Schema.decodeUnknownEffect(PullRequests)(response.body).pipe(Effect.mapError(() => new InvalidProviderResponse()));
        const items = yield* Effect.forEach(decoded, Effect.fn("GitHub.pullRequest")(function* (pull) {
          if (!pull.base.repo || `${pull.base.repo.owner.login}/${pull.base.repo.name}`.toLowerCase() !== repository.key.toLowerCase()) {
            return yield* new InvalidProviderResponse();
          }
          return yield* Schema.decodeUnknownEffect(OpenPullRequest)({
            id: String(pull.number), title: pull.title, draft: pull.draft,
            url: `https://github.com/${repository.key}/pull/${pull.number}`,
            source: pull.head.repo ? { _tag: "Available", repository: identity(pull.head.repo.owner.login, pull.head.repo.name),
              ref: { name: `refs/heads/${pull.head.ref}`, revision: Option.some(pull.head.sha) } } : { _tag: "Unavailable" },
            target: { repository, ref: { name: `refs/heads/${pull.base.ref}`, revision: Option.some(pull.base.sha) } },
          }).pipe(Effect.mapError(() => new InvalidProviderResponse()));
        }));
        const next = yield* nextPage(response.headers.link, repository, page);
        return yield* Schema.decodeUnknownEffect(PullRequestPage)({ items, next: Option.map(next, (value) => {
          const cursor = JSON.stringify({ repository: repository.key, query: "open/created/desc/30", binding, page: value });
          return Redacted.make(cursor);
        }) }).pipe(Effect.mapError(() => new InvalidProviderResponse()));
      }),
    });
    return { identity: { id: "github", displayName: "GitHub" }, recognizeRemote: (remote) => Option.map(recognize(remote.destination), bind) };
});
