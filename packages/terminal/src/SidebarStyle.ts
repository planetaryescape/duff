import type { FileChange } from '@duff/core/review'

export type IconSet = 'text' | 'nerd'

export const sidebarColors = {
  directory: '#a9c5e2',
  disclosure: '#6f8aa6',
  filename: '#e6eaf0',
  viewedName: '#8a94a0',
  parent: '#707b88',
  viewed: '#7ec699',
  muted: '#9199a5',
  selected: '#263242',
} as const

export const statusStyles = {
  A: { color: '#7ec699', label: 'added' },
  M: { color: '#e5c07b', label: 'modified' },
  D: { color: '#ef8a80', label: 'deleted' },
  R: { color: '#78c6e0', label: 'renamed' },
  C: { color: '#78c6e0', label: 'copied' },
  T: { color: '#c49ae0', label: 'type changed' },
} as const satisfies Record<FileChange['status'], { color: string; label: string }>

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
