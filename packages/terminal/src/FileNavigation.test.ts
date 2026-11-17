import { FileChange } from '@duff/core/review'
import { expect, it } from '@effect/vitest'

import {
  displayPath,
  moveSelection,
  navigationRows,
  revealFile,
  selectedRow,
} from './FileNavigation'

const files = [
  FileChange.make({ status: 'A', path: 'src/components/DeliveryPinCard/index.tsx' }),
  FileChange.make({ status: 'M', path: 'src/components/OrderTracking/index.tsx' }),
  FileChange.make({ status: 'R', path: 'src/types/order.ts', previousPath: 'src/types/old.ts' }),
  FileChange.make({ status: 'D', path: 'legacy.ts' }),
]

it('keeps the filename first in flat lists, with its directory available for duplicate basenames', () => {
  const rows = navigationRows(files, 'list', new Set())
  expect(rows.map((row) => row.name)).toEqual(['index.tsx', 'index.tsx', 'order.ts', 'legacy.ts'])
  expect(rows[0]).toMatchObject({
    kind: 'file',
    parent: 'src/components/DeliveryPinCard',
    path: files[0]?.path,
  })
  expect(rows[1]).toMatchObject({ kind: 'file', parent: 'src/components/OrderTracking' })
})

it('renders real directories and leaf filenames, preserving every changed path exactly once', () => {
  const rows = navigationRows(files, 'tree', new Set())
  expect(rows.map((row) => [row.kind, row.name, row.depth])).toEqual([
    ['directory', 'src', 0],
    ['directory', 'components', 1],
    ['directory', 'DeliveryPinCard', 2],
    ['file', 'index.tsx', 3],
    ['directory', 'OrderTracking', 2],
    ['file', 'index.tsx', 3],
    ['directory', 'types', 1],
    ['file', 'order.ts', 2],
    ['file', 'legacy.ts', 0],
  ])
  expect(new Set(rows.flatMap((row) => (row.kind === 'file' ? [row.path] : [])))).toEqual(
    new Set(files.map((file) => file.path)),
  )
})

it('collapses folders, reveals the active file, and clamps keyboard selection at the visible boundaries', () => {
  const collapsed = new Set(['src', 'src/components'])
  const rows = navigationRows(files, 'tree', collapsed)
  expect(rows.map((row) => row.name)).toEqual(['src', 'legacy.ts'])
  expect(moveSelection(rows, rows[0]?.key, -1)).toBe('directory:src')
  expect(moveSelection(rows, rows[1]?.key, 1)).toBe('file:legacy.ts')
  expect(selectedRow(rows, 'missing')?.key).toBe('directory:src')

  const revealed = navigationRows(
    files,
    'tree',
    revealFile(collapsed, 'src/components/OrderTracking/index.tsx'),
  )

  expect(revealed.some((row) => row.key === 'file:src/components/OrderTracking/index.tsx')).toBe(
    true,
  )
  expect(collapsed.size).toBe(2)
  expect(moveSelection([], undefined, 1)).toBeUndefined()
})

it('distinguishes a deleted file from a directory at the same path and neutralizes terminal controls', () => {
  const rows = navigationRows(
    [
      FileChange.make({ status: 'D', path: 'src' }),
      FileChange.make({ status: 'A', path: 'src/new.ts' }),
    ],
    'tree',
    new Set(),
  )

  expect(rows.map((row) => row.key)).toEqual(['directory:src', 'file:src/new.ts', 'file:src'])
  expect(displayPath('src/\x1b[31mfile\n.ts')).toBe('src/?[31mfile?.ts')
})
