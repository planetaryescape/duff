import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'

import { AzureCliAuthenticationError } from '../GitHostingProvider'
import { ProviderSession } from '../ProviderAuthentication'

const Credential = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String.check(Schema.isPattern(/^\S+$/)),
    expires_on: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
)

export class AzureCliAuthentication extends Context.Service<
  AzureCliAuthentication,
  { readonly session: () => Effect.Effect<ProviderSession, AzureCliAuthenticationError> }
>()('duff/AzureCliAuthentication') {}

export const makeAzureCliAuthenticationLayer = (environment: NodeJS.ProcessEnv) =>
  Layer.effect(
    AzureCliAuthentication,
    Effect.gen(function* () {
      const env = {
        ...environment,
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
        AZURE_LOGGING_ENABLE_LOG_FILE: 'false',
        AZURE_CORE_COLLECT_TELEMETRY: 'no',
      }

      const session = Effect.fn('AzureCliAuthentication.session')(function* () {
        const output = yield* Effect.callback<Redacted.Redacted, AzureCliAuthenticationError>(
          (resume) => {
            const child = spawn(
              'az',
              [
                'account',
                'get-access-token',
                '--resource',
                '499b84ac-1321-427f-aa17-267ca6975798',
                '--output',
                'json',
              ],
              {
                env,
                cwd: tmpdir(),
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
              },
            )

            let stdout = ''
            let stderr = ''
            let bytes = 0
            let missing = false

            const stop = () => {
              if (child.pid !== undefined) {
                try {
                  if (process.platform === 'win32') child.kill('SIGKILL')
                  else process.kill(-child.pid, 'SIGKILL')
                } catch {
                  child.kill('SIGKILL')
                }
              }
            }

            child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
              bytes += Buffer.byteLength(chunk)

              if (bytes > 1024 * 1024) stop()
              else stdout += chunk
            })
            child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
              bytes += Buffer.byteLength(chunk)

              if (bytes > 1024 * 1024) stop()
              else stderr += chunk
            })
            child.once('error', (error) => {
              missing = 'code' in error && error.code === 'ENOENT'
            })

            const closed = new Promise<void>((resolve) =>
              child.once('close', (code) => {
                resolve()

                if (code === 0 && bytes <= 1024 * 1024)
                  resume(Effect.succeed(Redacted.make(stdout)))
                else {
                  const reason = missing
                    ? 'not-installed'
                    : stderr.includes("Please run 'az login' to setup account.") ||
                        stderr.includes("Can't find token from MSAL cache.")
                      ? 'sign-in-required'
                      : 'unavailable'

                  resume(Effect.fail(new AzureCliAuthenticationError({ reason })))
                }
              }),
            )

            return Effect.promise(async () => {
              stop()
              await closed
            })
          },
        ).pipe(
          Effect.timeoutOrElse({
            duration: '12 seconds',
            orElse: () => new AzureCliAuthenticationError({ reason: 'unavailable' }),
          }),
        )

        const credential = yield* Schema.decodeUnknownEffect(Credential)(
          Redacted.value(output),
        ).pipe(
          Effect.mapError(() => new AzureCliAuthenticationError({ reason: 'invalid-response' })),
        )

        if (credential.expires_on * 1000 <= (yield* Clock.currentTimeMillis))
          return yield* new AzureCliAuthenticationError({ reason: 'invalid-response' })

        return ProviderSession.make({
          id: createHash('sha256').update(credential.accessToken).digest('hex'),
          token: Redacted.make(credential.accessToken),
          account: Option.none(),
        })
      })

      return AzureCliAuthentication.of({ session })
    }),
  )
