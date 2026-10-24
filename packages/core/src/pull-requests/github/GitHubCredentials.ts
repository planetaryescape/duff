import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'

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
      const env: NodeJS.ProcessEnv = {
        ...environment,
        GH_PROMPT_DISABLED: '1',
        GH_DEBUG: '',
        DEBUG: '',
        GH_NO_UPDATE_NOTIFIER: '1',
      }

      const session = Effect.fn('GitHubCredentials.session')(function* () {
        const sources: ReadonlyArray<'GH_TOKEN' | 'GITHUB_TOKEN'> = ['GH_TOKEN', 'GITHUB_TOKEN']

        for (const source of sources) {
          const value = env[source]

          if (!value) continue

          return Option.some(yield* credential(Redacted.make(value), source))
        }

        const output = yield* Effect.callback<
          Option.Option<Redacted.Redacted>,
          GitHubAuthenticationError
        >((resume) => {
          const child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {
            env,
            cwd: tmpdir(),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          })

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
                resume(Effect.succeed(Option.some(Redacted.make(stdout.replace(/\r?\n$/, '')))))
              else if (
                missing ||
                (code === 1 && !stdout && stderr.trim() === 'no oauth token found for github.com')
              )
                resume(Effect.succeed(Option.none()))
              else
                resume(
                  Effect.fail(
                    new GitHubAuthenticationError({ source: 'github-cli', reason: 'unavailable' }),
                  ),
                )
            }),
          )

          return Effect.promise(async () => {
            stop()
            await closed
          })
        }).pipe(
          Effect.timeoutOrElse({
            duration: '12 seconds',
            orElse: () =>
              new GitHubAuthenticationError({ source: 'github-cli', reason: 'unavailable' }),
          }),
        )

        if (Option.isNone(output)) return Option.none()

        return Option.some(yield* credential(output.value, 'github-cli'))
      })

      return GitHubCredentials.of({ session })
    }),
  )
