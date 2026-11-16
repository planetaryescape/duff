import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { makeGitReviewLayer } from '@duff/core/review'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { Effect, Layer, Queue, Schema } from 'effect'
import { parse } from 'shell-quote'

import { EditorTerminal } from './EditorTerminal'
import { makeNeovimLayer, Neovim } from './Neovim'
import { type Action, type AppState, ReviewHost } from './ReviewApp'
import { ReviewStore } from './ReviewStore'
import { makeTerminalReviewLayer, TerminalError, TerminalReview } from './TerminalReview'

const help = `Duff terminal review

bun run tui --base main [--repo /path/to/repo] [--editor /path/to/nvim]

Requires Bun 1.3.5+ and Neovim 0.10+ on Linux or macOS.
Reviews committed branch paths against their merge base; buffers are live workspace files.
Uses your normal Neovim configuration. --editor must name a Neovim executable or wrapper,
not a shell alias. Quoted arguments are supported; shell operators are not.
Defaults to DUFF_NVIM, VISUAL, EDITOR, then nvim on PATH. The command must run Neovim.

F6 switches between files and Neovim. All other editor keys belong to Neovim.
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
  },
})

const program = Effect.gen(function* () {
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
        createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: 'alternate-screen' }),
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

  let state: AppState = {
    review: undefined,
    selectedIndex: 0,
    editorFocused: false,
    error: undefined,
    busy: true,
  }

  const store = new ReviewStore(state)
  const render = () => store.set(state)
  root.render(<ReviewHost store={store} terminal={terminal} dispatch={dispatch} />)

  const editorLayer = makeNeovimLayer({
    root: resolve(options.values.repo),
    command: editorCommand,
    environment: process.env,
    terminal,
    notification: (method, args) => {
      if (method === 'duff.files') dispatch({ type: 'files' })

      if (method === 'duff.viewed') dispatch({ type: 'viewed' })

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

  return yield* Effect.gen(function* () {
    const review = yield* TerminalReview
    const editor = yield* Neovim

    const update = Effect.fn('TerminalUI.update')(function* (action: Action) {
      state = { ...state, error: undefined }

      switch (action.type) {
        case 'focus':
          state = { ...state, editorFocused: !state.editorFocused }
          break
        case 'files':
          state = { ...state, editorFocused: false }
          break
        case 'editor':
          state = { ...state, editorFocused: true }
          break
        case 'select':
          state = { ...state, selectedIndex: Math.max(0, action.index) }
          break
        case 'open': {
          const file = state.review?.review.files[state.selectedIndex]

          if (file) state = { ...state, review: yield* review.open(file), editorFocused: true }
          break
        }

        case 'viewed': {
          const file = state.review?.review.files[state.selectedIndex]

          if (!state.editorFocused && file) state = { ...state, review: yield* review.open(file) }
          state = { ...state, review: yield* review.toggleViewed() }
          break
        }

        case 'refresh': {
          state = { ...state, review: yield* review.load() }

          const index =
            state.review?.review.files.findIndex((file) => file.path === state.review?.selected) ??
            -1

          state = { ...state, selectedIndex: Math.max(0, index) }
          const file = state.review?.review.files[state.selectedIndex]

          if (file) state = { ...state, review: yield* review.open(file) }
          break
        }

        case 'saved':
          state = { ...state, review: yield* review.saved(action.path, action.hash) }
          break
        case 'hunk':
          yield* editor.hunk(action.direction)
          break
        case 'quit':
          state = { ...state, editorFocused: true }
          render()
          yield* editor.quit()
          break
        case 'exited':
        case 'stop':
          break
      }
    })

    yield* update({ type: 'refresh' }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          state = { ...state, error: error.message }
        }),
      ),
    )
    state = { ...state, busy: false }
    render()

    while (true) {
      const action = yield* Queue.take(queue)

      if (action.type === 'exited' || action.type === 'stop') return action.code
      yield* update(action).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            state = { ...state, error: error.message }
          }),
        ),
      )
      render()
    }
  }).pipe(Effect.provide(reviewLayer))
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
