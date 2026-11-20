import { navigationRows, selectedRow, viewedDirectories } from './FileNavigation'
import type { Action, AppState } from './ReviewApp'
import { useReviewPalette } from './ReviewTheme'
import { SidebarRow } from './SidebarRow'

interface SidebarProps {
  readonly state: AppState
  readonly dispatch: (action: Action) => void
  readonly width: number
  readonly height: number
}

export function FileSidebar({ state, dispatch, width, height }: SidebarProps) {
  const palette = useReviewPalette()
  const files = state.review?.review.files ?? []
  const viewed = state.review?.viewed ?? new Set<string>()
  const rows = navigationRows(files, state.fileView, state.collapsed)
  const selected = selectedRow(rows, state.selection)
  const completeDirectories = viewedDirectories(files, viewed)
  const complete = files.length > 0 && viewed.size >= files.length

  const index = Math.max(
    0,
    rows.findIndex((row) => row.key === selected?.key),
  )

  const start = Math.max(0, index - height + 3)

  return (
    <box
      width={width}
      flexShrink={0}
      flexDirection="column"
      border={['right']}
      borderColor={state.editorFocused ? palette.border : palette.focusedBorder}
    >
      <text height={1} fg={state.editorFocused ? palette.muted : palette.accent}>
        {' '}
        {state.fileView === 'tree' ? 'Changed files · tree' : 'Changed files · list'}
      </text>
      <text height={1} fg={complete ? palette.status.A : palette.muted}>
        {complete ? ' ✓ ' : ' '}
        {viewed.size}/{files.length} viewed
      </text>
      {state.review && files.length === 0 ? (
        <text fg={palette.muted}> No changed files</text>
      ) : null}
      {rows.slice(start, start + Math.max(1, height - 2)).map((row) => (
        <SidebarRow
          key={row.key}
          row={row}
          active={row.key === selected?.key}
          viewed={row.kind === 'file' ? viewed.has(row.path) : completeDirectories.has(row.path)}
          icons={state.settings.icons}
          showParent={state.fileView === 'list'}
          width={width}
          onSelect={() => {
            dispatch({ type: 'files' })
            dispatch({ type: 'select', key: row.key })
            dispatch({ type: 'open' })
          }}
        />
      ))}
    </box>
  )
}
