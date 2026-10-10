import { type FileChange, type Review, type Snapshot } from '@duff/core/review'
import * as vscode from 'vscode'

export function snapshotUri(snapshot: Snapshot): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'duff-snapshot',
    path: `/${snapshot.path ?? 'empty'}`,
    query: JSON.stringify(snapshot),
  })
}

export class ReviewFile extends vscode.TreeItem {
  constructor(
    readonly review: Review,
    readonly change: FileChange,
    mode: 'list' | 'tree',
  ) {
    super(vscode.Uri.joinPath(vscode.Uri.file(review.root), change.path))
    this.id = `file:${change.path}`
    const directory = change.path.slice(0, change.path.lastIndexOf('/'))
    this.description =
      mode === 'list' && change.path.includes('/')
        ? `${change.status} · ${directory}`
        : change.status
    this.tooltip = `${change.previousPath ? `${change.previousPath} → ` : ''}${change.path} (${change.status})`
    this.contextValue = change.status === 'D' ? 'deletedReviewFile' : 'reviewFile'
    this.command = { command: 'duff.openDiff', title: 'Open Diff', arguments: [this] }
  }
}

export class ReviewFolder extends vscode.TreeItem {
  constructor(readonly path: string) {
    super(path.slice(path.lastIndexOf('/') + 1), vscode.TreeItemCollapsibleState.Expanded)
    this.id = `folder:${path}`
    this.iconPath = new vscode.ThemeIcon('folder')
    this.tooltip = path
  }
}

export class ReviewView
  implements vscode.TreeDataProvider<ReviewFile | ReviewFolder>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changes.event
  private review: Review | undefined

  constructor(private mode: 'list' | 'tree' = 'list') {}

  toggleLayout(): 'list' | 'tree' {
    this.mode = this.mode === 'list' ? 'tree' : 'list'
    this.changes.fire()

    return this.mode
  }

  setReview(review: Review) {
    this.review = review
    this.changes.fire()
  }

  getTreeItem(item: ReviewFile | ReviewFolder) {
    return item
  }

  getChildren(parent?: ReviewFile | ReviewFolder): (ReviewFile | ReviewFolder)[] {
    const review = this.review

    if (!review || parent instanceof ReviewFile) return []

    if (this.mode === 'list')
      return review.files.map((file) => new ReviewFile(review, file, this.mode))
    const prefix = parent ? `${parent.path}/` : ''
    const folders = new Set<string>()
    const files: ReviewFile[] = []

    for (const file of review.files) {
      if (!file.path.startsWith(prefix)) continue
      const relative = file.path.slice(prefix.length)
      const separator = relative.indexOf('/')

      if (separator === -1) files.push(new ReviewFile(review, file, this.mode))
      else folders.add(prefix + relative.slice(0, separator))
    }

    return [
      ...Array.from(folders)
        .sort()
        .map((path) => new ReviewFolder(path)),
      ...files.sort((left, right) => left.change.path.localeCompare(right.change.path)),
    ]
  }

  dispose() {
    this.changes.dispose()
  }
}
