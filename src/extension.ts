import * as vscode from "vscode";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { GitContext, GitContextError } from "./git-context";
import { gitContextLayer } from "./git-context-adapter";
import { GitContextView } from "./git-context-view";
import { gitReviewLayer } from "./git-review";
import { observabilityLayer, observeOperation, Operation } from "./observability";
import { BranchReview, Review, ReviewError, Snapshot } from "./review";
import { ReviewFile, ReviewView, snapshotUri } from "./review-view";

let disposeRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const observability = context.extensionMode === vscode.ExtensionMode.Development
    ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer)) : Layer.empty;
  const runtime = ManagedRuntime.make(Layer.merge(gitReviewLayer, gitContextLayer).pipe(Layer.provideMerge(observability)));
  disposeRuntime = () => runtime.dispose();
  const savedLayout = context.workspaceState.get<unknown>("reviewLayout");
  const provider = new ReviewView(savedLayout === "tree" ? "tree" : "list");
  const view = vscode.window.createTreeView("duff.files", { treeDataProvider: provider });
  const contextProvider = new GitContextView();
  const contextView = vscode.window.createTreeView("duff.context", { treeDataProvider: contextProvider });
  let review: Review | undefined;
  let contextRequest = 0;

  const run = async <A>(operation: Operation, work: Effect.Effect<A, ReviewError | GitContextError, BranchReview | GitContext>, onFailure?: () => void) => {
    try {
      return await runtime.runPromise(observeOperation(operation, work).pipe(
        Effect.catchTag(["ReviewError", "GitContextError"], (error) => Effect.promise(async () => {
          onFailure?.();
          await vscode.window.showErrorMessage(`Duff: ${error.message}`);
          return undefined;
        })),
      ));
    } catch {
      onFailure?.();
      await vscode.window.showErrorMessage("Duff encountered an unexpected error. Reload the extension and try again.");
      return undefined;
    }
  };

  const showReview = (next: Review) => {
    contextRequest++;
    contextProvider.clear();
    contextView.message = undefined;
    review = next;
    provider.setReview(next);
    const base = next.baseBranch.replace(/^refs\/(heads|remotes)\//, "");
    view.description = `${base} → ${next.headBranch}`;
    view.message = next.files.length === 0
      ? "No committed changes since the common ancestor. Working-tree edits are excluded."
      : `${next.files.length} changed files · committed changes only`;
    view.title = "Changed Files";
  };

  const chooseDirectory = async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      await vscode.window.showInformationMessage("Duff: Open a Git repository folder first.");
      return;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(
      folders.map((item) => ({ label: item.name, folder: item })),
      { title: "Duff: Choose Repository" },
    ).then((item) => item?.folder);
    return folder?.uri.fsPath;
  };

  const inspectContext = async () => {
    const directory = review?.root ?? await chooseDirectory();
    if (!directory) return;
    const request = ++contextRequest;
    contextProvider.clear();
    contextView.message = "Reading local Git configuration…";
    const snapshot = await run("Duff.inspectContext", GitContext.use((service) => service.inspect(directory)), () => {
      if (request === contextRequest) {
        contextView.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
      }
    });
    if (request !== contextRequest) return;
    if (snapshot) {
      contextProvider.setSnapshot(snapshot);
      contextView.message = "Local snapshot · authentication not verified. Hover rows for sources and scope.";
    } else {
      contextView.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
    }
    await vscode.commands.executeCommand("duff.context.focus");
  };

  const compare = async () => {
    const directory = await chooseDirectory();
    if (!directory) return;
    const repository = await run("Duff.listBranches", BranchReview.use((service) => service.branches(directory)));
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
    const next = await run("Duff.compare", BranchReview.use((service) => service.compare(repository.root, selected.ref)));
    if (!next) return;
    showReview(next);
    await vscode.commands.executeCommand("duff.files.focus");
  };

  context.subscriptions.push(provider, view, contextProvider, contextView,
    vscode.commands.registerCommand("duff.compare", compare),
    vscode.commands.registerCommand("duff.inspectContext", inspectContext),
    vscode.commands.registerCommand("duff.toggleLayout", async () => {
      await context.workspaceState.update("reviewLayout", provider.toggleLayout());
    }),
    vscode.commands.registerCommand("duff.refresh", async () => {
      if (!review) return compare();
      const current = review;
      const next = await run("Duff.refresh", BranchReview.use((service) => service.compare(current.root, current.baseBranch)));
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
}

export async function deactivate() {
  await disposeRuntime?.();
  disposeRuntime = undefined;
}
