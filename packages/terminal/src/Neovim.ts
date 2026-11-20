import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EmbeddedTerminalRenderable } from '@opentui/core'
import { Context, Effect, Layer, Schedule, Schema } from 'effect'
import { attach } from 'neovim'
import { createLogger } from 'winston'

import { editorLua } from './EditorScript'
import type { EditorDisplay } from './TerminalConfig'

export class EditorError extends Schema.TaggedError<EditorError>()('EditorError', {
  message: Schema.String,
}) {}

export const Fingerprint = Schema.Struct({
  path: Schema.String,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

export interface Fingerprint extends Schema.Schema.Type<typeof Fingerprint> {}

const HunkMovement = Schema.Struct({
  moved: Schema.Boolean,
  path: Schema.String,
  reviewed: Schema.Boolean,
})

export interface HunkMovement extends Schema.Schema.Type<typeof HunkMovement> {}

export class Neovim extends Context.Service<
  Neovim,
  {
    readonly open: (
      path: string,
      base: string,
      readonly: boolean,
    ) => Effect.Effect<string, EditorError>
    readonly fingerprint: () => Effect.Effect<Fingerprint, EditorError>
    readonly display: (settings: EditorDisplay) => Effect.Effect<void, EditorError>
    readonly hunk: (direction: number, edge?: boolean) => Effect.Effect<HunkMovement, EditorError>
    readonly reset: () => Effect.Effect<void, EditorError>
    readonly quit: () => Effect.Effect<void, EditorError>
  }
>()('duff/terminal/Neovim') {}

export interface EditorOptions {
  readonly root: string
  readonly command: ReadonlyArray<string>
  readonly environment: NodeJS.ProcessEnv
  readonly terminal: EmbeddedTerminalRenderable
  readonly notification: (method: string, args: ReadonlyArray<unknown>) => void
  readonly exited: (code: number) => void
}

const editorFailure = () =>
  new EditorError({ message: 'Neovim operation failed. Check the editor pane for diagnostics.' })

export const makeNeovimLayer = (options: EditorOptions) =>
  Layer.effect(
    Neovim,
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), 'duff-nvim-')),
          catch: editorFailure,
        }),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )

      const address = join(directory, 'rpc')

      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn([...options.command, '--listen', address], {
              cwd: options.root,
              env: { ...options.environment, TERM: 'xterm-256color' },
              terminal: {
                cols: Math.max(20, options.terminal.width),
                rows: Math.max(4, options.terminal.height),
                data: (_terminal, data) => options.terminal.write(data),
              },
              onExit: (_child, code) => options.exited(code ?? 1),
            }),
          catch: () =>
            new EditorError({
              message:
                'Could not launch Neovim. Install nvim or supply --editor with a Neovim command.',
            }),
        }),
        (child) =>
          Effect.promise(async () => {
            options.terminal.onData = undefined
            options.terminal.onTerminalResize = undefined
            child.kill('SIGKILL')
            await child.exited
            child.terminal?.close()
          }),
      )

      options.terminal.onData = (data) => child.terminal?.write(data)
      options.terminal.onTerminalResize = (cols, rows) => child.terminal?.resize(cols, rows)

      const socket = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
              const socket = createConnection(address)
              socket.once('connect', () => resolve(socket))
              socket.once('error', (error) => {
                socket.destroy()
                reject(error)
              })
            }),
          catch: editorFailure,
        }).pipe(Effect.retry({ schedule: Schedule.spaced('25 millis'), times: 200 })),
        (socket) => Effect.sync(() => socket.destroy()),
      )

      const client = attach({
        reader: socket,
        writer: socket,
        options: { logger: createLogger({ silent: true }) },
      })

      options.terminal.onTerminalResize = (cols, rows) => {
        child.terminal?.resize(cols, rows)
        client.notify('nvim_exec_lua', [
          'local cols, rows = ...; vim.o.columns = cols; vim.o.lines = rows; vim.cmd("redraw!")',
          [cols, rows],
        ])
      }

      client.on('notification', options.notification)

      const channel = yield* Effect.tryPromise({
        try: () => client.channelId,
        catch: editorFailure,
      }).pipe(Effect.timeout('10 seconds'), Effect.mapError(editorFailure))

      yield* Effect.tryPromise({
        try: () => client.lua(editorLua, [channel]),
        catch: editorFailure,
      }).pipe(Effect.timeout('10 seconds'), Effect.mapError(editorFailure))

      return Neovim.of({
        display: Effect.fn('Neovim.display')(function* (settings) {
          yield* Effect.tryPromise({
            try: () =>
              client.lua('DuffReview.display(...)', [
                settings.focusMode,
                settings.showRemovedLines,
                settings.focusContext,
              ]),
            catch: editorFailure,
          })
        }),
        open: Effect.fn('Neovim.open')(function* (path, base, readonly) {
          const hash = yield* Effect.tryPromise({
            try: () => client.lua('return DuffReview.open(...)', [path, base, readonly]),
            catch: editorFailure,
          })

          return yield* Schema.decodeUnknownEffect(Schema.String)(hash).pipe(
            Effect.mapError(editorFailure),
          )
        }),
        fingerprint: Effect.fn('Neovim.fingerprint')(function* () {
          const value = yield* Effect.tryPromise({
            try: () => client.lua('return DuffReview.fingerprint()'),
            catch: editorFailure,
          })

          return yield* Schema.decodeUnknownEffect(Fingerprint)(value).pipe(
            Effect.mapError(editorFailure),
          )
        }),
        hunk: Effect.fn('Neovim.hunk')(function* (direction, edge = false) {
          const movement = yield* Effect.tryPromise({
            try: () => client.lua('return DuffReview.hunk(...)', [direction, edge]),
            catch: editorFailure,
          })

          return yield* Schema.decodeUnknownEffect(HunkMovement)(movement).pipe(
            Effect.mapError(editorFailure),
          )
        }),
        reset: Effect.fn('Neovim.reset')(function* () {
          yield* Effect.tryPromise({
            try: () => client.lua('DuffReview.reset()'),
            catch: editorFailure,
          })
        }),
        quit: Effect.fn('Neovim.quit')(function* () {
          yield* Effect.try({
            try: () => client.notify('nvim_command', ['confirm qall']),
            catch: editorFailure,
          })
        }),
      })
    }),
  )
