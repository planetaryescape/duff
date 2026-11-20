import { displayPath, type NavigationRow } from './FileNavigation'
import { type ReviewPalette, useReviewPalette } from './ReviewTheme'
import { directoryGlyphs, fileIcon, type IconSet, viewedMark } from './SidebarStyle'

interface Segment {
  readonly text: string
  readonly fg: string
}

interface SidebarRowProps {
  readonly row: NavigationRow
  readonly active: boolean
  readonly viewed: boolean
  readonly icons: IconSet
  readonly showParent: boolean
  readonly width: number
  readonly onSelect: () => void
}

function rowPrefix(
  row: NavigationRow,
  viewed: boolean,
  icons: IconSet,
  palette: ReviewPalette,
): ReadonlyArray<Segment> {
  if (row.kind === 'directory') {
    const glyphs = directoryGlyphs(row.expanded, icons)

    return [
      { text: `${glyphs.disclosure} `, fg: palette.muted },
      { text: glyphs.icon, fg: viewed ? palette.status.A : palette.accent },
    ]
  }

  const status = palette.status[row.file.status]

  return [
    { text: viewed ? viewedMark : ' ', fg: palette.status.A },
    { text: `${row.file.status} `, fg: status },
    { text: fileIcon(icons), fg: viewed ? palette.muted : status },
  ]
}

function nameColor(row: NavigationRow, viewed: boolean, palette: ReviewPalette): string {
  if (viewed) return palette.muted

  return row.kind === 'directory' ? palette.accent : palette.text
}

export function SidebarRow({
  row,
  active,
  viewed,
  icons,
  showParent,
  width,
  onSelect,
}: SidebarRowProps) {
  const palette = useReviewPalette()
  const indent = ` ${'  '.repeat(row.depth)}`
  const prefix = rowPrefix(row, viewed, icons, palette).filter((segment) => segment.text)
  const prefixWidth = prefix.reduce((total, segment) => total + segment.text.length, indent.length)

  return (
    <box
      height={1}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={active ? palette.selected : undefined}
      onMouseDown={onSelect}
    >
      <text flexShrink={0}>{indent}</text>
      {prefix.map((segment, index) => (
        <text key={index} flexShrink={0} fg={segment.fg}>
          {segment.text}
        </text>
      ))}
      <text
        flexShrink={0}
        maxWidth={Math.max(4, width - 1 - prefixWidth)}
        wrapMode="none"
        truncate
        fg={nameColor(row, viewed, palette)}
      >
        {displayPath(row.name)}
        {row.kind === 'directory' ? '/' : ''}
      </text>
      {row.kind === 'file' && showParent && row.parent ? (
        <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={palette.muted}>
          {`  ${displayPath(row.parent)}`}
        </text>
      ) : null}
    </box>
  )
}
