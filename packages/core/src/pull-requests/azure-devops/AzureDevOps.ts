import { createHash, randomUUID } from "node:crypto";
import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import {
  Authentication, AuthenticationRequired, InvalidContinuation, InvalidProviderResponse,
  OpenPullRequest, RateLimited,
} from "../GitHostingProvider";
import type { GitHostingProvider, ProviderRepository, RepositoryIdentity } from "../GitHostingProvider";
import { ProviderAuthentication } from "../ProviderAuthentication";
import { ProviderHttp } from "../ProviderHttp";

const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/user_impersonation"];
const Segment = Schema.NonEmptyString.check(Schema.isPattern(/^[^/\\?#\x00-\x1f]+$/));
const Address = Schema.Struct({ org: Segment, project: Segment, repo: Segment });
type Address = Schema.Schema.Type<typeof Address>;
const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i));
const Commit = Schema.NullOr(Schema.Struct({ commitId: Revision }));
const ForkRepository = Schema.Struct({
  name: Segment,
  project: Schema.Struct({ name: Segment }),
  remoteUrl: Schema.optional(Schema.String),
});
const WirePullRequest = Schema.Struct({
  pullRequestId: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  status: Schema.Literal("active"),
  isDraft: Schema.optional(Schema.Boolean),
  sourceRefName: OpenPullRequest.fields.target.fields.ref.fields.name,
  targetRefName: OpenPullRequest.fields.target.fields.ref.fields.name,
  lastMergeSourceCommit: Schema.optional(Commit),
  lastMergeTargetCommit: Schema.optional(Commit),
  forkSource: Schema.optional(Schema.NullOr(Schema.Struct({ repository: Schema.optional(Schema.Unknown) }))),
});
const WirePage = Schema.Struct({ value: Schema.Array(WirePullRequest), count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });

function parseRemote(destination: string): Option.Option<Address> {
  const modern = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/?$/i.exec(destination);
  const legacy = /^https:\/\/([a-z0-9-]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/?$/i.exec(destination);
  const ssh = /^(?:ssh\.dev\.azure\.com:v3\/|ssh:\/\/ssh\.dev\.azure\.com\/v3\/)([^/]+)\/([^/]+)\/([^/]+)\/?$/i.exec(destination);
  const match = modern ?? legacy ?? ssh;
  if (!match) return Option.none();
  try {
    const org = decodeURIComponent(match[1] ?? "").toLowerCase();
    const project = decodeURIComponent(match[2] ?? "");
    const repo = decodeURIComponent(match[3] ?? "");
    if ([org, project, repo].some((part) => part === "." || part === "..")) return Option.none();
    return Schema.decodeUnknownOption(Address)({ org, project, repo });
  } catch {
    return Option.none();
  }
}

function identity(address: Address): RepositoryIdentity {
  return {
    authority: "dev.azure.com",
    key: [address.org, address.project, address.repo].map((part) => encodeURIComponent(part.toLowerCase())).join("/"),
    displayName: `${address.org}/${address.project}/${address.repo}`,
  };
}

function repositoryUrl(address: Address): string {
  return `https://dev.azure.com/${encodeURIComponent(address.org)}/${encodeURIComponent(address.project)}/_git/${encodeURIComponent(address.repo)}`;
}

export const makeAzureDevOps = Effect.gen(function* (): Effect.gen.Return<GitHostingProvider, never, ProviderAuthentication | ProviderHttp> {
    const authentication = yield* ProviderAuthentication;
    const http = yield* ProviderHttp;
    const continuations = new Map<string, { readonly key: string; readonly session: string; readonly skip: number }>();
    const cooldowns = new Map<string, number>();

    const recognizeRemote: GitHostingProvider["recognizeRemote"] = (remote) => Option.map(parseRemote(remote.destination), (address) => {
      const boundIdentity = identity(address);
      const continuationOwner = JSON.stringify([remote.name, boundIdentity.key]);
      const inspect = Effect.fn("AzureDevOps.inspectAuthentication")(function* (mode: "silent" | "connect") {
        const session = yield* authentication.session("microsoft", scopes, mode);
        return yield* Schema.decodeUnknownEffect(Authentication)(Option.isSome(session)
          ? { _tag: "Authenticated", account: session.value.account }
          : { _tag: "Unauthenticated" }).pipe(Effect.mapError(() => new InvalidProviderResponse()));
      });

      const listOpenPullRequests: ProviderRepository["listOpenPullRequests"] = Effect.fn("AzureDevOps.listOpenPullRequests")(function* (input) {
        const session = yield* authentication.session("microsoft", scopes, "silent");
        if (Option.isNone(session)) return yield* new AuthenticationRequired();
        const sessionKey = createHash("sha256").update(JSON.stringify([
          session.value.id, session.value.account.id, Redacted.value(session.value.token),
        ])).digest("hex");
        let skip = 0;
        if (Option.isSome(input.cursor)) {
          const continuation = continuations.get(continuationOwner);
          if (!continuation || continuation.key !== Redacted.value(input.cursor.value) || continuation.session !== sessionKey) {
            return yield* new InvalidContinuation();
          }
          skip = continuation.skip;
        } else continuations.delete(continuationOwner);
        const now = yield* Clock.currentTimeMillis;
        const cooldown = cooldowns.get(boundIdentity.key) ?? 0;
        if (cooldown > now) return yield* new RateLimited({ retryAfterSeconds: Option.some((cooldown - now) / 1000) });
        const url = `https://dev.azure.com/${encodeURIComponent(address.org)}/${encodeURIComponent(address.project)}/_apis/git/repositories/${encodeURIComponent(address.repo)}/pullrequests?searchCriteria.status=active&$top=50&$skip=${skip}&api-version=7.1`;
        const response = yield* http.get(url, Option.some(session.value.token)).pipe(Effect.tapError(Effect.fn("AzureDevOps.recordRateLimit")(function* (error) {
          if (error._tag === "RateLimited" && Option.isSome(error.retryAfterSeconds)) {
            cooldowns.set(boundIdentity.key, (yield* Clock.currentTimeMillis) + error.retryAfterSeconds.value * 1000);
          }
        })));
        const delay = response.headers["retry-after"];
        if (delay !== undefined) {
          const received = yield* Clock.currentTimeMillis;
          const seconds = /^\d+$/.test(delay) ? Number(delay)
            : Option.getOrElse(Option.map(DateTime.make(delay), (time) => (DateTime.toEpochMillis(time) - received) / 1000), () => NaN);
          if (Number.isFinite(seconds) && seconds > 0) cooldowns.set(boundIdentity.key, received + seconds * 1000);
        }
        const page = yield* Schema.decodeUnknownEffect(WirePage)(response.body).pipe(Effect.mapError(() => new InvalidProviderResponse()));
        if (page.count !== page.value.length || page.value.length > 50) return yield* new InvalidProviderResponse();
        const items = yield* Effect.forEach(page.value, Effect.fn("AzureDevOps.normalizePullRequest")(function* (pr) {
          let sourceRepository: Option.Option<RepositoryIdentity> = Option.some(boundIdentity);
          if (pr.forkSource !== undefined) {
            const fork = Schema.decodeUnknownOption(ForkRepository)(pr.forkSource?.repository);
            sourceRepository = Option.flatMap(fork, (repository) => repository.remoteUrl !== undefined
              ? Option.map(parseRemote(repository.remoteUrl), identity)
              : Option.some(identity({ org: address.org, project: repository.project.name, repo: repository.name })));
          }
          return yield* Schema.decodeUnknownEffect(OpenPullRequest)({
            id: String(pr.pullRequestId), title: pr.title,
            url: `${repositoryUrl(address)}/pullrequest/${pr.pullRequestId}`, draft: pr.isDraft ?? false,
            source: Option.isSome(sourceRepository)
              ? { _tag: "Available", repository: sourceRepository.value, ref: { name: pr.sourceRefName, revision: Option.fromNullishOr(pr.lastMergeSourceCommit?.commitId) } }
              : { _tag: "Unavailable" },
            target: { repository: boundIdentity, ref: { name: pr.targetRefName, revision: Option.fromNullishOr(pr.lastMergeTargetCommit?.commitId) } },
          }).pipe(Effect.mapError(() => new InvalidProviderResponse()));
        }));
        continuations.delete(continuationOwner);
        let next: Option.Option<Redacted.Redacted<string>> = Option.none();
        if (page.value.length === 50) {
          const key = randomUUID();
          continuations.set(continuationOwner, { key, session: sessionKey, skip: skip + 50 });
          next = Option.some(Redacted.make(key));
        }
        return { items, next };
      });
      return {
        identity: boundIdentity,
        inspectAuthentication: () => inspect("silent"),
        connectAuthentication: () => inspect("connect"),
        listOpenPullRequests,
      };
    });
    return { identity: { id: "azure-devops", displayName: "Azure DevOps" }, recognizeRemote };
});
