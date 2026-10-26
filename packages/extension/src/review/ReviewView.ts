import { type DiscussionReview } from '@duff/core/discussion'
import { type FileChange, type Review, type Snapshot } from '@duff/core/review'
import * as vscode from 'vscode'

import { encodeSnapshotDocument, type SnapshotDocument } from './SnapshotDocument'

export function snapshotUri(snapshot: Snapshot, document?: SnapshotDocument): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'duff-snapshot',
    path: vscode.Uri.joinPath(
      vscode.Uri.file(snapshot.root),
      snapshot.commit,
      snapshot.path ?? 'empty',
    ).path,
    query: document ? encodeSnapshotDocument(document) : JSON.stringify(snapshot),
  })
}

export class ReviewFile extends vscode.TreeItem {
  constructor(
    readonly review: Review,
    readonly change: FileChange,
    mode: 'list' | 'tree',
    viewed: boolean,
    readonly discussion?: DiscussionReview,
  ) {
    super(vscode.Uri.joinPath(vscode.Uri.file(review.root), change.path))
    this.id = `file:${change.path}`
    const directory = change.path.slice(0, change.path.lastIndexOf('/'))
    this.description =
      mode === 'list' && change.path.includes('/')
        ? `${change.status} · ${directory}`
        : change.status
    this.tooltip = `${change.previousPath ? `${change.previousPath} → ` : ''}${change.path} (${change.status}) · ${viewed ? 'Viewed' : 'Unviewed'}`
    this.contextValue = `${change.status === 'D' ? 'deletedReviewFile' : 'reviewFile'}.${viewed ? 'viewed' : 'unviewed'}`
    this.checkboxState = {
      state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: viewed ? 'Mark as Unviewed' : 'Mark as Viewed',
      accessibilityInformation: {
        label: `${viewed ? 'Mark as unviewed' : 'Mark as viewed'}: ${change.path}`,
      },
    }
    this.accessibilityInformation = {
      label: `${change.path}, ${change.status}, ${viewed ? 'viewed' : 'unviewed'}`,
    }
    this.command = { command: 'duff.openDiff', title: 'Open Diff', arguments: [this] }
  }
}

export class ReviewFolder extends vscode.TreeItem {
  constructor(
    readonly review: Review,
    readonly path: string,
    viewed: boolean,
  ) {
    super(path.slice(path.lastIndexOf('/') + 1), vscode.TreeItemCollapsibleState.Expanded)
    this.id = `folder:${path}`
    this.iconPath = new vscode.ThemeIcon('folder')
    this.tooltip = path
    this.checkboxState = {
      state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: `${viewed ? 'Mark as Unviewed' : 'Mark as Viewed'}: all changed files in ${path}`,
      accessibilityInformation: {
        label: `${viewed ? 'Mark as unviewed' : 'Mark as viewed'}: all changed files in ${path}`,
      },
    }
    this.contextValue = `reviewFolder.${viewed ? 'viewed' : 'unviewed'}`
  }
}

export class ReviewView
  implements vscode.TreeDataProvider<ReviewFile | ReviewFolder>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changes.event
  private review: Review | undefined
  private viewed = new Set<string>()
  private discussion: DiscussionReview | undefined

  constructor(private mode: 'list' | 'tree' = 'list') {}

  toggleLayout(): 'list' | 'tree' {
    this.mode = this.mode === 'list' ? 'tree' : 'list'
    this.changes.fire()

    return this.mode
  }

  setReview(review: Review, viewed: ReadonlyArray<string>, discussion?: DiscussionReview) {
    this.review = review
    this.discussion = discussion
    this.viewed = new Set(viewed)
    this.changes.fire()
  }

  clear() {
    this.review = undefined
    this.discussion = undefined
    this.viewed.clear()
    this.changes.fire()
  }

  getTreeItem(item: ReviewFile | ReviewFolder) {
    return item
  }

  getChildren(parent?: ReviewFile | ReviewFolder): (ReviewFile | ReviewFolder)[] {
    const review = this.review

    if (!review || parent instanceof ReviewFile) return []

    if (this.mode === 'list')
      return review.files.map(
        (file) =>
          new ReviewFile(review, file, this.mode, this.viewed.has(file.path), this.discussion),
      )
    const prefix = parent ? `${parent.path}/` : ''
    const folders = new Set<string>()
    const files: ReviewFile[] = []

    for (const file of review.files) {
      if (!file.path.startsWith(prefix)) continue
      const relative = file.path.slice(prefix.length)
      const separator = relative.indexOf('/')

      if (separator === -1)
        files.push(
          new ReviewFile(review, file, this.mode, this.viewed.has(file.path), this.discussion),
        )
      else folders.add(prefix + relative.slice(0, separator))
    }

    return [
      ...Array.from(folders)
        .sort()
        .map(
          (path) =>
            new ReviewFolder(
              review,
              path,
              review.files
                .filter((file) => file.path.startsWith(`${path}/`))
                .every((file) => this.viewed.has(file.path)),
            ),
        ),
      ...files.sort((left, right) => left.change.path.localeCompare(right.change.path)),
    ]
  }

  dispose() {
    this.changes.dispose()
  }
}
