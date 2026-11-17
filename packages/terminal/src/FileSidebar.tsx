import { displayPath, navigationRows, selectedRow } from './FileNavigation'
import type { Action, AppState } from './ReviewApp'

interface SidebarProps {
  readonly state: AppState
  readonly dispatch: (action: Action) => void
  readonly width: number
  readonly height: number
}

export function FileSidebar({ state, dispatch, width, height }: SidebarProps) {
  const files = state.review?.review.files ?? []
  const rows = navigationRows(files, state.fileView, state.collapsed)
  const selected = selectedRow(rows, state.selection)

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
      borderColor={state.editorFocused ? '#30343b' : '#7799bb'}
    >
      <text height={1} fg={state.editorFocused ? '#9199a5' : '#a9c5e2'}>
        {' '}
        {state.fileView === 'tree' ? 'Changed files · tree' : 'Changed files · list'}
      </text>
      <text height={1} fg="#9199a5">
        {' '}
        {state.review?.viewed.size ?? 0}/{files.length} viewed
      </text>
      {state.review && files.length === 0 ? <text fg="#9199a5"> No changed files</text> : null}
      {rows.slice(start, start + Math.max(1, height - 2)).map((row) => {
        const active = row.key === selected?.key
        let marker = row.kind === 'directory' ? '▾' : row.file.status

        if (row.kind === 'directory' && !row.expanded) marker = '▸'

        if (row.kind === 'file' && state.review?.viewed.has(row.path)) marker = '✓'

        return (
          <box
            key={row.key}
            height={1}
            flexDirection="row"
            overflow="hidden"
            backgroundColor={active ? '#263242' : undefined}
            onMouseDown={() => {
              dispatch({ type: 'files' })
              dispatch({ type: 'select', key: row.key })
              dispatch({ type: 'open' })
            }}
          >
            <text flexShrink={0} fg="#9199a5">{` ${'  '.repeat(row.depth)}${marker} `}</text>
            <text
              flexShrink={0}
              maxWidth={Math.max(4, width - 5 - row.depth * 2)}
              wrapMode="none"
              truncate
              fg={row.kind === 'directory' ? '#a9c5e2' : '#d6dce4'}
            >
              {displayPath(row.name)}
              {row.kind === 'directory' ? '/' : ''}
            </text>
            {row.kind === 'file' && state.fileView === 'list' && row.parent ? (
              <text
                flexGrow={1}
                minWidth={0}
                wrapMode="none"
                truncate
                fg="#707b88"
              >{`  ${displayPath(row.parent)}`}</text>
            ) : null}
          </box>
        )
      })}
    </box>
  )
}
