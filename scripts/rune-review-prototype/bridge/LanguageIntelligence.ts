import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { type Review, ReviewError } from '@duff/core/review'
import { RevisionSources, type RevisionSource } from '@duff/core/revision-sources'
import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Semaphore } from 'effect'
import {
  createSourceFile,
  isImportTypeNode,
  isJSDocImportTag,
  isLiteralTypeNode,
  isStringLiteral,
  type Node,
  parseConfigFileTextToJson,
  preProcessFile,
  ScriptTarget,
} from 'typescript'
import { CancellationTokenSource, createMessageConnection } from 'vscode-jsonrpc/node.js'

const limited =
  'Limited: immutable TS/JS and JSON/JSONC inputs only; exact external dependencies, generated files, other languages and project TypeScript are not supplied. Config options are restricted. Tooling runs with your account privileges, not in an OS sandbox.'

const unavailable = () =>
  new ReviewError({
    operation: 'language',
    message: 'Language analysis unavailable, cancelled, or timed out.',
  })

const Position = Schema.Struct({ line: Schema.Int, character: Schema.Int })

const Range = Schema.Struct({ start: Position, end: Position })

const Location = Schema.Struct({ uri: Schema.String, range: Range })

const LocationLink = Schema.Struct({ targetUri: Schema.String, targetSelectionRange: Range })

const Markup = Schema.Struct({ value: Schema.String })

const MarkedStrings = Schema.Array(Schema.Union([Schema.String, Markup]))

const Hover = Schema.NullOr(
  Schema.Struct({
    contents: Schema.Union([Schema.String, Markup, MarkedStrings]),
  }),
)

const Locations = Schema.Array(Schema.Union([Location, LocationLink]))

const Definitions = Schema.NullOr(Schema.Union([Location, Locations]))

/** A query into a displayed diff side, using zero-based UTF-16 source positions. */
export interface LanguageQuery {
  readonly session: string
  readonly path: string
  readonly side: 'old' | 'new'
  readonly line: number
  readonly character: number
}

/** Bounded immutable Git source excerpt; never an arbitrary server URI. */
export interface DefinitionTarget {
  readonly path: string
  readonly commit: string
  readonly line: number
  readonly character: number
  readonly startLine: number
  readonly text: string
}

interface Server {
  readonly hover: (
    path: string,
    line: number,
    character: number,
    signal: AbortSignal,
  ) => Promise<string>
  readonly definition: (
    path: string,
    line: number,
    character: number,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<DefinitionTarget>>
  readonly close: () => Promise<void>
}

const CompilerOptions = Schema.Struct({
  strict: Schema.optionalKey(Schema.Boolean),
  target: Schema.optionalKey(Schema.String),
  module: Schema.optionalKey(Schema.String),
  moduleResolution: Schema.optionalKey(Schema.String),
  jsx: Schema.optionalKey(Schema.String),
  allowJs: Schema.optionalKey(Schema.Boolean),
  checkJs: Schema.optionalKey(Schema.Boolean),
  esModuleInterop: Schema.optionalKey(Schema.Boolean),
  allowSyntheticDefaultImports: Schema.optionalKey(Schema.Boolean),
  resolveJsonModule: Schema.optionalKey(Schema.Boolean),
  skipLibCheck: Schema.optionalKey(Schema.Boolean),
  lib: Schema.optionalKey(Schema.Array(Schema.String)),
  baseUrl: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  rootDirs: Schema.optionalKey(Schema.Array(Schema.String)),
  typeRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  types: Schema.optionalKey(Schema.Array(Schema.String)),
})

const Config = Schema.Struct({
  compilerOptions: Schema.optionalKey(CompilerOptions),
  extends: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
})

const Package = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  types: Schema.optionalKey(Schema.String),
  typings: Schema.optionalKey(Schema.String),
  main: Schema.optionalKey(Schema.String),
  module: Schema.optionalKey(Schema.String),
  exports: Schema.optionalKey(Schema.Json),
  imports: Schema.optionalKey(Schema.Json),
  typesVersions: Schema.optionalKey(Schema.Json),
})

function safePackageTarget(root: string, base: string, value: Schema.Json): boolean {
  if (Schema.is(Schema.String)(value)) return safeImport(root, base, value)

  if (Schema.is(Schema.Array(Schema.Json))(value))
    return value.every((entry) => safePackageTarget(root, base, entry))

  if (Schema.is(Schema.JsonObject)(value))
    return Object.values(value).every((entry) => safePackageTarget(root, base, entry))

  return true
}

function internal(root: string, path: string): boolean {
  const child = resolve(root, path)

  return (
    !path.includes(':') &&
    !path.includes('\\') &&
    (child === root || child.startsWith(`${root}${sep}`))
  )
}

// Only discovered project configs and package metadata are projected, never application JSON.
// No plugins, package-manager paths, output emission, or outside-root configuration survives.
function safeJson(root: string, path: string, text: string): string {
  const parsed = parseConfigFileTextToJson(path, text)
  const base = dirname(join(root, path))

  if (/(?:^|\/)package\.json$/i.test(path)) {
    const packageJson = Schema.decodeUnknownOption(Package)(parsed.config)

    if (
      parsed.error ||
      Option.isNone(packageJson) ||
      !safePackageTarget(root, base, packageJson.value)
    )
      return '{}'

    return JSON.stringify(packageJson.value)
  }

  const config = Schema.decodeUnknownOption(Config)(parsed.config)

  if (parsed.error || Option.isNone(config)) return '{}'

  const value = config.value

  if (Object.keys(value).length === 0) return text

  const paths = [
    ...(value.files ?? []),
    ...(value.include ?? []),
    ...(value.exclude ?? []),
    ...(value.references?.map((entry) => entry.path) ?? []),
    ...(value.compilerOptions?.rootDirs ?? []),
    ...(value.compilerOptions?.typeRoots ?? []),
    ...(value.compilerOptions?.baseUrl ? [value.compilerOptions.baseUrl] : []),
    ...Object.values(value.compilerOptions?.paths ?? {}).flat(),
  ]

  const extensions =
    value.extends === undefined
      ? []
      : Schema.is(Schema.String)(value.extends)
        ? [value.extends]
        : value.extends

  // TS accepts explicit config extensions. Never let an unprojected file become config.
  if (
    extensions.some((entry) => entry.startsWith('.') && !entry.endsWith('.json')) ||
    value.references?.some((entry) => /\.[^/]+$/.test(entry.path) && !entry.path.endsWith('.json'))
  )
    throw new Error('Unsupported configuration reference')

  if (
    [...paths, ...extensions].some(
      (entry) =>
        entry.includes(':') ||
        entry.includes('\\') ||
        !internal(root, relative(root, resolve(base, entry))),
    ) ||
    Object.values(value.compilerOptions?.paths ?? {})
      .flat()
      .some(
        (entry) =>
          !internal(
            root,
            relative(root, resolve(base, value.compilerOptions?.baseUrl ?? '.', entry)),
          ),
      ) ||
    value.compilerOptions?.lib?.some((entry) => !/^[a-zA-Z0-9.]+$/.test(entry)) ||
    value.compilerOptions?.types?.some((entry) => !safeImport(root, base, entry))
  )
    return '{}'

  return JSON.stringify({
    ...value,
    // Package-based extends requires external context and must not search ancestors.
    extends: extensions.filter((entry) => entry.startsWith('.') && entry.endsWith('.json')),
    references: value.references,
    compilerOptions: {
      ...value.compilerOptions,
      noEmit: true,
      disableSourceOfProjectReferenceRedirect: true,
    },
    typeAcquisition: { enable: false },
  })
}

function configurationPaths(root: string, files: ReadonlyArray<RevisionSource>): Set<string> {
  const identity = (path: string) => path.normalize('NFC').toLowerCase()
  const sources = new Map(files.map((file) => [identity(file.path), file]))
  const paths = new Set<string>()
  const pending: RevisionSource[] = []

  const include = (path: string) => {
    const source = sources.get(identity(path))

    if (!source || paths.has(source.path)) return

    paths.add(source.path)
    pending.push(source)
  }

  for (const file of files)
    if (/(?:^|\/)(?:tsconfig|jsconfig)\.json$/i.test(file.path)) include(file.path)

  for (const source of pending) {
    // Validate each reachable config before following its references. Cycles are visited once.
    safeJson(root, source.path, source.text)
    const parsed = parseConfigFileTextToJson(source.path, source.text)
    const config = Schema.decodeUnknownOption(Config)(parsed.config)

    if (parsed.error || Option.isNone(config)) continue

    const extensions = config.value.extends

    const inherited =
      extensions === undefined
        ? []
        : Schema.is(Schema.String)(extensions)
          ? [extensions]
          : extensions

    const base = dirname(join(root, source.path))

    for (const path of inherited)
      if (path.startsWith('.') && path.endsWith('.json'))
        include(relative(root, resolve(base, path)).split(sep).join('/'))

    for (const reference of config.value.references ?? []) {
      const path = reference.path.endsWith('.json')
        ? reference.path
        : join(reference.path, 'tsconfig.json')

      include(relative(root, resolve(base, path)).split(sep).join('/'))
    }
  }

  return paths
}

function safeImport(root: string, base: string, path: string): boolean {
  if (path.includes(':') || path.includes('\\') || path.startsWith('/')) return false

  if (path.startsWith('.')) return internal(root, relative(root, resolve(base, path)))

  return !path.split('/').includes('..')
}

async function verifySources(root: string, files: ReadonlyArray<RevisionSource>) {
  // Missing dependencies must stay missing: never fall through to an ancestor checkout's install.
  const ancestors: string[] = []
  let parent = dirname(root)

  while (true) {
    ancestors.push(join(parent, 'node_modules'))

    if (dirname(parent) === parent) break
    parent = dirname(parent)
  }

  const present = await Promise.all(
    ancestors.map((path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    ),
  )

  if (present.some((entry) => entry)) throw new Error('Ancestor dependencies unavailable')

  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue
    const info = preProcessFile(file.text, true, true)

    const references = [
      ...info.importedFiles,
      ...info.referencedFiles,
      ...info.typeReferenceDirectives,
    ]

    // getChildren includes every attached JSDoc block, unlike preProcessFile/forEachChild.
    const source = createSourceFile(file.path, file.text, ScriptTarget.Latest, true)

    const visit = (node: Node): void => {
      const specifier =
        isImportTypeNode(node) && isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : isJSDocImportTag(node)
            ? node.moduleSpecifier
            : undefined

      if (
        specifier &&
        isStringLiteral(specifier) &&
        !safeImport(root, dirname(join(root, file.path)), specifier.text)
      )
        throw new Error('Outside revision reference')

      for (const child of node.getChildren(source)) visit(child)
    }

    visit(source)

    if (
      references.some(
        (entry) => !safeImport(root, dirname(join(root, file.path)), entry.fileName),
      ) ||
      info.libReferenceDirectives.some((entry) => !/^[a-zA-Z0-9.]+$/.test(entry.fileName))
    )
      throw new Error('Outside revision reference')
  }
}

async function waitForExit(exit: Promise<void>, millis: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), millis)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForGroup(pid: number, attempts: number): Promise<boolean> {
  try {
    process.kill(-pid, 0)
  } catch {
    return true
  }

  if (attempts === 0) return false

  await new Promise<void>((resolve) => setTimeout(resolve, 25))

  return waitForGroup(pid, attempts - 1)
}

async function makeServer(
  files: ReadonlyArray<RevisionSource>,
  commit: string,
  systemRoot: string | undefined,
  signal: AbortSignal,
): Promise<Server> {
  const executable = fileURLToPath(import.meta.resolve('typescript-language-server/lib/cli.mjs'))
  const tsserver = fileURLToPath(import.meta.resolve('typescript/lib/tsserver.js'))
  const root = await mkdtemp(join(tmpdir(), 'duff-language-'))
  const sources = new Map(files.map((file) => [file.path, file.text]))
  const configs = new Set<string>()

  async function writeSources(index: number): Promise<void> {
    const written = await Promise.allSettled(
      files.slice(index, index + 8).map(async (file) => {
        signal.throwIfAborted()
        const path = join(root, file.path)

        await mkdir(dirname(path), { recursive: true })
        await writeFile(
          path,
          configs.has(file.path) || /(?:^|\/)package\.json$/i.test(file.path)
            ? safeJson(root, file.path, file.text)
            : file.text,
          { mode: 0o400 },
        )
      }),
    )

    const failed = written.find((entry) => entry.status === 'rejected')

    if (failed?.status === 'rejected') throw new Error('Source materialisation failed')

    if (index + 8 < files.length) await writeSources(index + 8)
  }

  try {
    await verifySources(root, files)

    for (const path of configurationPaths(root, files)) configs.add(path)
    await writeSources(0)

    if (!sources.has('tsconfig.json') && !sources.has('jsconfig.json'))
      await writeFile(
        join(root, 'tsconfig.json'),
        '{"compilerOptions":{"allowJs":true,"noEmit":true,"jsx":"preserve"},"typeAcquisition":{"enable":false}}',
        { mode: 0o400 },
      )
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  // Only trusted toolchain paths are executed. NODE_OPTIONS/PATH/project environment are not inherited.
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=256', executable, '--stdio', '--log-level', '1'],
    {
      cwd: root,
      env: { HOME: root, TMPDIR: root, SystemRoot: systemRoot },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )

  const exit = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })

  const connection = createMessageConnection(child.stdout, child.stdin)
  let bytes = 0

  // A lifetime cap also bounds the JSON-RPC reader's partially received message buffer.
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length

    if (bytes > 8 * 1024 * 1024) child.stdout.destroy(new Error('Language output limit'))
  })
  child.stdout.on('error', () => connection.dispose())
  child.stdin.on('error', () => connection.dispose())
  connection.onRequest(() => null)
  connection.listen()
  let closed: Promise<void> | undefined
  let inflight = 0

  async function request(method: string, params: Schema.Json, caller: AbortSignal, millis = 5000) {
    if (inflight >= 8) throw new Error('Language concurrency limit')

    const bounded = AbortSignal.any([caller, AbortSignal.timeout(millis)])
    const token = new CancellationTokenSource()
    let aborted: (() => void) | undefined

    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        token.cancel()
        reject(new Error('Language request cancelled'))
      }

      bounded.addEventListener('abort', aborted, { once: true })

      if (bounded.aborted) aborted()
    })

    try {
      inflight += 1

      const pending = connection.sendRequest<unknown>(method, params, token.token).finally(() => {
        inflight -= 1
      })

      const result = await Promise.race([pending, cancelled])
      bounded.throwIfAborted()

      return result
    } finally {
      if (aborted) bounded.removeEventListener('abort', aborted)
      token.dispose()
    }
  }

  function close() {
    closed ??= (async () => {
      await request('shutdown', null, AbortSignal.timeout(1000), 1000).catch(() => undefined)
      await connection.sendNotification('exit').catch(() => undefined)
      await waitForExit(exit, 1000)
      connection.dispose()
      child.stdin.destroy()

      if (process.platform === 'win32') {
        if (child.exitCode === null && child.pid)
          await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(
            () => undefined,
          )
      } else if (child.pid) {
        // Signal the entire owned group even if the LSP leader already exited.
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* Group already gone. */
        }

        if (!(await waitForGroup(child.pid, 40))) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* Group already gone. */
          }

          await waitForGroup(child.pid, 40)
        }
      }

      await exit
      await rm(root, { recursive: true, force: true })
    })()

    return closed
  }

  const opened = new Set<string>()

  async function document(path: string, line: number, character: number) {
    const text = sources.get(path)

    if (text === undefined || !/\.[cm]?[jt]sx?$/.test(path))
      throw new Error('Unsupported language source')

    const sourceLine = text.split(/\r?\n/)[line]

    if (
      sourceLine === undefined ||
      character > sourceLine.length ||
      (character > 0 && /[\uDC00-\uDFFF]/u.test(sourceLine.charAt(character)))
    )
      throw new Error('Invalid source position')

    const uri = pathToFileURL(join(root, path)).href

    if (!opened.has(path)) {
      await connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: path.endsWith('tsx')
            ? 'typescriptreact'
            : path.endsWith('jsx')
              ? 'javascriptreact'
              : path.endsWith('js')
                ? 'javascript'
                : 'typescript',
          version: 1,
          text,
        },
      })
      opened.add(path)
    }

    return { uri }
  }

  try {
    await request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: { hover: { contentFormat: ['plaintext'] } },
        },
        initializationOptions: {
          disableAutomaticTypingAcquisition: true,
          plugins: [],
          maxTsServerMemory: 256,
          tsserver: {
            path: tsserver,
            fallbackPath: tsserver,
            useSyntaxServer: 'never',
            logVerbosity: 'off',
          },
        },
      },
      signal,
      15000,
    )
    await connection.sendNotification('initialized', {})
    signal.throwIfAborted()

    return {
      close,
      hover: async (path, line, character, signal) => {
        const textDocument = await document(path, line, character)

        const response = Schema.decodeUnknownOption(Hover)(
          await request(
            'textDocument/hover',
            { textDocument, position: { line, character } },
            signal,
          ),
        )

        if (Option.isNone(response)) throw new Error('Invalid hover response')

        if (!response.value) return ''

        const contents = response.value.contents
        const parts = Schema.is(MarkedStrings)(contents) ? contents : [contents]

        return parts
          .map((entry) => (Schema.is(Schema.String)(entry) ? entry : entry.value))
          .join('\n\n')
          .slice(0, 16384)
      },
      definition: async (path, line, character, signal) => {
        const textDocument = await document(path, line, character)

        const response = Schema.decodeUnknownOption(Definitions)(
          await request(
            'textDocument/definition',
            { textDocument, position: { line, character } },
            signal,
          ),
        )

        if (Option.isNone(response)) throw new Error('Invalid definition response')

        const locations =
          response.value === null
            ? []
            : Schema.is(Locations)(response.value)
              ? response.value
              : [response.value]

        const targets: DefinitionTarget[] = []

        for (const location of locations.slice(0, 8)) {
          const uri = 'uri' in location ? location.uri : location.targetUri

          const position =
            'range' in location ? location.range.start : location.targetSelectionRange.start

          // Exact URI identity avoids scheme decoding tricks, traversal, symlinks and outside reads.
          const source = files.find((file) => pathToFileURL(join(root, file.path)).href === uri)

          if (!source || position.line < 0 || position.character < 0) continue
          const lines = source.text.split(/\r?\n/)
          const targetLine = lines[position.line]

          if (
            targetLine === undefined ||
            targetLine.length > 8192 ||
            position.character > targetLine.length
          )
            continue
          const candidate = Math.max(0, position.line - 4)

          const startLine =
            lines.slice(candidate, position.line).join('\n').length > 8192
              ? position.line
              : candidate

          targets.push({
            path: source.path,
            commit,
            line: position.line,
            character: position.character,
            startLine,
            text: lines
              .slice(startLine, position.line + 9)
              .join('\n')
              .slice(0, 16384),
          })
        }

        return targets
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

const acquireServer = (
  files: ReadonlyArray<RevisionSource>,
  commit: string,
  systemRoot: string | undefined,
) =>
  Effect.callback<Server, ReviewError>((resume, signal) => {
    // The callback's interruption finalizer joins startup and its failure cleanup.
    const started = makeServer(files, commit, systemRoot, signal).then(
      (server) => resume(Effect.succeed(server)),
      () => resume(Effect.fail(unavailable())),
    )

    return Effect.promise(() => started)
  })

/** Owned per-review language contexts. Trust is explicit and is never persisted. */
export class LanguageIntelligence extends Context.Service<
  LanguageIntelligence,
  {
    readonly enable: (
      session: string,
      review: Review,
    ) => Effect.Effect<{
      readonly kind: 'language'
      readonly session: string
      readonly state: 'limited' | 'unavailable'
      readonly message: string
    }>
    readonly hover: (
      query: LanguageQuery,
      review: Review,
    ) => Effect.Effect<
      { readonly kind: 'hover'; readonly content: string; readonly message: string },
      ReviewError
    >
    readonly definition: (
      query: LanguageQuery,
      review: Review,
    ) => Effect.Effect<
      {
        readonly kind: 'definition'
        readonly targets: ReadonlyArray<DefinitionTarget>
        readonly message: string
      },
      ReviewError
    >
    readonly disable: (session: string) => Effect.Effect<void>
  }
>()('duff/StandaloneLanguageIntelligence') {
  /** The layer owns both revision processes and releases them when the bridge runtime closes. */
  static readonly layer = (environment: NodeJS.ProcessEnv) =>
    Layer.effect(
      LanguageIntelligence,
      Effect.gen(function* () {
        const sources = yield* RevisionSources
        const gate = yield* Semaphore.make(1)

        let active:
          | {
              readonly session: string
              readonly review: Review
              readonly old: Server
              readonly new: Server
            }
          | undefined

        let query: AbortController | undefined
        let generation = 0

        let starting:
          | { readonly session: string; readonly interrupt: () => Effect.Effect<void> }
          | undefined

        const clear = Effect.fn('LanguageIntelligence.clear')(function* () {
          query?.abort()
          const previous = active
          active = undefined

          if (previous)
            yield* Effect.promise(() => Promise.all([previous.old.close(), previous.new.close()]))
        })

        yield* Effect.addFinalizer(() => clear())

        const start = Effect.fn('LanguageIntelligence.start')(
          function* (session: string, review: Review, requestedGeneration: number) {
            if (requestedGeneration !== generation) return yield* unavailable()

            yield* Effect.withFiber((fiber) =>
              Effect.sync(() => {
                starting = { session, interrupt: () => Fiber.interrupt(fiber) }
              }),
            )
            yield* clear()
            const oldFiles = yield* sources.read(review.root, review.baseCommit)
            const newFiles = yield* sources.read(review.root, review.headCommit)

            const old = yield* Effect.acquireRelease(
              acquireServer(oldFiles, review.baseCommit, environment.SystemRoot),
              (server, exit) =>
                Effect.promise(() => {
                  if (Exit.isSuccess(exit) && active?.old === server) return Promise.resolve()

                  if (active?.old === server) active = undefined

                  return server.close()
                }),
              { interruptible: true },
            )

            const next = yield* Effect.acquireRelease(
              acquireServer(newFiles, review.headCommit, environment.SystemRoot),
              (server, exit) =>
                Effect.promise(() => {
                  if (Exit.isSuccess(exit) && active?.new === server) return Promise.resolve()

                  if (active?.new === server) active = undefined

                  return server.close()
                }),
              { interruptible: true },
            )

            if (requestedGeneration !== generation) return yield* unavailable()

            active = { session, review, old, new: next }

            return {
              kind: 'language' as const,
              session,
              state: 'limited' as const,
              message: limited,
            }
          },
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              starting = undefined
            }),
          ),
          Effect.timeout('30 seconds'),
        )

        const enable = Effect.fn('LanguageIntelligence.enable')(function* (
          session: string,
          review: Review,
        ) {
          generation += 1

          return yield* start(session, review, generation).pipe(
            gate.withPermits(1),
            Effect.catch(() =>
              Effect.succeed({
                kind: 'language' as const,
                session,
                state: 'unavailable' as const,
                message:
                  'Language analysis unavailable. Revision source or startup limits were exceeded.',
              }),
            ),
          )
        })

        const context = Effect.fn('LanguageIntelligence.context')(function* (
          input: LanguageQuery,
          review: Review,
        ) {
          if (
            !active ||
            active.session !== input.session ||
            active.review.baseCommit !== review.baseCommit ||
            active.review.headCommit !== review.headCommit
          )
            return yield* unavailable()
          const change = review.files.find((file) => file.path === input.path)

          if (
            !change ||
            (input.side === 'old' && change.status === 'A') ||
            (input.side === 'new' && change.status === 'D')
          )
            return yield* unavailable()
          const path = input.side === 'old' ? (change.previousPath ?? change.path) : change.path
          query?.abort()
          query = new AbortController()

          return { server: active[input.side], path, signal: query.signal }
        })

        const hover = Effect.fn('LanguageIntelligence.hover')(function* (
          input: LanguageQuery,
          review: Review,
        ) {
          const current = yield* context(input, review)

          const content = yield* Effect.tryPromise({
            try: (signal) =>
              current.server.hover(
                current.path,
                input.line,
                input.character,
                AbortSignal.any([signal, current.signal]),
              ),
            catch: unavailable,
          })

          return {
            kind: 'hover' as const,
            content,
            message: content ? limited : `No hover result. ${limited}`,
          }
        })

        const definition = Effect.fn('LanguageIntelligence.definition')(function* (
          input: LanguageQuery,
          review: Review,
        ) {
          const current = yield* context(input, review)

          const targets = yield* Effect.tryPromise({
            try: (signal) =>
              current.server.definition(
                current.path,
                input.line,
                input.character,
                AbortSignal.any([signal, current.signal]),
              ),
            catch: unavailable,
          })

          return {
            kind: 'definition' as const,
            targets,
            message: targets.length ? limited : `No authorised local definition result. ${limited}`,
          }
        })

        const disable = Effect.fn('LanguageIntelligence.disable')(function* (session: string) {
          generation += 1

          if (starting?.session === session) yield* starting.interrupt()

          if (active?.session === session) yield* clear().pipe(gate.withPermits(1))
        })

        return LanguageIntelligence.of({ enable, hover, definition, disable })
      }),
    )
}
