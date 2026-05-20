import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("duff.helloWorld", () => {
    vscode.window.showInformationMessage("Hello World from Duff!");
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
