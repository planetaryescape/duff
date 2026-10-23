import { Schema } from 'effect'

import { Commit, type FileChange, GitPath, type Review, Snapshot } from './BranchReview'

export const ViewedFiles = Schema.Struct({
  root: Schema.String,
  baseCommit: Commit,
  headCommit: Commit,
  paths: Schema.Array(GitPath),
})

export interface ViewedFiles extends Schema.Schema.Type<typeof ViewedFiles> {}

function sameComparison(left: ViewedFiles | Review, right: Review): boolean {
  return (
    left.root === right.root &&
    left.baseCommit === right.baseCommit &&
    left.headCommit === right.headCommit
  )
}

export function fileSnapshots(review: Review, change: FileChange): readonly [Snapshot, Snapshot] {
  const base = Snapshot.make({ root: review.root, commit: review.baseCommit })
  const head = Snapshot.make({ root: review.root, commit: review.headCommit })

  return [
    change.status === 'A'
      ? base
      : Snapshot.make({ ...base, path: change.previousPath ?? change.path }),
    change.status === 'D' ? head : Snapshot.make({ ...head, path: change.path }),
  ]
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return left.root === right.root && left.commit === right.commit && left.path === right.path
}

export class ReviewProgress {
  private readonly viewed = new Set<string>()

  constructor(
    readonly review: Review,
    saved?: ViewedFiles,
  ) {
    if (saved && sameComparison(saved, review)) {
      for (const file of review.files) {
        if (saved.paths.includes(file.path)) this.viewed.add(file.path)
      }
    }
  }

  isViewed(path: string): boolean {
    return this.viewed.has(path)
  }

  setViewed(target: Review, path: string, viewed: boolean): boolean {
    if (
      !sameComparison(target, this.review) ||
      !this.review.files.some((file) => file.path === path)
    )
      return false

    if (viewed) this.viewed.add(path)
    else this.viewed.delete(path)

    return true
  }

  /** Mark every changed file beneath a folder, rejecting stale comparisons. */
  setFolderViewed(target: Review, path: string, viewed: boolean): boolean {
    if (!sameComparison(target, this.review)) return false
    const files = this.review.files.filter((file) => file.path.startsWith(`${path}/`))

    for (const file of files) {
      if (viewed) this.viewed.add(file.path)
      else this.viewed.delete(file.path)
    }

    return files.length > 0
  }

  activeFile(original: Snapshot, modified: Snapshot): FileChange | undefined {
    return this.review.files.find((file) => {
      const [base, head] = fileSnapshots(this.review, file)

      return sameSnapshot(base, original) && sameSnapshot(head, modified)
    })
  }

  saved(): ViewedFiles {
    return ViewedFiles.make({
      root: this.review.root,
      baseCommit: this.review.baseCommit,
      headCommit: this.review.headCommit,
      paths: [...this.viewed],
    })
  }
}
