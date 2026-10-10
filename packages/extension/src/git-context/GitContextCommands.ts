import * as vscode from "vscode";
import { Effect, Fiber, Option, Stream } from "effect";
import { ReviewSession } from "@duff/core/review-session";
import { CommandRuntime, runOperation } from "../Operations";
import { chooseDirectory } from "../Repository";
import { GitContextView } from "./GitContextView";

export function registerGitContextCommands(context: vscode.ExtensionContext, runtime: CommandRuntime, currentRoot: () => string | undefined) {
  const provider = new GitContextView();
  const view = vscode.window.createTreeView("duff.context", { treeDataProvider: provider });
  const subscription = runtime.runFork(ReviewSession.use((session) => session.changes.pipe(Stream.runForEach((state) => Effect.sync(() => {
    if (state._tag === "Idle") { provider.clear(); view.message = undefined; return; }
    if (Option.isSome(state.snapshot)) provider.setSnapshot(state.snapshot.value);
    else provider.clear();
    view.message = Option.isSome(state.problem) ? "Unexpected operation failure. Refresh to retry." : state.inspection === "Inspecting" ? "Reading local Git configuration…" : state.inspection === "Failed"
      ? "Inspection failed. No previous configuration is shown. Refresh to retry."
      : "Local snapshot · authentication not verified. Hover rows for sources and scope.";
  })))));
  const inspect = async (root?: string, focus = true, mode: "automatic" | "manual" = "automatic") => {
    const directory = root ?? currentRoot() ?? await chooseDirectory();
    if (!directory) return;
    const discover = mode === "manual" || vscode.workspace.getConfiguration("duff").get<boolean>("automaticDiscovery", true);
    await runOperation(runtime, "Duff.inspectContext", ReviewSession.use((session) => session.selectRepository(directory, { discover })));
    if (focus) await vscode.commands.executeCommand("duff.context.focus");
  };
  context.subscriptions.push(provider, view, { dispose: () => { runtime.runFork(Fiber.interrupt(subscription)); } },
    vscode.commands.registerCommand("duff.inspectContext", (mode: unknown) => inspect(undefined, mode !== "manual", mode === "manual" ? "manual" : "automatic")));
  return { inspect };
}
