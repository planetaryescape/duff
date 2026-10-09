import * as vscode from "vscode";
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeGitContextLayer } from "@duff/core/git-context";
import { gitReviewLayer } from "@duff/core/review";
import { registerGitContextCommands } from "./git-context/GitContextCommands";
import { registerReviewCommands } from "./review/ReviewCommands";
import { observabilityLayer } from "./telemetry/Telemetry";

let disposeRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const observability = context.extensionMode === vscode.ExtensionMode.Development
    ? observabilityLayer.pipe(Layer.provide(FetchHttpClient.layer)) : Layer.empty;
  const runtime = ManagedRuntime.make(Layer.merge(gitReviewLayer, makeGitContextLayer(process.env)).pipe(Layer.provideMerge(observability)));
  disposeRuntime = () => runtime.dispose();
  const review = registerReviewCommands(context, runtime, () => gitContext.clear());
  const gitContext = registerGitContextCommands(context, runtime, review.currentRoot);
}

export async function deactivate() {
  await disposeRuntime?.();
  disposeRuntime = undefined;
}
