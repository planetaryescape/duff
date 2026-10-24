import { AzureCliAuthentication } from '@duff/core/azure-cli-authentication'
import { InvalidProviderResponse, ProviderUnavailable } from '@duff/core/git-hosting-provider'
import { GitHubCredentials } from '@duff/core/github-credentials'
import { ProviderAuthentication, ProviderSession } from '@duff/core/provider-authentication'
import { Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as vscode from 'vscode'

export const authenticationLayer = Layer.effect(
  ProviderAuthentication,
  Effect.gen(function* () {
    const cli = yield* AzureCliAuthentication
    const github = yield* GitHubCredentials

    const session = Effect.fn('ProviderAuthentication.session')(function* (
      provider: string,
      scopes: ReadonlyArray<string>,
      mode: 'silent' | 'connect',
    ) {
      if (provider === 'microsoft') return Option.some(yield* cli.session())

      if (provider !== 'github') return yield* new ProviderUnavailable()

      const external = yield* github.session()

      if (Option.isSome(external)) return external

      const value = yield* Effect.tryPromise({
        try: () =>
          vscode.authentication.getSession(
            provider,
            scopes,
            mode === 'connect' ? { createIfNone: true } : { silent: true, createIfNone: false },
          ),
        catch: () => new ProviderUnavailable(),
      }).pipe(
        Effect.timeoutOrElse({
          duration: mode === 'connect' ? '120 seconds' : '12 seconds',
          orElse: () => new ProviderUnavailable(),
        }),
      )

      if (!value) return Option.none()

      return Option.some(
        yield* Schema.decodeUnknownEffect(ProviderSession)({
          id: value.id,
          token: Redacted.make(value.accessToken),
          account: Option.some({ id: value.account.id, displayName: value.account.label }),
          source: 'editor',
        }).pipe(Effect.mapError(() => new InvalidProviderResponse())),
      )
    })

    return ProviderAuthentication.of({ session })
  }),
)
