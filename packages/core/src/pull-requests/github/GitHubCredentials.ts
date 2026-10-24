import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

import { NodeServices } from '@effect/platform-node'
import { Context, Effect, Layer, Match, Option, Redacted, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { GitHubAuthenticationError, type GitHubCredentialSource } from '../GitHostingProvider'
import { ProviderSession } from '../ProviderAuthentication'

const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]+$/))

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly session: () => Effect.Effect<Option.Option<ProviderSession>, GitHubAuthenticationError>
  }
>()('duff/GitHubCredentials') {}

const credential = Effect.fn('GitHubCredentials.decode')(function* (
  value: Redacted.Redacted,
  source: GitHubCredentialSource,
) {
  const token = yield* Schema.decodeUnknownEffect(Token)(Redacted.value(value)).pipe(
    Effect.mapError(() => new GitHubAuthenticationError({ source, reason: 'invalid-credential' })),
  )

  return ProviderSession.make({
    id: createHash('sha256').update(token).digest('hex'),
    token: Redacted.make(token),
    account: Option.none(),
    source,
  })
})

export const makeGitHubCredentialsLayer = (environment: NodeJS.ProcessEnv) =>
  Layer.effect(
    GitHubCredentials,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const env: NodeJS.ProcessEnv = {
        ...environment,
        GH_PROMPT_DISABLED: '1',
        GH_DEBUG: '',
        DEBUG: '',
        GH_NO_UPDATE_NOTIFIER: '1',
      }

      const cliSession = Effect.fn('GitHubCredentials.cliSession')(
        function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make('gh', ['auth', 'token', '--hostname', 'github.com'], {
              env,
              extendEnv: false,
              cwd: tmpdir(),
              stdin: 'ignore',
              killSignal: 'SIGKILL',
            }),
          )

          let bytes = 0

          const bounded = Stream.mapEffect((chunk: Uint8Array) => {
            bytes += chunk.byteLength

            return bytes <= 1024 * 1024
              ? Effect.succeed(chunk)
              : Effect.fail(
                  new GitHubAuthenticationError({ source: 'github-cli', reason: 'unavailable' }),
                )
          })

          const { stdout, stderr, code } = yield* Effect.all(
            {
              stdout: child.stdout.pipe(bounded, Stream.decodeText(), Stream.mkString),
              stderr: child.stderr.pipe(bounded, Stream.decodeText(), Stream.mkString),
              code: child.exitCode,
            },
            { concurrency: 'unbounded' },
          )

          if (code === 0)
            return Option.some(
              yield* credential(Redacted.make(stdout.replace(/\r?\n$/, '')), 'github-cli'),
            )

          if (code === 1 && !stdout && stderr.trim() === 'no oauth token found for github.com')
            return Option.none()

          return yield* new GitHubAuthenticationError({
            source: 'github-cli',
            reason: 'unavailable',
          })
        },
        Effect.scoped,
        Effect.catchTag('PlatformError', (error) =>
          Match.value(error.reason).pipe(
            Match.when({ _tag: 'NotFound', method: 'spawn' }, () => Effect.succeed(Option.none())),
            Match.orElse(() =>
              Effect.fail(
                new GitHubAuthenticationError({ source: 'github-cli', reason: 'unavailable' }),
              ),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: '12 seconds',
          orElse: () =>
            new GitHubAuthenticationError({ source: 'github-cli', reason: 'unavailable' }),
        }),
      )

      const session = Effect.fn('GitHubCredentials.session')(function* () {
        const sources: ReadonlyArray<'GH_TOKEN' | 'GITHUB_TOKEN'> = ['GH_TOKEN', 'GITHUB_TOKEN']

        for (const source of sources) {
          const value = env[source]

          if (!value) continue

          return Option.some(yield* credential(Redacted.make(value), source))
        }

        return yield* cliSession()
      })

      return GitHubCredentials.of({ session })
    }),
  ).pipe(Layer.provide(NodeServices.layer))
