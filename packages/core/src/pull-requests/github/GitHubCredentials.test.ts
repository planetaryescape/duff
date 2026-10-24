import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Option, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { AuthenticationRequired, RepositoryUnavailable } from '../GitHostingProvider'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { GitHubCredentials, makeGitHubCredentialsLayer } from './GitHubCredentials'
import { makeGitHubHttp } from './GitHubHttp'

const fixture = (body: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'duff-gh-'))
      await writeFile(join(directory, 'gh'), `#!${process.execPath}\n${body}`, { mode: 0o700 })

      return directory
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

it.effect('prefers GH_TOKEN, then GITHUB_TOKEN, then the host-specific active CLI login', () =>
  Effect.gen(function* () {
    const directory = yield* fixture(`
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['auth','token','--hostname','github.com'])) process.exit(2);
      if (process.env.GH_PROMPT_DISABLED !== '1' || process.env.GH_DEBUG || process.env.DEBUG) process.exit(3);
      console.log('cli_canary');
    `)

    for (const [first, second, expected, source] of [
      ['primary_canary', 'secondary_canary', 'primary_canary', 'GH_TOKEN'],
      ['', 'secondary_canary', 'secondary_canary', 'GITHUB_TOKEN'],
      ['', '', 'cli_canary', 'github-cli'],
    ]) {
      const session = Option.getOrThrow(
        yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
          Effect.provide(
            makeGitHubCredentialsLayer({
              PATH: directory,
              GH_TOKEN: first,
              GITHUB_TOKEN: second,
              GH_HOST: 'untrusted.invalid',
              GH_DEBUG: 'api',
              DEBUG: '1',
            }),
          ),
        ),
      )

      expect(Redacted.value(session.token)).toBe(expected)
      expect(session.source).toBe(source)
      expect(session.account).toEqual(Option.none())
      expect(JSON.stringify(session)).not.toContain('canary')
    }

    const withoutCLI = yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
      Effect.provide(makeGitHubCredentialsLayer({ PATH: '/missing', GITHUB_TOKEN: 'env_canary' })),
    )

    expect(Option.getOrThrow(withoutCLI).source).toBe('GITHUB_TOKEN')
  }),
)

it.effect(
  'only absent CLI credentials allow fallback; invalid overrides and CLI failures stay failures',
  () =>
    Effect.gen(function* () {
      for (const env of [
        { PATH: '/missing' },
        {
          PATH: yield* fixture(
            "console.error('no oauth token found for github.com'); process.exit(1)",
          ),
        },
      ]) {
        expect(
          yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
            Effect.provide(makeGitHubCredentialsLayer(env)),
          ),
        ).toEqual(Option.none())
      }

      const directory = yield* fixture("console.log('cli_canary')")

      for (const token of ['bad_canary\n', 'bad_canary\r\nInjected:yes', ' ', 'bad canary']) {
        const error = yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
          Effect.provide(
            makeGitHubCredentialsLayer({
              PATH: directory,
              GH_TOKEN: token,
              GITHUB_TOKEN: 'valid_canary',
            }),
          ),
          Effect.flip,
        )

        expect(error).toMatchObject({ source: 'GH_TOKEN', reason: 'invalid-credential' })
        expect(JSON.stringify(error)).not.toContain('canary')
      }

      for (const body of [
        "console.error('private_canary'); process.exit(1)",
        "console.log('private_canary\\nInjected:yes')",
        "process.stdout.write('x'.repeat(1024*1024+1))",
      ]) {
        const path = yield* fixture(body)

        const error = yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
          Effect.provide(makeGitHubCredentialsLayer({ PATH: path })),
          Effect.flip,
        )

        expect(error._tag).toBe('GitHubAuthenticationError')
        expect(JSON.stringify(error)).not.toContain('private_canary')
      }
    }),
)

it.effect(
  'verifies the selected account and preserves rejected credentials without anonymous retry',
  () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.pipe(
        Effect.provide(
          makeGitHubCredentialsLayer({ GH_TOKEN: 'primary_canary', PATH: '/missing' }),
        ),
      )

      for (const outcome of ['success', 'rejected', 'app-token']) {
        const provider = yield* makeGitHubHttp.pipe(
          Effect.provideService(ProviderAuthentication, { session: () => credentials.session() }),
          Effect.provideService(ProviderHttp, {
            get: (url, token) => {
              expect(Option.map(token, Redacted.value)).toEqual(Option.some('primary_canary'))

              if (outcome === 'rejected') return Effect.fail(new AuthenticationRequired())

              if (url.endsWith('/user'))
                return outcome === 'app-token'
                  ? Effect.fail(new RepositoryUnavailable())
                  : Effect.succeed({ headers: {}, body: { id: 42, login: 'verified-user' } })

              return Effect.succeed({ headers: {}, body: [] })
            },
          }),
        )

        const repository = Option.getOrThrow(
          provider.recognizeRemote({
            name: 'origin',
            destination: 'git@github.com:owner/repo.git',
            transport: 'ssh',
            credentials: { _tag: 'NotApplicable' },
          }),
        )

        if (outcome === 'rejected') {
          const error = yield* repository.inspectAuthentication().pipe(Effect.flip)
          expect(error).toMatchObject({
            _tag: 'GitHubAuthenticationError',
            source: 'GH_TOKEN',
            reason: 'rejected',
          })

          const readError = yield* repository
            .listOpenPullRequests({ scope: 'repository', cursor: Option.none() })
            .pipe(Effect.flip)

          expect(readError).toMatchObject({
            _tag: 'GitHubAuthenticationError',
            source: 'GH_TOKEN',
            reason: 'rejected',
          })
        } else {
          expect(yield* repository.inspectAuthentication()).toEqual({
            _tag: 'Authenticated',
            source: 'GH_TOKEN',
            account:
              outcome === 'app-token'
                ? Option.none()
                : Option.some({ id: '42', displayName: 'verified-user' }),
          })
          expect(
            (yield* repository.listOpenPullRequests({ scope: 'repository', cursor: Option.none() }))
              .items,
          ).toEqual([])
        }
      }
    }),
)

it.effect('timeout and cancellation terminate the CLI process group', () =>
  Effect.gen(function* () {
    for (const timeout of [true, false]) {
      const directory = yield* fixture(`
        const {spawn} = require('node:child_process');
        const {writeFileSync} = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
        child.on('spawn', () => writeFileSync(process.env.PATH+'/ready', JSON.stringify([process.pid, child.pid])));
        setInterval(()=>{},1000);
      `)

      const running = yield* GitHubCredentials.use((credentials) => credentials.session()).pipe(
        Effect.provide(makeGitHubCredentialsLayer({ PATH: directory })),
        Effect.forkChild,
      )

      while (!existsSync(join(directory, 'ready'))) yield* Effect.yieldNow

      const pids = yield* Effect.promise(() => readFile(join(directory, 'ready'), 'utf8')).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))),
      )

      if (timeout) {
        yield* TestClock.adjust('12 seconds')
        expect(yield* Fiber.join(running).pipe(Effect.flip)).toMatchObject({
          reason: 'unavailable',
        })
      } else yield* Fiber.interrupt(running)

      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    }
  }),
)
