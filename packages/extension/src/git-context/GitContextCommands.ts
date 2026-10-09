import * as vscode from "vscode";
import { GitContext } from "@duff/core/git-context";
import { CommandRuntime, runOperation } from "../Operations";
import { chooseDirectory } from "../Repository";
import { GitContextView } from "./GitContextView";

export function registerGitContextCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
  currentRoot: () => string | undefined,
) {
  const provider = new GitContextView();
  const view = vscode.window.createTreeView("duff.context", { treeDataProvider: provider });
  let contextRequest = 0;

  const inspectContext = async () => {
    const directory = currentRoot() ?? await chooseDirectory();
    if (!directory) return;
    const request = ++contextRequest;
    provider.clear();
    view.message = "Reading local Git configuration…";
    const snapshot = await runOperation(runtime, "Duff.inspectContext", GitContext.use((service) => service.inspect(directory)), () => {
      if (request === contextRequest) {
        view.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
      }
    });
    if (request !== contextRequest) return;
    if (snapshot) {
      provider.setSnapshot(snapshot);
      view.message = "Local snapshot · authentication not verified. Hover rows for sources and scope.";
    } else {
      view.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
    }
    await vscode.commands.executeCommand("duff.context.focus");
  };

  context.subscriptions.push(provider, view, vscode.commands.registerCommand("duff.inspectContext", inspectContext));
  return {
    clear: () => {
      contextRequest++;
      provider.clear();
      view.message = undefined;
    },
  };
}
