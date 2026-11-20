import type { EmbeddedTerminalRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { useSyncExternalStore } from 'react'

import { EditorPane } from './EditorPane'
import { displayPath } from './FileNavigation'
import { FileSidebar } from './FileSidebar'
import { ReviewFooter } from './ReviewFooter'
import { ReviewHelp } from './ReviewHelp'
import type { ReviewStore } from './ReviewStore'
import {
  type ReviewMode,
  ReviewPaletteContext,
  reviewPalettes,
  useReviewPalette,
} from './ReviewTheme'
import type { EditorDisplay, TerminalSettings } from './TerminalConfig'
import type { TerminalState } from './TerminalReview'

export type Action =
  | { readonly type: 'focus' }
  | { readonly type: 'files' }
  | { readonly type: 'editor' }
  | { readonly type: 'select'; readonly key: string }
  | { readonly type: 'move'; readonly direction: number }
  | { readonly type: 'edge'; readonly end: boolean }
  | { readonly type: 'collapse' }
  | { readonly type: 'expand' }
  | { readonly type: 'toggleView' }
  | { readonly type: 'unviewed' }
  | { readonly type: 'active'; readonly path: string }
  | { readonly type: 'theme'; readonly mode: ReviewMode }
  | { readonly type: 'open' }
  | { readonly type: 'viewed' }
  | { readonly type: 'viewedNext' }
  | { readonly type: 'focusMode' }
  | { readonly type: 'removedLines' }
  | { readonly type: 'help' }
  | { readonly type: 'refresh' }
  | { readonly type: 'hunk'; readonly direction: number }
  | { readonly type: 'quit' }
  | { readonly type: 'exited'; readonly code: number }
  | { readonly type: 'stop'; readonly code: number }
  | { readonly type: 'saved'; readonly path: string; readonly hash: string }

export interface AppState {
  readonly review: TerminalState | undefined
  readonly settings: TerminalSettings
  readonly fileView: 'list' | 'tree'
  readonly collapsed: ReadonlySet<string>
  readonly selection: string | undefined
  readonly activePath: string | undefined
  readonly editorFocused: boolean
  readonly error: string | undefined
  readonly busy: boolean
  readonly display: EditorDisplay
  readonly helpOpen: boolean
  readonly notice: string | undefined
  readonly mode: ReviewMode
}

export function initialAppState(settings: TerminalSettings): AppState {
  return {
    review: undefined,
    settings,
    fileView: settings.fileView,
    collapsed: new Set(),
    selection: undefined,
    activePath: undefined,
    editorFocused: false,
    error: undefined,
    busy: true,
    display: {
      focusMode: settings.focusMode,
      showRemovedLines: settings.showRemovedLines,
      focusContext: settings.focusContext,
    },
    helpOpen: false,
    notice: undefined,
    mode: 'dark',
  }
}

interface AppProps {
  readonly state: AppState
  readonly terminal: EmbeddedTerminalRenderable
  readonly dispatch: (action: Action) => void
}

export function ReviewApp({ state, terminal, dispatch }: AppProps) {
  const { width, height } = useTerminalDimensions()
  const palette = useReviewPalette()

  const keys = state.settings.keys
  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (state.helpOpen) {
      key.preventDefault()
      key.stopPropagation()

      if (key.name === keys.help || key.name === 'escape' || key.name === 'q')
        dispatch({ type: 'help' })

      return
    }

    if (!key.ctrl && !key.meta && !key.shift) {
      let global: Action | undefined

      if (key.name === keys.focus && !key.repeated) global = { type: 'focus' }

      if (key.name === keys.previousHunk) global = { type: 'hunk', direction: -1 }

      if (key.name === keys.nextHunk) global = { type: 'hunk', direction: 1 }

      if (key.name === keys.markNext && !key.repeated) global = { type: 'viewedNext' }

      if (key.name === keys.focusMode && !key.repeated) global = { type: 'focusMode' }

      if (key.name === keys.removedLines && !key.repeated) global = { type: 'removedLines' }

      if (key.name === keys.help && !key.repeated) global = { type: 'help' }

      if (global) {
        key.preventDefault()
        key.stopPropagation()
        dispatch(global)

        return
      }
    }

    if (terminal.focused || key.ctrl || key.meta) return

    switch (key.name) {
      case 'j':
      case 'down':
        dispatch({ type: 'move', direction: 1 })
        break
      case 'k':
      case 'up':
        dispatch({ type: 'move', direction: -1 })
        break
      case 'h':
      case 'left':
        dispatch({ type: 'collapse' })
        break
      case 'l':
      case 'right':
        dispatch({ type: 'expand' })
        break
      case 'g':
        dispatch({ type: 'edge', end: key.shift })
        break
      case 'home':
        dispatch({ type: 'edge', end: false })
        break
      case 'end':
        dispatch({ type: 'edge', end: true })
        break
      case 'tab':
        dispatch({ type: 'editor' })
        break
      case 'return':
        dispatch({ type: 'open' })
        break
      case 'v':
        dispatch({ type: key.shift ? 'viewedNext' : 'viewed' })
        break
      case 'u':
        dispatch({ type: 'unviewed' })
        break
      case 't':
        dispatch({ type: 'toggleView' })
        break
      case 'r':
        dispatch({ type: 'refresh' })
        break
      case 'z':
        dispatch({ type: 'focusMode' })
        break
      case 'd':
        dispatch({ type: 'removedLines' })
        break
      case '?':
        dispatch({ type: 'help' })
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

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.background}>
      <text height={1} fg={palette.text} wrapMode="none" truncate>
        {' '}
        {`duff  ${title}  ·  editable workspace vs merge base`}
      </text>
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        <FileSidebar
          state={state}
          dispatch={dispatch}
          width={Math.max(20, Math.min(state.settings.sidebarWidth, Math.floor(width * 0.45)))}
          height={Math.max(3, height - 3)}
        />
        <box flexDirection="column" flexGrow={1} minWidth={1}>
          <text height={1} fg={palette.muted} wrapMode="none" truncate>
            {' '}
            {state.activePath ? displayPath(state.activePath) : 'Neovim'}
            {state.review?.viewed.has(state.activePath ?? '') ? '  ✓ viewed' : ''}
          </text>
          <EditorPane terminal={terminal} />
        </box>
      </box>
      <ReviewFooter state={state} dispatch={dispatch} width={width} />
      {state.helpOpen ? <ReviewHelp keys={keys} width={width} height={height} /> : null}
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

  return (
    <ReviewPaletteContext.Provider value={reviewPalettes[state.mode]}>
      <ReviewApp state={state} terminal={terminal} dispatch={dispatch} />
    </ReviewPaletteContext.Provider>
  )
}
