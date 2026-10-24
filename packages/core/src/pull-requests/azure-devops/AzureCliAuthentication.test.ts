import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { Cause, Effect, Fiber, Option, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'
import { AzureCliAuthentication, makeAzureCliAuthenticationLayer } from './AzureCliAuthentication'
import { makeAzureDevOpsHttp } from './AzureDevOpsHttp'

const fixture = (body: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'duff-azure-cli-'))
      await writeFile(join(directory, 'az'), `#!${process.execPath}\n${body}`, { mode: 0o700 })

      return { directory, env: { PATH: directory } }
    }),
    ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

it.effect(
  'uses a CLI credential for the existing Azure REST page without inventing an account',
  () =>
    Effect.gen(function* () {
      const { env } = yield* fixture(`
      const expected = ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--output', 'json'];
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);
      if (process.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL !== 'no') process.exit(3);
      if (process.env.AZURE_LOGGING_ENABLE_LOG_FILE !== 'false') process.exit(4);
      console.log(JSON.stringify({accessToken:'canary-token', expires_on:4102444800}));
    `)

      const cli = yield* AzureCliAuthentication.pipe(
        Effect.provide(makeAzureCliAuthenticationLayer(env)),
      )

      const provider = yield* makeAzureDevOpsHttp.pipe(
        Effect.provideService(ProviderAuthentication, {
          session: () => cli.session().pipe(Effect.map(Option.some)),
        }),
        Effect.provideService(ProviderHttp, {
          get: (_url, token) => {
            expect(Option.map(token, Redacted.value)).toEqual(Option.some('canary-token'))

            return Effect.succeed({
              headers: {},
              body: {
                count: 1,
                value: [
                  {
                    pullRequestId: 42,
                    title: 'Change',
                    status: 'active',
                    sourceRefName: 'refs/heads/topic',
                    targetRefName: 'refs/heads/main',
                  },
                ],
              },
            })
          },
        }),
      )

      const repository = Option.getOrThrow(
        provider.recognizeRemote({
          name: 'origin',
          destination: 'https://dev.azure.com/acme/Project/_git/Repo',
          transport: 'https',
          credentials: { _tag: 'NotApplicable' },
        }),
      )

      expect(yield* repository.inspectAuthentication()).toEqual({
        _tag: 'Authenticated',
        account: Option.none(),
      })

      const page = yield* repository.listPullRequests({
        scope: 'repository',
        cursor: Option.none(),
        state: 'open',
      })

      expect(page.items.map((item) => item.id)).toEqual(['42'])
      expect(Option.isNone(page.next)).toBe(true)
    }),
)

it.effect('rejects malformed, expired and unsafe credentials without exposing their contents', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(2000)

    yield* Effect.forEach(
      [
        'canary-private-invalid-json',
        JSON.stringify({ accessToken: 'canary-private', expires_on: 2 }),
        JSON.stringify({ accessToken: 'canary-private', expires_on: 1 }),
        JSON.stringify({ accessToken: 'canary-private', expires_on: '4102444800' }),
        JSON.stringify({ accessToken: 'canary-private\r\nInjected: yes', expires_on: 4102444800 }),
        JSON.stringify({ accessToken: 'canary-private\n', expires_on: 4102444800 }),
      ],
      (output) =>
        Effect.gen(function* () {
          const { env } = yield* fixture(`process.stdout.write(${JSON.stringify(output)})`)

          const error = yield* AzureCliAuthentication.use((cli) => cli.session()).pipe(
            Effect.provide(makeAzureCliAuthenticationLayer(env)),
            Effect.flip,
          )

          expect(error).toMatchObject({
            _tag: 'AzureCliAuthenticationError',
            reason: 'invalid-response',
          })
          expect(JSON.stringify(error)).not.toContain('canary-private')
          expect(String(error)).not.toContain('canary-private')
        }),
      { concurrency: 'unbounded' },
    )

    const { env } = yield* fixture(
      `console.log(JSON.stringify({accessToken:'valid',expires_on:3}))`,
    )

    const valid = yield* AzureCliAuthentication.use((cli) => cli.session()).pipe(
      Effect.provide(makeAzureCliAuthenticationLayer(env)),
    )

    expect(Redacted.value(valid.token)).toBe('valid')
    expect(JSON.stringify(valid)).not.toContain('valid')
  }),
)

it.effect('reports missing CLI, known missing-login diagnostics and unknown failures safely', () =>
  Effect.gen(function* () {
    const { directory } = yield* fixture('')

    const missing = yield* AzureCliAuthentication.use((cli) => cli.session()).pipe(
      Effect.provide(makeAzureCliAuthenticationLayer({ PATH: join(directory, 'missing') })),
      Effect.flip,
    )

    expect(missing.reason).toBe('not-installed')

    for (const [diagnostic, reason] of [
      ["Please run 'az login' to setup account.", 'sign-in-required'],
      ["Can't find token from MSAL cache.", 'sign-in-required'],
      ['unknown upstream failure: canary-private', 'unavailable'],
    ]) {
      const { env } = yield* fixture(
        `console.error(${JSON.stringify(diagnostic)}); console.log('canary-private'); process.exit(1)`,
      )

      const error = yield* AzureCliAuthentication.use((cli) => cli.session()).pipe(
        Effect.provide(makeAzureCliAuthenticationLayer(env)),
        Effect.flip,
      )

      expect(error.reason).toBe(reason)
      expect(JSON.stringify(error)).not.toContain('canary-private')
      expect(String(error)).not.toContain(diagnostic)
    }
  }),
)

it.effect('timeout and caller interruption terminate the CLI and its child process', () =>
  Effect.gen(function* () {
    for (const timeout of [false, true]) {
      const { directory, env } = yield* fixture(`
        const {spawn} = require('node:child_process');
        const {writeFileSync} = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
        child.on('spawn', () => writeFileSync(process.env.PATH+'/ready', JSON.stringify([process.pid, child.pid])));
        setInterval(()=>{},1000);
      `)

      const running = yield* AzureCliAuthentication.use((cli) => cli.session()).pipe(
        Effect.provide(makeAzureCliAuthenticationLayer(env)),
        Effect.forkChild,
      )

      while (!existsSync(join(directory, 'ready'))) yield* Effect.yieldNow

      const pids = yield* Effect.promise(() => readFile(join(directory, 'ready'), 'utf8')).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))),
      )

      if (timeout) {
        yield* TestClock.adjust('12 seconds')
        const error = yield* Fiber.join(running).pipe(Effect.flip)
        expect(error.reason).toBe('unavailable')
      } else {
        yield* Fiber.interrupt(running)
        const exit = yield* Fiber.await(running)
        expect(exit._tag === 'Failure' && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }

      for (const pid of pids) {
        while (
          yield* Effect.sync(() => {
            try {
              process.kill(pid, 0)

              return true
            } catch {
              return false
            }
          })
        ) {
          yield* Effect.yieldNow
        }

        expect(() => process.kill(pid, 0)).toThrow()
      }
    }
  }),
)
