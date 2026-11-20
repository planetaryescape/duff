import type { FileChange } from '@duff/core/review'

export interface FileRow {
  readonly kind: 'file'
  readonly key: string
  readonly path: string
  readonly name: string
  readonly parent: string
  readonly depth: number
  readonly file: FileChange
}

export interface DirectoryRow {
  readonly kind: 'directory'
  readonly key: string
  readonly path: string
  readonly name: string
  readonly depth: number
  readonly expanded: boolean
}

export type NavigationRow = FileRow | DirectoryRow

interface Directory {
  readonly name: string
  readonly path: string
  readonly directories: Map<string, Directory>
  readonly files: FileChange[]
}

function directory(name: string, path: string): Directory {
  return { name, path, directories: new Map(), files: [] }
}

function fileRow(file: FileChange, depth: number): FileRow {
  const parts = file.path.split('/')

  return {
    kind: 'file',
    key: `file:${file.path}`,
    path: file.path,
    name: parts.at(-1) ?? file.path,
    parent: parts.slice(0, -1).join('/'),
    depth,
    file,
  }
}

export function navigationRows(
  files: ReadonlyArray<FileChange>,
  mode: 'list' | 'tree',
  collapsed: ReadonlySet<string>,
): ReadonlyArray<NavigationRow> {
  if (mode === 'list') return files.map((file) => fileRow(file, 0))
  const root = directory('', '')

  for (const file of files) {
    let current = root

    for (const name of file.path.split('/').slice(0, -1)) {
      let child = current.directories.get(name)

      if (!child) {
        const path = current.path ? `${current.path}/${name}` : name
        child = directory(name, path)
        current.directories.set(name, child)
      }

      current = child
    }

    current.files.push(file)
  }

  const rows: NavigationRow[] = []

  function visit(parent: Directory, depth: number): void {
    for (const child of Array.from(parent.directories.values()).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const expanded = !collapsed.has(child.path)
      rows.push({
        kind: 'directory',
        key: `directory:${child.path}`,
        path: child.path,
        name: child.name,
        depth,
        expanded,
      })

      if (expanded) visit(child, depth + 1)
    }

    for (const file of parent.files.toSorted((left, right) =>
      left.path.localeCompare(right.path, 'en'),
    ))
      rows.push(fileRow(file, depth))
  }

  visit(root, 0)

  return rows
}

export function revealFile(collapsed: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(collapsed)
  const parts = path.split('/').slice(0, -1)

  for (let length = 1; length <= parts.length; length++)
    next.delete(parts.slice(0, length).join('/'))

  return next
}

export function selectedRow(
  rows: ReadonlyArray<NavigationRow>,
  selection: string | undefined,
): NavigationRow | undefined {
  return rows.find((row) => row.key === selection) ?? rows[0]
}

export function moveSelection(
  rows: ReadonlyArray<NavigationRow>,
  selection: string | undefined,
  direction: number,
): string | undefined {
  const index = Math.max(
    0,
    rows.findIndex((row) => row.key === selection),
  )

  return rows[Math.max(0, Math.min(rows.length - 1, index + direction))]?.key
}

export function displayPath(path: string): string {
  return path.replaceAll(/[\x00-\x1f\x7f]/g, '?')
}

export function viewedDirectories(
  files: ReadonlyArray<FileChange>,
  viewed: ReadonlySet<string>,
): ReadonlySet<string> {
  const complete = new Set<string>()
  const incomplete = new Set<string>()

  for (const file of files) {
    const parts = file.path.split('/').slice(0, -1)
    const target = viewed.has(file.path) ? complete : incomplete

    for (let length = 1; length <= parts.length; length++)
      target.add(parts.slice(0, length).join('/'))
  }

  for (const path of incomplete) complete.delete(path)

  return complete
}
