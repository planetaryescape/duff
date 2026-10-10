import * as vscode from "vscode";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeGitContextLayer } from "@duff/core/git-context";
import { gitReviewLayer } from "@duff/core/review";
import { ReviewSession } from "@duff/core/review-session";
import { registerGitContextCommands } from "./git-context/GitContextCommands";
import { registerReviewCommands } from "./review/ReviewCommands";
import { observabilityLayer } from "./telemetry/Telemetry";
import { pullRequestsLayer } from "@duff/core/pull-request-providers";
import { authenticationLayer } from "./pull-requests/ProviderAuthentication";
import { registerPullRequestCommands } from "./pull-requests/PullRequestCommands";

let disposeRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const observability = context.extensionMode === vscode.ExtensionMode.Development
    ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer)) : Layer.empty;
  const transport = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })));
  const gitContextLayer = makeGitContextLayer(process.env);
  const providers = pullRequestsLayer.pipe(Layer.provide(Layer.merge(authenticationLayer, transport)));
  const sessionLayer = ReviewSession.layer.pipe(Layer.provide(Layer.merge(gitContextLayer, providers)));
  const runtime = ManagedRuntime.make(Layer.mergeAll(gitReviewLayer, gitContextLayer, sessionLayer).pipe(Layer.provideMerge(observability)));
  disposeRuntime = () => runtime.dispose();
  registerPullRequestCommands(context, runtime);
  const startInspection = (root?: string) => runtime.runFork(Effect.promise(() => gitContext.inspect(root, false)));
  const review = registerReviewCommands(context, runtime, (root) => { startInspection(root); });
  const gitContext = registerGitContextCommands(context, runtime, review.currentRoot);
  const resetInspection = (reason: "authentication" | "configuration") => runtime.runFork(Effect.gen(function* () {
    const session = yield* ReviewSession;
    const state = yield* session.current();
    if (reason === "authentication" && state._tag === "Active" && state.rows.some((row) => row.activity === "Connecting")) return;
    yield* session.clear();
    if (state._tag === "Active") yield* Effect.promise(() => gitContext.inspect(state.directory, false));
    else if (vscode.workspace.workspaceFolders?.length === 1) yield* Effect.promise(() => gitContext.inspect(undefined, false));
  }));
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(() => { resetInspection("authentication"); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => runtime.runFork(ReviewSession.use((session) => session.clear().pipe(Effect.andThen(Effect.sync(() => {
      if (vscode.workspace.workspaceFolders?.length === 1) startInspection(vscode.workspace.workspaceFolders[0]?.uri.fsPath);
    })))))),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("duff.automaticDiscovery")) resetInspection("configuration");
    }),
  );
  if (vscode.workspace.workspaceFolders?.length === 1) startInspection();
}

export async function deactivate() {
  await disposeRuntime?.();
  disposeRuntime = undefined;
}
