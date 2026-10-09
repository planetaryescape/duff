import * as vscode from "vscode";
import { ConfigValue, GitContextSnapshot } from "./git-context";

function row(label: string, value: string, detail?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.description = value;
  item.tooltip = `${label}: ${value}${detail ? `\n${detail}` : ""}`;
  return item;
}

function configRow(label: string, value: ConfigValue | undefined): vscode.TreeItem {
  return row(label, value?.value || "Unset", value ? `${value.scope} · ${value.origin}` : undefined);
}

export class GitContextView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private rows: vscode.TreeItem[] = [];

  setSnapshot(snapshot: GitContextSnapshot) {
    this.rows = [
      row("Repository", snapshot.root),
      configRow("user.name", snapshot.name),
      configRow("user.email", snapshot.email),
      row("Commit author", snapshot.author ?? "Unresolved"),
      row("Commit committer", snapshot.committer ?? "Unresolved"),
      row("Provider account", "Not verified", "Commit identity and credential configuration do not establish a provider login."),
      ...snapshot.remotes.map((remote) => row(`Remote: ${remote.name}`, remote.destination, `Transport: ${remote.transport}. Userinfo, query and fragment are hidden. Fetch destination only.`)),
      ...(snapshot.remotes.length ? [] : [row("Remotes", "None configured")]),
      row("SSH command", snapshot.sshCommandConfigured ? "Custom command configured (hidden)" : "Default SSH", "The selected key and authenticated account are unknown."),
      row("Helper selection", "Not resolved per remote", "These are ordered configuration declarations, not the effective helper chain. URL matching and reset handling depend on the remote."),
      ...snapshot.helpers.map((helper, index) => row(`Helper ${index + 1}: ${helper.target}`, helper.strategy, `${helper.scope} · ${helper.origin}`)),
      ...(snapshot.helpers.length ? [] : [row("Helpers", "None configured")]),
    ];
    this.changes.fire();
  }

  clear() {
    this.rows = [];
    this.changes.fire();
  }

  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(): vscode.TreeItem[] { return this.rows; }
  dispose() { this.changes.dispose(); }
}
