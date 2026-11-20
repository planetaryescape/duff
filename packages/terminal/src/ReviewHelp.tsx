import { useReviewPalette } from './ReviewTheme'
import type { TerminalSettings } from './TerminalConfig'

interface HelpProps {
  readonly keys: TerminalSettings['keys']
  readonly width: number
  readonly height: number
}

export function ReviewHelp({ keys, width, height }: HelpProps) {
  const palette = useReviewPalette()

  const lines = [
    'Review controls',
    `${keys.focus.toUpperCase()}  Switch files / Neovim`,
    `${keys.previousHunk.toUpperCase()} / ${keys.nextHunk.toUpperCase()}  Previous / next hunk across files`,
    `${keys.markNext.toUpperCase()}  Mark viewed and open next unread`,
    `${keys.focusMode.toUpperCase()}  Focus mode: fold unchanged code`,
    `${keys.removedLines.toUpperCase()}  Show / hide virtual removed lines`,
    '',
    'Sidebar: j/k move · h/l folders · Enter open',
    'v toggle viewed · V mark+next · u next unread',
    't list/tree · z focus · d removed · r refresh',
    '',
    'Neovim commands:',
    ':DuffViewed · :DuffViewedNext · :DuffFiles',
    ':DuffFocus · :DuffRemoved · :DuffHelp',
    ':qa quit (Neovim protects unsaved changes)',
    '',
    `${keys.help.toUpperCase()} / Escape closes help`,
  ]

  return (
    <box
      position="absolute"
      left={2}
      top={2}
      width={Math.max(24, Math.min(74, width - 4))}
      height={Math.min(21, height - 4)}
      border
      backgroundColor={palette.panel}
      borderColor={palette.focusedBorder}
      paddingX={1}
      flexDirection="column"
    >
      {lines.slice(0, Math.max(1, height - 6)).map((line, index) => (
        <text key={index} height={1} wrapMode="none" truncate fg={palette.text}>
          {line}
        </text>
      ))}
    </box>
  )
}
