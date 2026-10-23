import { expect, it } from 'vitest'

import { workspaceLine } from './SnapshotPosition'

it('maps unchanged and uniquely shifted lines without guessing changed or duplicate positions', () => {
  const snapshot =
    "import { product } from './types'\nexport const label = product.name\nexport const other = product.name\n"

  expect(workspaceLine(snapshot, snapshot, 1)).toBe(1)
  expect(workspaceLine(snapshot, `// local edit\n${snapshot}`, 1)).toBe(2)
  expect(workspaceLine(snapshot, snapshot.replace('label', 'title'), 1)).toBeUndefined()
  expect(
    workspaceLine(snapshot, `${snapshot}export const label = product.name\n`, 1),
  ).toBeUndefined()
  expect(workspaceLine(snapshot, snapshot.replaceAll('\n', '\r\n'), 2)).toBe(2)
  expect(workspaceLine('same\nsame', 'same\nsame', 1)).toBe(1)
  expect(workspaceLine(snapshot, '', 1)).toBeUndefined()

  const repeated =
    'function removed() {\n  return product.name\n}\nfunction kept() {\n  return product.name\n}'

  const remaining = 'function kept() {\n  return product.name\n}'
  expect(workspaceLine(repeated, remaining, 1)).toBeUndefined()
  expect(workspaceLine(repeated, remaining, 4)).toBeUndefined()
})
