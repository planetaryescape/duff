import * as vscode from "vscode";
import { Option } from "effect";
import { DiscoveryError, RemoteDiscovery } from "@duff/core/git-hosting-provider";

export interface ProviderRow {
  readonly result: RemoteDiscovery;
  readonly loading?: boolean;
  readonly error?: DiscoveryError | "LoadMoreFailed";
  readonly retryAt?: number;
}

export function providerError(error: DiscoveryError | "LoadMoreFailed"): string {
  if (error === "LoadMoreFailed") return "Load more failed. Refresh to restart discovery.";
  switch (error._tag) {
    case "AuthenticationRequired": return "Provider sign-in required. Git credentials are not API authentication.";
    case "RepositoryUnavailable": return "Repository missing or inaccessible to this API session.";
    case "ProviderUnavailable": return "Provider or authentication service unavailable. Refresh to retry.";
    case "InvalidProviderResponse": return "Provider returned invalid data. Refresh to retry.";
    case "InvalidContinuation": return "This page is stale. Refresh to restart discovery.";
    case "RateLimited": return Option.isSome(error.retryAfterSeconds)
      ? `Rate limited. Retry after ${Math.ceil(error.retryAfterSeconds.value)} seconds.` : "Rate limited. Refresh later.";
  }
}

function item(label: string, description?: string, command?: vscode.Command): vscode.TreeItem {
  const row = new vscode.TreeItem(label);
  row.description = description;
  row.command = command;
  row.accessibilityInformation = { label: description ? `${label}: ${description}` : label };
  return row;
}

export class PluginView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private roots: vscode.TreeItem[] = [];
  private readonly children = new Map<vscode.TreeItem, vscode.TreeItem[]>();

  setRows(rows: ReadonlyArray<ProviderRow>) {
    this.children.clear();
    this.roots = rows.map(({ result, loading, error, retryAt }) => {
      const root = item(result.remote.name, "plugin" in result ? result.plugin.displayName : result._tag);
      root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      const children: vscode.TreeItem[] = [];
      if (result._tag === "Unsupported") children.push(item("Unsupported remote. No provider request made."));
      else if (result._tag === "Ambiguous") children.push(item("Multiple plugins recognize this remote.", result.candidates.map((candidate) => candidate.displayName).join(", ")));
      else {
        root.tooltip = result.repository.displayName;
        children.push(item(result.repository.displayName));
        if (result._tag === "Failed") children.push(item(providerError(result.error)));
        else {
          const auth = result.authentication;
          children.push(item("API authentication", auth._tag === "Authenticated" ? auth.account.displayName : auth._tag));
          for (const pr of result.page.items) {
            const row = item(`#${pr.id} ${pr.title}`, pr.draft ? "Draft" : "Open", { command: "vscode.open", title: "Open Pull Request", arguments: [vscode.Uri.parse(pr.url)] });
            row.iconPath = new vscode.ThemeIcon(pr.draft ? "git-pull-request-draft" : "git-pull-request");
            row.tooltip = `${pr.source._tag === "Available" ? `${pr.source.repository.displayName}: ${pr.source.ref.name}` : "Source unavailable"}\n→ ${pr.target.ref.name}\nOpens the provider page. Does not fetch or switch branches.`;
            children.push(row);
          }
          if (error) children.push(item(`Partial results: ${providerError(error)}`));
          if (loading) children.push(item("Loading next page…"));
          else if (Option.isSome(result.page.next) && (retryAt === undefined || performance.now() >= retryAt)) children.push(item("Load More", "Incomplete result", { command: "duff.loadMoreProviders", title: "Load More", arguments: [result.remote.name] }));
          else if (!result.page.items.length && !error) children.push(item("No open pull requests found."));
          else if (!error) children.push(item("All pages loaded."));
        }
        if (result._tag === "Failed" || result.authentication._tag !== "Authenticated") children.push(item("Connect Provider…", undefined, { command: "duff.connectProvider", title: "Connect Provider", arguments: [result.remote.name] }));
        if (result._tag === "Failed" || error) children.push(item("Refresh Discovery", undefined, { command: "duff.refreshProviders", title: "Refresh Discovery" }));
      }
      this.children.set(root, children);
      return root;
    });
    this.changes.fire();
  }

  getTreeItem(element: vscode.TreeItem) { return element; }
  getChildren(element?: vscode.TreeItem) { return element ? this.children.get(element) ?? [] : this.roots; }
  dispose() { this.changes.dispose(); }
}
