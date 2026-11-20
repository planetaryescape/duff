import { displayPath, type NavigationRow } from './FileNavigation'
import {
  directoryGlyphs,
  fileIcon,
  type IconSet,
  sidebarColors,
  statusStyles,
  viewedMark,
} from './SidebarStyle'

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

function rowPrefix(row: NavigationRow, viewed: boolean, icons: IconSet): ReadonlyArray<Segment> {
  if (row.kind === 'directory') {
    const glyphs = directoryGlyphs(row.expanded, icons)

    return [
      { text: `${glyphs.disclosure} `, fg: sidebarColors.disclosure },
      { text: glyphs.icon, fg: viewed ? sidebarColors.viewed : sidebarColors.directory },
    ]
  }

  const status = statusStyles[row.file.status]

  return [
    { text: viewed ? viewedMark : ' ', fg: sidebarColors.viewed },
    { text: `${row.file.status} `, fg: status.color },
    { text: fileIcon(icons), fg: viewed ? sidebarColors.viewedName : status.color },
  ]
}

function nameColor(row: NavigationRow, viewed: boolean): string {
  if (viewed) return sidebarColors.viewedName

  return row.kind === 'directory' ? sidebarColors.directory : sidebarColors.filename
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
  const indent = ` ${'  '.repeat(row.depth)}`
  const prefix = rowPrefix(row, viewed, icons).filter((segment) => segment.text)
  const prefixWidth = prefix.reduce((total, segment) => total + segment.text.length, indent.length)

  return (
    <box
      height={1}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={active ? sidebarColors.selected : undefined}
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
        fg={nameColor(row, viewed)}
      >
        {displayPath(row.name)}
        {row.kind === 'directory' ? '/' : ''}
      </text>
      {row.kind === 'file' && showParent && row.parent ? (
        <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={sidebarColors.parent}>
          {`  ${displayPath(row.parent)}`}
        </text>
      ) : null}
    </box>
  )
}
