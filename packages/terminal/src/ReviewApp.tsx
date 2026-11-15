import { type BoxRenderable, type EmbeddedTerminalRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'

import type { ReviewStore } from './ReviewStore'
import type { TerminalState } from './TerminalReview'

export type Action =
  | { readonly type: 'focus' }
  | { readonly type: 'files' }
  | { readonly type: 'editor' }
  | { readonly type: 'select'; readonly index: number }
  | { readonly type: 'open' }
  | { readonly type: 'viewed' }
  | { readonly type: 'refresh' }
  | { readonly type: 'hunk'; readonly direction: number }
  | { readonly type: 'quit' }
  | { readonly type: 'exited'; readonly code: number }
  | { readonly type: 'stop'; readonly code: number }
  | { readonly type: 'saved'; readonly path: string; readonly hash: string }

export interface AppState {
  readonly review: TerminalState | undefined
  readonly selectedIndex: number
  readonly editorFocused: boolean
  readonly error: string | undefined
  readonly busy: boolean
}

interface AppProps {
  readonly state: AppState
  readonly terminal: EmbeddedTerminalRenderable
  readonly dispatch: (action: Action) => void
}

function EditorPane({
  terminal,
  focused,
}: {
  readonly terminal: EmbeddedTerminalRenderable
  readonly focused: boolean
}) {
  const container = useRef<BoxRenderable>(null)
  useLayoutEffect(() => {
    const box = container.current
    box?.add(terminal)

    return () => {
      box?.remove(terminal)
    }
  }, [terminal])
  useLayoutEffect(() => {
    if (focused) terminal.focus()
    else terminal.blur()
  }, [terminal, focused])

  return <box ref={container} flexGrow={1} minWidth={1} overflow="hidden" />
}

function FileList({
  state,
  dispatch,
  width,
  height,
}: {
  readonly state: AppState
  readonly dispatch: AppProps['dispatch']
  readonly width: number
  readonly height: number
}) {
  const files = state.review?.review.files ?? []
  const start = Math.max(0, state.selectedIndex - height + 2)

  return (
    <box
      width={width}
      flexShrink={0}
      flexDirection="column"
      border={['right']}
      borderColor={state.editorFocused ? '#30343b' : '#7799bb'}
    >
      <text fg="#9199a5">
        {' '}
        {state.review?.viewed.size ?? 0}/{files.length} viewed
      </text>
      {state.review && files.length === 0 ? <text fg="#9199a5"> No changed files</text> : null}
      {files.slice(start, start + height - 1).map((file, offset) => {
        const index = start + offset
        const selected = index === state.selectedIndex
        const viewed = state.review?.viewed.has(file.path)

        return (
          <text
            key={file.path}
            height={1}
            bg={selected ? '#263242' : undefined}
            fg={viewed ? '#7c8994' : '#d6dce4'}
            onMouseDown={() => {
              dispatch({ type: 'select', index })
              dispatch({ type: 'open' })
            }}
          >
            {` ${viewed ? '✓' : file.status} ${file.path.replaceAll(/[\x00-\x1f\x7f]/g, '?')}`}
          </text>
        )
      })}
    </box>
  )
}

export function ReviewApp({ state, terminal, dispatch }: AppProps) {
  const { width, height } = useTerminalDimensions()
  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (key.name === 'f6') {
      key.preventDefault()
      key.stopPropagation()
      dispatch({ type: 'focus' })

      return
    }

    if (state.editorFocused || key.ctrl || key.meta) return
    const files = state.review?.review.files ?? []

    switch (key.name) {
      case 'j':
      case 'down':
        dispatch({ type: 'select', index: Math.min(files.length - 1, state.selectedIndex + 1) })
        break
      case 'k':
      case 'up':
        dispatch({ type: 'select', index: Math.max(0, state.selectedIndex - 1) })
        break
      case 'return':
        dispatch({ type: 'open' })
        break
      case 'v':
        dispatch({ type: 'viewed' })
        break
      case 'r':
        dispatch({ type: 'refresh' })
        break
      case ']':
        dispatch({ type: 'hunk', direction: 1 })
        break
      case '[':
        dispatch({ type: 'hunk', direction: -1 })
        break
      case 'q':
        dispatch({ type: 'quit' })
        break
    }
  })
  const comparison = state.review?.review

  const title = comparison
    ? `${comparison.headBranch} → ${comparison.baseBranch}`
    : 'Opening review'

  let footer = 'F6 editor  j/k files  enter open  v viewed  [/] hunk  r refresh  q quit'

  if (state.editorFocused)
    footer = 'F6 files  :DuffViewed  :DuffNextHunk  :DuffPreviousHunk  :qa to quit'

  if (state.busy) footer = 'Loading…'

  if (state.error) footer = state.error

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#14181e">
      <text height={1} fg="#d6dce4">
        {' '}
        {`duff  ${title}  ·  editable workspace vs merge base`}
      </text>
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        <FileList
          state={state}
          dispatch={dispatch}
          width={Math.max(16, Math.min(36, Math.floor(width * 0.26)))}
          height={Math.max(2, height - 2)}
        />
        <EditorPane terminal={terminal} focused={state.editorFocused} />
      </box>
      <text height={1} fg={state.error ? '#ef9b91' : '#9199a5'}>
        {' '}
        {footer}
      </text>
    </box>
  )
}

export function ReviewHost({
  store,
  terminal,
  dispatch,
}: {
  readonly store: ReviewStore
  readonly terminal: EmbeddedTerminalRenderable
  readonly dispatch: AppProps['dispatch']
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

  return <ReviewApp state={state} terminal={terminal} dispatch={dispatch} />
}
