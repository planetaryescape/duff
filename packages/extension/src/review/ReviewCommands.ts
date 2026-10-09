import * as vscode from "vscode";
import { Effect, Schema } from "effect";
import { BranchReview, Review, ReviewError, Snapshot } from "@duff/core/review";
import { CommandRuntime, runOperation } from "../Operations";
import { chooseDirectory } from "../Repository";
import { observeOperation } from "../telemetry/Telemetry";
import { ReviewFile, ReviewView, snapshotUri } from "./ReviewView";

export function registerReviewCommands(context: vscode.ExtensionContext, runtime: CommandRuntime, onReview: () => void) {
  const savedLayout = context.workspaceState.get<unknown>("reviewLayout");
  const provider = new ReviewView(savedLayout === "tree" ? "tree" : "list");
  const view = vscode.window.createTreeView("duff.files", { treeDataProvider: provider });
  let review: Review | undefined;

  const showReview = (next: Review) => {
    onReview();
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
    const directory = await chooseDirectory();
    if (!directory) return;
    const repository = await runOperation(runtime, "Duff.listBranches", BranchReview.use((service) => service.branches(directory)));
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
    const next = await runOperation(runtime, "Duff.compare", BranchReview.use((service) => service.compare(repository.root, selected.ref)));
    if (!next) return;
    showReview(next);
    await vscode.commands.executeCommand("duff.files.focus");
  };

  context.subscriptions.push(provider, view,
    vscode.commands.registerCommand("duff.compare", compare),
    vscode.commands.registerCommand("duff.toggleLayout", async () => {
      await context.workspaceState.update("reviewLayout", provider.toggleLayout());
    }),
    vscode.commands.registerCommand("duff.refresh", async () => {
      if (!review) return compare();
      const current = review;
      const next = await runOperation(runtime, "Duff.refresh", BranchReview.use((service) => service.compare(current.root, current.baseBranch)));
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
      try {
        let root: string;
        let path: string;
        if (item instanceof ReviewFile) {
          if (item.change.status === "D") return;
          root = item.review.root;
          path = item.change.path;
        } else {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          const uri = input instanceof vscode.TabInputTextDiff ? input.modified : vscode.window.activeTextEditor?.document.uri;
          if (uri?.scheme !== "duff-snapshot") return;
          const value: unknown = JSON.parse(uri.query);
          const snapshot = Schema.decodeUnknownSync(Snapshot)(value);
          if (snapshot.path === undefined) {
            await vscode.window.showInformationMessage("Duff: This file was deleted in the reviewed revision and has no current-side file to open.");
            return;
          }
          root = snapshot.root;
          path = snapshot.path;
        }
        await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root), path), { preview: false });
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
            Effect.mapError(() => new ReviewError({ operation: "read snapshot", message: "Invalid snapshot URI." })),
            Effect.flatMap((snapshot) => BranchReview.use((service) => service.read(snapshot))),
          );
          return await runtime.runPromise(observeOperation("Duff.readSnapshot", input), { signal: abort.signal });
        } finally {
          listener.dispose();
        }
      },
    }),
  );
  return { currentRoot: () => review?.root };
}
