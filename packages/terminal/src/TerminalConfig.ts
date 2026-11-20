import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { Effect, Schema } from 'effect'

const FunctionKey = Schema.Literals([
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

const Keys = Schema.Struct({
  focus: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f6'))),
  previousHunk: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f7'))),
  nextHunk: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f8'))),
  markNext: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f9'))),
  focusMode: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f10'))),
  removedLines: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f11'))),
  help: FunctionKey.pipe(Schema.withDecodingDefaultKey(Effect.succeed('f12'))),
}).check(
  Schema.makeFilter(
    (keys) =>
      new Set(Object.values(keys)).size === Object.values(keys).length ||
      'Global navigation keys must be distinct.',
  ),
)

export const EditorDisplay = Schema.Struct({
  focusMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  showRemovedLines: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  focusContext: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(3)),
  ),
})

export interface EditorDisplay extends Schema.Schema.Type<typeof EditorDisplay> {}

export const TerminalSettings = Schema.Struct({
  ...EditorDisplay.fields,
  fileView: Schema.Literals(['list', 'tree']).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('tree')),
  ),
  sidebarWidth: Schema.Int.check(Schema.isBetween({ minimum: 24, maximum: 80 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(40)),
  ),
  icons: Schema.Literals(['text', 'nerd']).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('text')),
  ),
  keys: Keys.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})

export interface TerminalSettings extends Schema.Schema.Type<typeof TerminalSettings> {}

export class TerminalConfigError extends Schema.TaggedError<TerminalConfigError>()(
  'TerminalConfigError',
  {
    message: Schema.String,
  },
) {}

export interface ConfigLocation {
  readonly home: string
  readonly configHome: string | undefined
  readonly path: string | undefined
}

export function terminalConfigPath(location: ConfigLocation): string {
  if (location.path !== undefined) return resolve(location.path)

  const directory =
    location.configHome && isAbsolute(location.configHome)
      ? location.configHome
      : join(location.home, '.config')

  return join(directory, 'duff', 'config.json')
}

export const readTerminalSettings = Effect.fn('TerminalConfig.read')(function* (
  location: ConfigLocation,
) {
  const path = terminalConfigPath(location)

  const contents = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (
          location.path === undefined &&
          Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)
        )
          return '{}'
        throw error
      }
    },
    catch: () =>
      new TerminalConfigError({ message: `Could not read Duff configuration at ${path}.` }),
  })

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TerminalSettings), {
    onExcessProperty: 'error',
  })(contents).pipe(
    Effect.mapError(
      () =>
        new TerminalConfigError({
          message: `Invalid Duff configuration at ${path}. Expected fileView "list" or "tree", sidebarWidth 24..80, icons "text" or "nerd", boolean focusMode/showRemovedLines, focusContext 0..20, and distinct function keys (f1..f12) under keys. Unknown fields are not accepted.`,
        }),
    ),
  )
})
