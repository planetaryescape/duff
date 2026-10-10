import { Clock, Context, DateTime, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  AuthenticationRequired, DiscoveryError, InvalidProviderResponse, ProviderUnavailable, RateLimited, RepositoryUnavailable,
} from "@duff/core/git-hosting-provider";

export class ProviderHttp extends Context.Service<ProviderHttp, {
  readonly get: (url: string, token: Option.Option<Redacted.Redacted<string>>, headers?: Readonly<Record<string, string>>) =>
    Effect.Effect<{ readonly body: unknown; readonly headers: Readonly<Record<string, string>> }, DiscoveryError>;
}>()("duff/ProviderHttp") {
  static readonly layer = Layer.effect(ProviderHttp, Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const get = Effect.fn("ProviderHttp.get")(function* (
      url: string, token: Option.Option<Redacted.Redacted<string>>, headers: Readonly<Record<string, string>> = {},
    ) {
      let request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ Accept: "application/json", ...headers }));
      if (Option.isSome(token)) request = request.pipe(HttpClientRequest.bearerToken(token.value));
      const response = yield* client.execute(request).pipe(Effect.mapError(() => new ProviderUnavailable()));
      const delay = response.headers["retry-after"];
      const now = yield* Clock.currentTimeMillis;
      const seconds = delay === undefined ? NaN : /^\d+$/.test(delay) ? Number(delay)
        : Option.getOrElse(Option.map(DateTime.make(delay), (time) => (DateTime.toEpochMillis(time) - now) / 1000), () => NaN);
      const retryAfterSeconds = Number.isFinite(seconds) ? Option.some(Math.max(0, seconds)) : Option.none<number>();
      if (response.status === 429 || (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0")) {
        return yield* new RateLimited({ retryAfterSeconds });
      }
      if (response.status === 401) return yield* new AuthenticationRequired();
      if (response.status === 403 || response.status === 404) return yield* new RepositoryUnavailable();
      if (response.status >= 500 || response.status === 408) return yield* new ProviderUnavailable();
      if (response.status < 200 || response.status >= 300) return yield* new InvalidProviderResponse();
      const body = yield* response.json.pipe(Effect.mapError(() => new InvalidProviderResponse()));
      return { body, headers: response.headers };
    }, Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => new ProviderUnavailable() }));
    return ProviderHttp.of({ get });
  }));
}
