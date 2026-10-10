import * as vscode from "vscode";
import { Option } from "effect";
import { GroupRow, ReviewState, SessionProblem } from "@duff/core/review-session";

export function providerError(error: SessionProblem): string {
  if (error === "InspectionFailed") return "Discovery was interrupted. Refresh to recheck local context and pull requests.";
  if (error === "UnexpectedFailure") return "Unexpected operation failure. Refresh to retry.";
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
  row.tooltip = description ? `${label}: ${description}` : label;
  row.accessibilityInformation = { label: description ? `${label}: ${description}` : label };
  return row;
}

function groupChildren(row: GroupRow, busy: boolean): vscode.TreeItem[] {
  const children = [item("Remotes", row.group.remoteNames.join(", "))];
  const content = row.content;
  if ("data" in content) {
    const data = content.data;
    children.push(item("API authentication", data.authentication._tag === "Authenticated" ? data.authentication.account.displayName : data.authentication._tag));
    for (const pr of data.items) {
      const node = item(`#${pr.id} ${pr.title}`, pr.draft ? "Draft" : "Open", { command: "vscode.open", title: "Open Pull Request", arguments: [vscode.Uri.parse(pr.url)] });
      node.iconPath = new vscode.ThemeIcon(pr.draft ? "git-pull-request-draft" : "git-pull-request");
      node.tooltip = `${pr.source._tag === "Available" ? `${pr.source.repository.displayName}: ${pr.source.ref.name}` : "Source unavailable"}\n→ ${pr.target.ref.name}\nOpens the provider page. Does not fetch or switch branches.`;
      children.push(node);
    }
    if (content._tag === "Refreshing") children.push(item("Refreshing…", "Previous results"));
    if (content._tag === "Stale") children.push(item("Stale results", providerError(content.error)));
    if (row.activity === "LoadingMore") children.push(item("Loading next page…"));
    else if (row.activity === "Cooldown") children.push(item("Waiting for rate-limit cooldown…"));
    else if (!busy && row.activity === "Idle" && data.hasMore) children.push(item("Load More", "Incomplete result", { command: "duff.loadMoreProviders", title: "Load More", arguments: [row.group.id] }));
    else if (content._tag === "Ready" && !data.hasMore) children.push(item(data.items.length ? "All pages loaded." : "No open pull requests found."));
  } else if (content._tag === "Loading") children.push(item("Loading pull requests…"));
  else children.push(item(providerError(content.error)));
  if (row.activity === "Connecting") children.push(item("Connecting provider…"));
  else if (!busy && row.activity === "Idle" && (content._tag === "Failed" || "data" in content && content.data.authentication._tag !== "Authenticated")) {
    children.push(item("Connect Provider…", undefined, { command: "duff.connectProvider", title: "Connect Provider", arguments: [row.group.id] }));
  }
  if (content._tag === "Failed" || content._tag === "Stale") children.push(item("Refresh Discovery", undefined, { command: "duff.refreshProviders", title: "Refresh Discovery" }));
  return children;
}

export class PullRequestView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private roots: vscode.TreeItem[] = [];
  private readonly children = new Map<vscode.TreeItem, vscode.TreeItem[]>();

  setState(state: ReviewState) {
    this.children.clear();
    this.roots = state._tag === "Idle" ? [] : state.rows.map((row) => {
      const root = item(row.group.repository.displayName, `${row.group.provider.displayName} · ${row.content._tag}`);
      root.id = row.group.key;
      root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      this.children.set(root, groupChildren(row, state.inspection !== "Ready" || row.content._tag === "Loading" || row.content._tag === "Refreshing" || state.rows.some((row) => row.activity === "Connecting")));
      return root;
    });
    if (state._tag === "Active") for (const notice of state.notices) {
      this.roots.push(item(notice.remote.name, notice._tag === "Unsupported" ? "Unsupported remote. No provider request made." : `Ambiguous: ${notice.candidates.map((candidate) => candidate.displayName).join(", ")}`));
    }
    this.changes.fire();
  }

  getTreeItem(element: vscode.TreeItem) { return element; }
  getChildren(element?: vscode.TreeItem) { return element ? this.children.get(element) ?? [] : this.roots; }
  dispose() { this.changes.dispose(); }
}
