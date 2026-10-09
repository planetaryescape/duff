import * as vscode from "vscode";
import { FileChange, Review, Snapshot } from "./review";

export function snapshotUri(snapshot: Snapshot): vscode.Uri {
  return vscode.Uri.from({
    scheme: "duff-snapshot",
    path: `/${snapshot.path ?? "empty"}`,
    query: JSON.stringify(snapshot),
  });
}

export class ReviewFile extends vscode.TreeItem {
  constructor(readonly review: Review, readonly change: FileChange) {
    super(vscode.Uri.joinPath(vscode.Uri.file(review.root), change.path));
    this.description = change.status;
    this.tooltip = `${change.previousPath ? `${change.previousPath} → ` : ""}${change.path} (${change.status})`;
    this.contextValue = change.status === "D" ? "deletedReviewFile" : "reviewFile";
    this.command = { command: "duff.openDiff", title: "Open Diff", arguments: [this] };
  }
}

export class ReviewView implements vscode.TreeDataProvider<ReviewFile>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private review: Review | undefined;

  setReview(review: Review) {
    this.review = review;
    this.changes.fire();
  }

  getTreeItem(file: ReviewFile) { return file; }

  getChildren(): ReviewFile[] {
    const review = this.review;
    return review?.files.map((file) => new ReviewFile(review, file)) ?? [];
  }

  dispose() { this.changes.dispose(); }
}
