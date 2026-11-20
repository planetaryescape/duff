import type { Action, AppState } from './ReviewApp'

interface FooterProps {
  readonly state: AppState
  readonly dispatch: (action: Action) => void
  readonly width: number
}

export function ReviewFooter({ state, dispatch, width }: FooterProps) {
  const keys = state.settings.keys
  let navigation = `${keys.focus.toUpperCase()} editor  j/k files  Enter open  h/l fold  t view`

  if (state.editorFocused)
    navigation = `${keys.focus.toUpperCase()} files  ${keys.previousHunk.toUpperCase()} prev hunk  ${keys.nextHunk.toUpperCase()} next hunk`
  let status = state.notice

  if (state.busy) status = 'Loading…'

  if (state.error) status = state.error

  return (
    <box height={2} flexShrink={0} flexDirection="column">
      <box height={1} flexDirection="row">
        <text
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
          fg={state.error ? '#ef9b91' : '#a9c5e2'}
        >{` ${status ?? navigation}`}</text>
        <text
          flexShrink={0}
          fg="#a9c5e2"
          onMouseDown={() => dispatch({ type: 'help' })}
        >{`  ${keys.help.toUpperCase()} help`}</text>
      </box>
      <box height={1} flexDirection="row">
        <text
          fg="#a9c5e2"
          flexShrink={0}
          onMouseDown={() => dispatch({ type: 'viewedNext' })}
        >{` ${keys.markNext.toUpperCase()} read+next `}</text>
        <text flexShrink={1} minWidth={0} fg="#9199a5" wrapMode="none" truncate>
          {state.editorFocused ? ':DuffViewed' : 'v viewed  u unread'}
          {width >= 100
            ? `  ${keys.focusMode.toUpperCase()} focus ${state.display.focusMode ? 'on' : 'off'}  ${keys.removedLines.toUpperCase()} removed ${state.display.showRemovedLines ? 'on' : 'off'}`
            : `  ${keys.focusMode.toUpperCase()} focus  ${keys.removedLines.toUpperCase()} removed`}
        </text>
      </box>
    </box>
  )
}
