import { InvalidProviderResponse, ProviderUnavailable } from '@duff/core/git-hosting-provider'
import { ProviderAuthentication, ProviderSession } from '@duff/core/provider-authentication'
import { Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as vscode from 'vscode'

export const authenticationLayer = Layer.effect(
  ProviderAuthentication,
  Effect.gen(function* () {
    const session = Effect.fn('ProviderAuthentication.session')(function* (
      provider: string,
      scopes: ReadonlyArray<string>,
      mode: 'silent' | 'connect',
    ) {
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
          account: { id: value.account.id, displayName: value.account.label },
        }).pipe(Effect.mapError(() => new InvalidProviderResponse())),
      )
    })

    return ProviderAuthentication.of({ session })
  }),
)
