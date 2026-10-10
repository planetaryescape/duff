import * as vscode from "vscode";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeGitContextLayer } from "@duff/core/git-context";
import { gitReviewLayer } from "@duff/core/review";
import { registerGitContextCommands } from "./git-context/GitContextCommands";
import { registerReviewCommands } from "./review/ReviewCommands";
import { observabilityLayer } from "./telemetry/Telemetry";
import { pluginLayer } from "./pull-requests/PluginLayers";
import { registerPluginCommands } from "./pull-requests/PluginCommands";

let disposeRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const observability = context.extensionMode === vscode.ExtensionMode.Development
    ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer)) : Layer.empty;
  const transport = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })));
  const runtime = ManagedRuntime.make(Layer.mergeAll(gitReviewLayer, makeGitContextLayer(process.env), pluginLayer.pipe(Layer.provide(transport))).pipe(Layer.provideMerge(observability)));
  disposeRuntime = () => runtime.dispose();
  const plugins = registerPluginCommands(context, runtime);
  const startInspection = (root?: string) => runtime.runFork(Effect.promise(() => gitContext.inspect(root, false)));
  const review = registerReviewCommands(context, runtime, (root) => { gitContext.clear(); startInspection(root); });
  const gitContext = registerGitContextCommands(context, runtime, review.currentRoot, plugins.discover, plugins.clear);
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(() => { gitContext.clear(); if (vscode.workspace.workspaceFolders?.length === 1) startInspection(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { gitContext.clear(); if (vscode.workspace.workspaceFolders?.length === 1) startInspection(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("duff.automaticDiscovery")) { gitContext.clear(); if (vscode.workspace.workspaceFolders?.length === 1) startInspection(); }
    }),
  );
  if (vscode.workspace.workspaceFolders?.length === 1) startInspection();
}

export async function deactivate() {
  await disposeRuntime?.();
  disposeRuntime = undefined;
}
