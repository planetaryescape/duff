import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { makeGitReviewLayer } from '@duff/core/review'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { Effect, Layer, Queue, Schema } from 'effect'
import { parse } from 'shell-quote'

import { EditorTerminal } from './EditorTerminal'
import { makeNeovimLayer } from './Neovim'
import { type Action, initialAppState, ReviewHost } from './ReviewApp'
import { ReviewStore } from './ReviewStore'
import { readTerminalSettings } from './TerminalConfig'
import { makeTerminalControllerLayer, TerminalController } from './TerminalController'
import { makeTerminalReviewLayer, TerminalError } from './TerminalReview'

const help = `Duff terminal review

bun run tui --base main [--repo /path/to/repo] [--editor /path/to/nvim] [--config /path/to/config.json]

Requires Bun 1.3.5+ and Neovim 0.10+ on Linux or macOS.
Reviews committed branch paths against their merge base; buffers are live workspace files.
Uses your normal Neovim configuration. --editor must name a Neovim executable or wrapper,
not a shell alias. Quoted arguments are supported; shell operators are not.
Defaults to DUFF_NVIM, VISUAL, EDITOR, then nvim on PATH. The command must run Neovim.

Config: $XDG_CONFIG_HOME/duff/config.json, otherwise ~/.config/duff/config.json.
Use --check-config to validate configuration without opening the UI.
Defaults: F6 switches focus, F7/F8 move across review hunks and files.
F9 marks viewed and opens the next unread file. F10 folds unchanged code.
F11 shows/hides removed lines. F12 opens help; Escape closes it.
In the sidebar: j/k move, Enter opens at the first diff, h/l fold, t toggles list/tree.
:qa refuses unsaved buffers. :qa! explicitly discards them.
`

const SavedNotification = Schema.Tuple([Schema.String, Schema.String])

const options = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    base: { type: 'string', default: 'main' },
    repo: { type: 'string', default: process.cwd() },
    editor: {
      type: 'string',
      default: process.env.DUFF_NVIM || process.env.VISUAL || process.env.EDITOR || 'nvim',
    },
    help: { type: 'boolean', short: 'h' },
    config: { type: 'string' },
    'check-config': { type: 'boolean' },
  },
})

const program = Effect.gen(function* () {
  const settings = yield* readTerminalSettings({
    home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME,
    path: options.values.config,
  })

  if (options.values['check-config']) {
    yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`))

    return 0
  }

  if (process.platform !== 'linux' && process.platform !== 'darwin')
    return yield* new TerminalError({
      message: 'The terminal client currently supports Linux and macOS only.',
    })

  const editorCommand = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(Schema.String))(
    parse(options.values.editor, process.env),
  ).pipe(
    Effect.mapError(
      () =>
        new TerminalError({
          message:
            'Use a Neovim executable or wrapper with optional quoted arguments, without shell operators.',
        }),
    ),
  )

  const queue = yield* Queue.unbounded<Action>()

  const dispatch = (action: Action) => {
    Queue.offerUnsafe(queue, action)
  }

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const terminate = () => dispatch({ type: 'stop', code: 143 })
      const hangup = () => dispatch({ type: 'stop', code: 129 })
      const interrupt = () => dispatch({ type: 'stop', code: 130 })
      process.on('SIGTERM', terminate)
      process.on('SIGHUP', hangup)
      process.on('SIGINT', interrupt)

      return () => {
        process.off('SIGTERM', terminate)
        process.off('SIGHUP', hangup)
        process.off('SIGINT', interrupt)
      }
    }),
    (release) => Effect.sync(release),
  )

  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          exitOnCtrlC: false,
          exitSignals: [],
          autoFocus: false,
          screenMode: 'alternate-screen',
        }),
      catch: () =>
        new TerminalError({
          message: 'Could not start the terminal UI. Run Duff in an interactive terminal.',
        }),
    }),
    (renderer) => Effect.sync(() => renderer.destroy()),
  )

  const terminal = new EditorTerminal(renderer, {
    id: 'duff-editor',
    flexGrow: 1,
    width: '100%',
    height: '100%',
    maxScrollback: 0,
    onMouseDown: () => dispatch({ type: 'editor' }),
  })

  const root = createRoot(renderer)

  const store = new ReviewStore(initialAppState(settings))
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      store.subscribe(() => {
        if (store.getSnapshot().editorFocused && !store.getSnapshot().helpOpen) terminal.focus()
        else terminal.blur()
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  root.render(<ReviewHost store={store} terminal={terminal} dispatch={dispatch} />)

  const editorLayer = makeNeovimLayer({
    root: resolve(options.values.repo),
    command: editorCommand,
    environment: process.env,
    terminal,
    notification: (method, args) => {
      if (method === 'duff.files') dispatch({ type: 'files' })

      if (method === 'duff.viewed') dispatch({ type: 'viewed' })

      if (method === 'duff.viewed-next') dispatch({ type: 'viewedNext' })

      if (method === 'duff.focus-mode') dispatch({ type: 'focusMode' })

      if (method === 'duff.removed-lines') dispatch({ type: 'removedLines' })

      if (method === 'duff.help') dispatch({ type: 'help' })

      if (method === 'duff.toggle-view') dispatch({ type: 'toggleView' })

      if (method === 'duff.active') {
        const decoded = Schema.decodeUnknownOption(Schema.Tuple([Schema.String]))(args)

        if (decoded._tag === 'Some') dispatch({ type: 'active', path: decoded.value[0] })
      }

      if (method === 'duff.hunk') {
        const decoded = Schema.decodeUnknownOption(Schema.Tuple([Schema.Literals([-1, 1])]))(args)

        if (decoded._tag === 'Some') dispatch({ type: 'hunk', direction: decoded.value[0] })
      }

      if (method === 'duff.saved') {
        const decoded = Schema.decodeUnknownOption(SavedNotification)(args)

        if (decoded._tag === 'Some') {
          const [path, hash] = decoded.value
          dispatch({ type: 'saved', path, hash })
        }
      }
    },
    exited: (code) => dispatch({ type: 'exited', code }),
  })

  const reviewLayer = makeTerminalReviewLayer({
    root: resolve(options.values.repo),
    base: options.values.base,
    stateDirectory: join(
      process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)
        ? process.env.XDG_STATE_HOME
        : join(homedir(), '.local', 'state'),
      'duff',
      'terminal',
    ),
  }).pipe(Layer.provide(makeGitReviewLayer(process.env)), Layer.provideMerge(editorLayer))

  const controllerLayer = makeTerminalControllerLayer(store).pipe(Layer.provide(reviewLayer))

  return yield* Effect.gen(function* () {
    const controller = yield* TerminalController

    const update = Effect.fn('TerminalUI.update')(function* (action: Action) {
      yield* controller.update(action).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            store.set({ ...store.getSnapshot(), error: error.message, busy: false })
          }),
        ),
      )
    })

    yield* update({ type: 'refresh' })

    while (true) {
      const action = yield* Queue.take(queue)

      if (action.type === 'exited' || action.type === 'stop') return action.code
      yield* update(action)
    }
  }).pipe(Effect.provide(controllerLayer))
}).pipe(Effect.scoped)

if (options.values.help) {
  process.stdout.write(help)
} else {
  process.exitCode = await Effect.runPromise(
    program.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`Duff: ${error.message}\n`)

          return 1
        }),
      ),
    ),
  )
}
