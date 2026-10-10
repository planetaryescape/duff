import * as vscode from "vscode";
import { GitContext, GitContextSnapshot } from "@duff/core/git-context";
import { CommandRuntime, runOperation } from "../Operations";
import { chooseDirectory } from "../Repository";
import { GitContextView } from "./GitContextView";

export function registerGitContextCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
  currentRoot: () => string | undefined,
  onSnapshot: (snapshot: GitContextSnapshot) => Promise<void>,
  onClear: () => void,
) {
  const provider = new GitContextView();
  const view = vscode.window.createTreeView("duff.context", { treeDataProvider: provider });
  let contextRequest = 0;
  let pending: AbortController | undefined;

  const clear = () => {
    contextRequest++;
    pending?.abort();
    pending = undefined;
    provider.clear();
    onClear();
    view.message = undefined;
  };

  const inspectContext = async (root?: string, focus = true) => {
    const directory = root ?? currentRoot() ?? await chooseDirectory();
    if (!directory) return;
    clear();
    const request = contextRequest;
    const abort = new AbortController();
    pending = abort;
    view.message = "Reading local Git configuration…";
    const snapshot = await runOperation(runtime, "Duff.inspectContext", GitContext.use((service) => service.inspect(directory)), () => {
      if (request === contextRequest) {
        view.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
      }
    }, abort.signal);
    if (request !== contextRequest) return;
    pending = undefined;
    if (snapshot) {
      provider.setSnapshot(snapshot);
      view.message = "Local snapshot · authentication not verified. Hover rows for sources and scope.";
      await onSnapshot(snapshot);
    } else {
      view.message = "Inspection failed. No previous configuration is shown. Try Inspect / Refresh Git Context again.";
    }
    if (focus && request === contextRequest) await vscode.commands.executeCommand("duff.context.focus");
  };

  context.subscriptions.push(provider, view, { dispose: () => pending?.abort() }, vscode.commands.registerCommand("duff.inspectContext", () => inspectContext()));
  return { clear, inspect: inspectContext };
}
