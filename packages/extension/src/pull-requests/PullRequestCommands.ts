import * as vscode from "vscode";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { GroupId } from "@duff/core/pull-requests";
import { ReviewSession } from "@duff/core/review-session";
import { CommandRuntime, runOperation } from "../Operations";
import { PullRequestView } from "./PullRequestView";

export function registerPullRequestCommands(context: vscode.ExtensionContext, runtime: CommandRuntime) {
  const provider = new PullRequestView();
  const view = vscode.window.createTreeView("duff.providers", { treeDataProvider: provider });
  const subscription = runtime.runFork(ReviewSession.use((session) => session.changes.pipe(Stream.runForEach((state) => Effect.sync(() => {
    provider.setState(state);
    view.message = state._tag === "Idle" ? undefined : Option.isSome(state.problem) ? "Unexpected operation failure. Refresh to retry." : state.inspection === "Failed" ? "Local inspection failed. Refresh to retry." : state.discovering
      ? "Discovering open pull requests…"
      : state.rows.length || state.notices.length ? "Explicit refresh · no Git changes" : undefined;
  })))));
  context.subscriptions.push(provider, view, { dispose: () => { runtime.runFork(Fiber.interrupt(subscription)); } },
    vscode.commands.registerCommand("duff.refreshProviders", async () => {
      await vscode.commands.executeCommand("duff.inspectContext", "manual");
      await vscode.commands.executeCommand("duff.providers.focus");
    }),
    vscode.commands.registerCommand("duff.loadMoreProviders", (value: unknown) => {
      const id = Schema.decodeUnknownOption(GroupId)(value);
      if (Option.isSome(id)) return runOperation(runtime, "Duff.loadMoreProviders", ReviewSession.use((session) => session.loadMore(id.value)));
    }),
    vscode.commands.registerCommand("duff.connectProvider", async (value: unknown) => {
      const id = Schema.decodeUnknownOption(GroupId)(value);
      if (Option.isNone(id)) return;
      const choice = await vscode.window.showInformationMessage("Provider sign-in can grant broad repository read/write permissions. Duff only reads pull requests and never changes Git or provider data.", { modal: true }, "Continue to Sign In");
      if (choice === "Continue to Sign In") await runOperation(runtime, "Duff.connectProvider", ReviewSession.use((session) => session.connect(id.value)));
    }),
  );
}
