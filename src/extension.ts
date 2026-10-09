import * as vscode from "vscode";
import { Effect, ManagedRuntime, Schema } from "effect";
import { gitReviewLayer } from "./git-review";
import { BranchReview, Review, ReviewError, Snapshot } from "./review";
import { ReviewFile, ReviewView, snapshotUri } from "./review-view";

let disposeRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const runtime = ManagedRuntime.make(gitReviewLayer);
  disposeRuntime = () => runtime.dispose();
  const provider = new ReviewView();
  const view = vscode.window.createTreeView("duff.files", { treeDataProvider: provider });
  let review: Review | undefined;

  const run = async <A>(work: Effect.Effect<A, ReviewError, BranchReview>) => {
    try {
      return await runtime.runPromise(work.pipe(
        Effect.catchTag("ReviewError", (error) => Effect.promise(async () => {
          await vscode.window.showErrorMessage(`Duff: ${error.message}`);
          return undefined;
        })),
      ));
    } catch (cause) {
      await vscode.window.showErrorMessage(`Duff encountered an unexpected error: ${String(cause)}`);
      return undefined;
    }
  };

  const showReview = (next: Review) => {
    review = next;
    provider.setReview(next);
    const base = next.baseBranch.replace(/^refs\/(heads|remotes)\//, "");
    view.description = `${base} → ${next.headBranch}`;
    view.message = next.files.length === 0
      ? "No committed changes since the common ancestor. Working-tree edits are excluded."
      : `${next.files.length} changed files · committed changes only`;
    view.title = "Changed Files";
  };

  const compare = async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      await vscode.window.showInformationMessage("Duff: Open a Git repository folder first.");
      return;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(
      folders.map((item) => ({ label: item.name, folder: item })),
      { title: "Duff: Choose Repository" },
    ).then((item) => item?.folder);
    if (!folder) return;
    const repository = await run(BranchReview.use((service) => service.branches(folder.uri.fsPath)));
    if (!repository) return;
    if (repository.branches.length === 0) {
      await vscode.window.showInformationMessage("Duff: No other local or remote-tracking branches are available. Fetch or create a branch, then try again.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      repository.branches.map((ref) => ({
        label: ref.replace(/^refs\/(heads|remotes)\//, ""),
        description: ref.startsWith("refs/remotes/") ? "remote-tracking" : "local",
        ref,
      })),
      { title: `Compare ${repository.current} Against Branch`, placeHolder: "Choose the base branch (changes since the common ancestor)" },
    );
    if (!selected) return;
    const next = await run(BranchReview.use((service) => service.compare(repository.root, selected.ref)));
    if (!next) return;
    showReview(next);
    await vscode.commands.executeCommand("duff.files.focus");
  };

  context.subscriptions.push(provider, view,
    vscode.commands.registerCommand("duff.compare", compare),
    vscode.commands.registerCommand("duff.refresh", async () => {
      if (!review) return compare();
      const current = review;
      const next = await run(BranchReview.use((service) => service.compare(current.root, current.baseBranch)));
      if (next) showReview(next);
    }),
    vscode.commands.registerCommand("duff.openDiff", async (item: unknown) => {
      if (!(item instanceof ReviewFile)) return;
      const { review: current, change } = item;
      await vscode.commands.executeCommand("vscode.diff",
        snapshotUri({ root: current.root, commit: current.baseCommit,
          ...(change.status === "A" ? {} : { path: change.previousPath ?? change.path }) }),
        snapshotUri({ root: current.root, commit: current.headCommit,
          ...(change.status === "D" ? {} : { path: change.path }) }),
        `${change.path}: ${current.baseBranch.replace(/^refs\/(heads|remotes)\//, "")} ↔ ${current.headBranch}`,
      );
    }),
    vscode.commands.registerCommand("duff.openFile", async (item: unknown) => {
      if (!(item instanceof ReviewFile) || item.change.status === "D") return;
      try {
        await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(item.review.root), item.change.path));
      } catch {
        await vscode.window.showErrorMessage("Duff: This file is not available in the current working tree. Its committed version is still available in the diff.");
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider("duff-snapshot", {
      provideTextDocumentContent: async (uri, token) => {
        const abort = new AbortController();
        const listener = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          const input = Effect.try({
            try: (): unknown => JSON.parse(uri.query),
            catch: () => new ReviewError({ operation: "read snapshot", message: "Invalid snapshot URI." }),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
            Effect.mapError((cause) => new ReviewError({ operation: "read snapshot", message: cause.message })),
            Effect.flatMap((snapshot) => BranchReview.use((service) => service.read(snapshot))),
          );
          return await runtime.runPromise(input, { signal: abort.signal });
        } finally {
          listener.dispose();
        }
      },
    }),
  );
}

export async function deactivate() {
  await disposeRuntime?.();
  disposeRuntime = undefined;
}
