export type IconSet = 'text' | 'nerd'

const icons = {
  text: { open: '', closed: '', file: '' },
  nerd: { open: '\u{f07c} ', closed: '\u{f07b} ', file: '\u{f15b} ' },
} as const satisfies Record<IconSet, { open: string; closed: string; file: string }>

export function directoryGlyphs(expanded: boolean, set: IconSet) {
  return {
    disclosure: expanded ? '▾' : '▸',
    icon: expanded ? icons[set].open : icons[set].closed,
  }
}

export function fileIcon(set: IconSet): string {
  return icons[set].file
}

export const viewedMark = '✓'
