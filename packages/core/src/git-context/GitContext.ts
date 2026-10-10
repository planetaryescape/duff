import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect'

export const ConfigValue = Schema.Struct({
  scope: Schema.Literals(['system', 'global', 'local', 'worktree', 'command', 'unknown']),
  origin: Schema.String,
  value: Schema.String,
})

export interface ConfigValue extends Schema.Schema.Type<typeof ConfigValue> {}

const CredentialHelper = Schema.Struct({
  scope: ConfigValue.fields.scope,
  origin: Schema.String,
  target: Schema.Literals(['unqualified', 'URL-scoped']),
  strategy: Schema.String,
})

const CredentialPolicy = Schema.Union([
  Schema.TaggedStruct('Http', {
    helpers: Schema.Array(CredentialHelper),
    username: Schema.optional(ConfigValue),
    useHttpPath: ConfigValue,
  }),
  Schema.TaggedStruct('Unresolved', { reason: Schema.String }),
  Schema.TaggedStruct('NotApplicable', {}),
])

export const GitContextSnapshot = Schema.Struct({
  root: Schema.String,
  name: Schema.optional(ConfigValue),
  email: Schema.optional(ConfigValue),
  author: Schema.optional(Schema.String),
  committer: Schema.optional(Schema.String),
  remotes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      destination: Schema.String,
      transport: Schema.Literals(['https', 'http', 'ssh', 'local', 'other']),
      credentials: CredentialPolicy,
    }),
  ),
  helpers: Schema.Array(CredentialHelper),
  sshCommandConfigured: Schema.Boolean,
})

export interface GitContextSnapshot extends Schema.Schema.Type<typeof GitContextSnapshot> {}

export class GitContextError extends Schema.TaggedError<GitContextError>()('GitContextError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class GitContext extends Context.Service<
  GitContext,
  {
    readonly inspect: (directory: string) => Effect.Effect<GitContextSnapshot, GitContextError>
  }
>()('duff/GitContext') {}

const execute = promisify(execFile)

const safeFailure = (operation: string) =>
  new GitContextError({
    operation,
    message: `Cannot ${operation}. Check that Git is installed, the folder is a repository, and its configuration is valid. Raw Git diagnostics are hidden because they may contain credentials.`,
  })

function helperStrategy(value: string): string {
  if (value === '') return 'Reset preceding helpers'

  if (
    ['osxkeychain', 'manager', 'manager-core', 'wincred', 'libsecret', 'cache', 'store'].includes(
      value,
    )
  )
    return value

  if (value.startsWith('!')) return 'Custom shell helper (command hidden)'

  return 'Custom helper (command and arguments hidden)'
}

type RemoteDestination = Pick<GitContextSnapshot['remotes'][number], 'destination' | 'transport'>

function remoteDestination(raw: Redacted.Redacted): RemoteDestination {
  const value = Redacted.value(raw)

  try {
    const url = new URL(value)

    if (['https:', 'http:', 'ssh:'].includes(url.protocol)) {
      const transport = Match.value(url.protocol).pipe(
        Match.when('https:', (): RemoteDestination['transport'] => 'https'),
        Match.when('http:', (): RemoteDestination['transport'] => 'http'),
        Match.orElse((): RemoteDestination['transport'] => 'ssh'),
      )

      return { destination: `${url.protocol}//${url.host}${url.pathname}`, transport }
    }

    if (url.protocol === 'file:')
      return { destination: 'Local repository (path hidden)', transport: 'local' }
  } catch {
    const scp = /^(?:[^@/:]+@)?([a-zA-Z0-9.-]+):([^?#]+)(?:[?#].*)?$/.exec(value)

    if (scp?.[1] && scp[2]) return { destination: `${scp[1]}:${scp[2]}`, transport: 'ssh' }

    if (/^(?:\/|\.\.?\/)/.test(value))
      return { destination: 'Local repository (path hidden)', transport: 'local' }
  }

  return { destination: 'Unsupported remote (URL hidden)', transport: 'other' }
}

export const makeGitContextLayer = (environment: NodeJS.ProcessEnv) =>
  Layer.effect(
    GitContext,
    Effect.gen(function* () {
      const env = { ...environment }

      const git = Effect.fn('GitContext.git')(function* (
        root: string,
        args: ReadonlyArray<string>,
        operation: string,
        emptyExit?: number,
        input?: string,
      ) {
        const output = yield* Effect.tryPromise({
          try: async (signal) => {
            try {
              const pending = execute('git', ['--no-pager', '-C', root, ...args], {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                signal,
                env,
              })

              const [result] = await Promise.all([
                pending,
                pending.child.stdin
                  ? pipeline(
                      Readable.from(input === undefined ? [] : [input]),
                      pending.child.stdin,
                      { signal },
                    )
                  : Promise.resolve(),
              ])

              return Redacted.make(result.stdout)
            } catch (cause) {
              if (
                emptyExit !== undefined &&
                cause instanceof Error &&
                'code' in cause &&
                cause.code === emptyExit
              )
                return Redacted.make('')
              throw safeFailure(operation)
            }
          },
          catch: () => safeFailure(operation),
        })

        return output
      })

      const config = Effect.fn('GitContext.config')(function* (root: string, key: string) {
        const raw = yield* git(
          root,
          ['config', '--includes', '--null', '--show-origin', '--show-scope', '--get', key],
          'read identity configuration',
          1,
        )

        const output = Redacted.value(raw)

        if (!output) return undefined
        const fields = output.split('\0')

        return yield* Schema.decodeUnknownEffect(ConfigValue)({
          scope: fields[0],
          origin: fields[1],
          value: fields[2],
        }).pipe(Effect.mapError(() => safeFailure('decode identity configuration')))
      })

      const identity = Effect.fn('GitContext.identity')(function* (root: string, variable: string) {
        const raw = yield* git(root, ['var', variable], 'resolve commit identity', 128)
        const output = Redacted.value(raw)

        if (!output) return undefined
        const match = /^(.* <[^<>\n]*>) [0-9]+ [+-][0-9]{4}\n?$/.exec(output)

        return yield* Schema.decodeUnknownEffect(Schema.String)(match?.[1]).pipe(
          Effect.mapError(() => safeFailure('decode commit identity')),
        )
      })

      const inspect = Effect.fn('GitContext.inspect')(function* (directory: string) {
        const root = Redacted.value(
          yield* git(directory, ['rev-parse', '--show-toplevel'], 'locate repository'),
        ).trim()

        const name = yield* config(root, 'user.name')
        const email = yield* config(root, 'user.email')
        const author = yield* identity(root, 'GIT_AUTHOR_IDENT')
        const committer = yield* identity(root, 'GIT_COMMITTER_IDENT')

        const names = Redacted.value(yield* git(root, ['remote'], 'list remotes'))
          .trim()
          .split('\n')
          .filter(Boolean)

        const rawHelpers = yield* git(
          root,
          [
            'config',
            '--includes',
            '--null',
            '--show-origin',
            '--show-scope',
            '--get-regexp',
            '^credential(\\..*)?\\.(helper|username|usehttppath)$',
          ],
          'read credential declarations',
          1,
        )

        const tokens = Redacted.value(rawHelpers).split('\0')
        const helpers: GitContextSnapshot['helpers'][number][] = []
        const declarations: { key: string; record: ConfigValue }[] = []

        for (let index = 0; index < tokens.length - 1; index += 3) {
          const entry = tokens[index + 2]
          const separator = entry?.indexOf('\n') ?? -1

          if (!entry) return yield* safeFailure('decode credential declarations')
          const key = separator === -1 ? entry : entry.slice(0, separator)

          if (separator === -1 && !key.endsWith('.usehttppath'))
            return yield* safeFailure('decode credential declarations')

          const record = yield* Schema.decodeUnknownEffect(ConfigValue)({
            scope: tokens[index],
            origin: tokens[index + 1],
            value: separator === -1 ? 'true' : entry.slice(separator + 1),
          }).pipe(Effect.mapError(() => safeFailure('decode credential declarations')))

          declarations.push({ key, record })

          if (key.endsWith('.helper'))
            helpers.push({
              scope: record.scope,
              origin: record.origin,
              target: key === 'credential.helper' ? 'unqualified' : 'URL-scoped',
              strategy: helperStrategy(record.value),
            })
        }

        const credentials = Effect.fn('GitContext.credentials')(function* (
          raw: Redacted.Redacted,
          transport: string,
        ) {
          if (transport !== 'http' && transport !== 'https')
            return CredentialPolicy.make({ _tag: 'NotApplicable' })
          const url = new URL(Redacted.value(raw))

          if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            /[%\\\s]|\/\.{1,2}(?:\/|$)/.test(Redacted.value(raw))
          ) {
            return CredentialPolicy.make({
              _tag: 'Unresolved',
              reason:
                'Remote uses userinfo or nonstandard path encoding; credential selection is not resolved safely.',
            })
          }

          const patterns = declarations.map(({ key }) =>
            key.slice('credential.'.length, key.lastIndexOf('.')),
          )

          if (
            patterns.some(
              (pattern) =>
                pattern &&
                !/^https?:\/\/(?:[a-z0-9-]+|\*)(?:\.(?:[a-z0-9-]+|\*))*(?::[0-9]+)?(?:\/[^%?#\\\s]*)?$/i.test(
                  pattern,
                ),
            )
          ) {
            return CredentialPolicy.make({
              _tag: 'Unresolved',
              reason:
                'Partial, user-qualified, or nonstandard credential patterns are configured; selection is not resolved.',
            })
          }

          const markers = patterns
            .map((pattern, index) =>
              pattern
                ? `[credential ${JSON.stringify(pattern)}]\nmarker${index} = true\n`
                : `[credential]\nmarker${index} = true\n`,
            )
            .join('')

          const query = `${url.protocol}//${url.host}/${url.pathname.replace(/^\/+|\/+$/g, '')}`

          const matched = new Set(
            Redacted.value(
              yield* git(
                root,
                ['config', '--file', '-', '--get-urlmatch', 'credential', query],
                'match credential configuration',
                1,
                markers,
              ),
            )
              .trim()
              .split('\n')
              .map((line) => line.split(' ')[0]),
          )

          const selected: GitContextSnapshot['helpers'][number][] = []
          let username: ConfigValue | undefined
          let useHttpPath: ConfigValue = { scope: 'unknown', origin: 'Git default', value: 'false' }

          for (const [index, { key, record }] of declarations.entries()) {
            if (!matched.has(`credential.marker${index}`)) continue

            if (key.endsWith('.helper')) {
              if (record.value === '') selected.length = 0
              else
                selected.push({
                  scope: record.scope,
                  origin: record.origin,
                  target: patterns[index] ? 'URL-scoped' : 'unqualified',
                  strategy: helperStrategy(record.value),
                })
            } else if (key.endsWith('.username')) username = record
            else {
              const normalized = yield* git(
                root,
                ['config', '--file', '-', '--type=bool', '--get', 'credential.useHttpPath'],
                'decode credential path policy',
                undefined,
                `[credential]\nuseHttpPath = ${JSON.stringify(record.value)}\n`,
              )

              useHttpPath = { ...record, value: Redacted.value(normalized).trim() }
            }
          }

          return CredentialPolicy.make({ _tag: 'Http', helpers: selected, username, useHttpPath })
        })

        const remotes = yield* Effect.forEach(
          names,
          Effect.fn('GitContext.remote')(function* (name) {
            const raw = Redacted.make(
              Redacted.value(
                yield* git(root, ['remote', 'get-url', '--', name], 'read remote destination'),
              ).trim(),
            )

            const remote = remoteDestination(raw)

            return { name, ...remote, credentials: yield* credentials(raw, remote.transport) }
          }),
        )

        const sshCommand = yield* git(
          root,
          ['config', '--includes', '--get', 'core.sshCommand'],
          'read SSH strategy',
          1,
        )

        let snapshot: GitContextSnapshot = {
          root,
          remotes,
          helpers,
          sshCommandConfigured: Boolean(
            Redacted.value(sshCommand) || env.GIT_SSH_COMMAND || env.GIT_SSH,
          ),
        }

        if (name) snapshot = { ...snapshot, name }

        if (email) snapshot = { ...snapshot, email }

        if (author) snapshot = { ...snapshot, author }

        if (committer) snapshot = { ...snapshot, committer }

        return GitContextSnapshot.make(snapshot)
      })

      return GitContext.of({ inspect })
    }),
  )
