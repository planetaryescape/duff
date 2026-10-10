import * as vscode from "vscode";
import { Option } from "effect";
import { GitContextSnapshot } from "@duff/core/git-context";
import { ProviderDiscovery } from "@duff/core/provider-discovery";
import { CommandRuntime, runOperation } from "../Operations";
import { PluginView, ProviderRow } from "./PluginView";

export function registerPluginCommands(context: vscode.ExtensionContext, runtime: CommandRuntime) {
  const provider = new PluginView();
  const view = vscode.window.createTreeView("duff.providers", { treeDataProvider: provider });
  let snapshot: GitContextSnapshot | undefined;
  let rows: ProviderRow[] = [];
  let generation = 0;
  let discovery: AbortController | undefined;
  const pending = new Map<string, AbortController>();
  const cooldowns = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = () => {
    generation++;
    discovery?.abort();
    discovery = undefined;
    for (const operation of pending.values()) operation.abort();
    pending.clear();
    for (const timer of cooldowns.values()) clearTimeout(timer);
    cooldowns.clear();
    snapshot = undefined;
    rows = [];
    provider.setRows(rows);
    view.message = undefined;
  };
  const discover = async (next: GitContextSnapshot, mode: "automatic" | "manual" = "automatic") => {
    clear();
    snapshot = next;
    if (mode === "automatic" && !vscode.workspace.getConfiguration("duff").get<boolean>("automaticDiscovery", true)) {
      return;
    }
    const request = generation;
    const abort = new AbortController();
    discovery = abort;
    view.message = "Discovering open pull requests…";
    const result = await runOperation(runtime, "Duff.discoverProviders", ProviderDiscovery.use((service) => service.discover(next)),
      () => { if (generation === request) view.message = "Discovery failed. Refresh to retry."; }, abort.signal,
      (results) => results.some((result) => result._tag === "Failed") ? "partial" : "success");
    if (request !== generation || abort.signal.aborted) return;
    discovery = undefined;
    if (!result) return;
    rows = result.map((result) => ({ result }));
    provider.setRows(rows);
    view.message = rows.length ? "Open PRs targeting each repository · explicit refresh · no Git changes" : "No remotes configured.";
  };
  const loadMore = async (name: unknown) => {
    if (typeof name !== "string" || !snapshot || discovery || pending.has(name)) return;
    const row = rows.find((row) => row.result.remote.name === name);
    if (row?.result._tag !== "Discovered" || Option.isNone(row.result.page.next)) return;
    if (row.retryAt !== undefined && performance.now() < row.retryAt) return;
    const nextSnapshot = snapshot;
    const cursor = row.result.page.next.value;
    const old = row.result;
    const request = generation;
    const abort = new AbortController();
    pending.set(name, abort);
    rows = rows.map((row) => row.result.remote.name === name ? { ...row, loading: true } : row);
    provider.setRows(rows);
    const result = await runOperation(runtime, "Duff.loadMoreProviders", ProviderDiscovery.use((service) => service.loadMore({ context: nextSnapshot, remoteName: name, cursor })), undefined, abort.signal,
      (result) => result._tag === "Failed" ? "partial" : "success");
    if (request !== generation || abort.signal.aborted) return;
    pending.delete(name);
    rows = rows.map((row) => {
      if (row.result.remote.name !== name) return row;
      if (result?._tag === "Discovered") {
        const items = new Map([...old.page.items, ...result.page.items].map((pr) => [JSON.stringify([pr.target.repository.authority, pr.target.repository.key, pr.id]), pr]));
        return { result: { ...result, page: { ...result.page, items: [...items.values()] } } };
      }
      if (result?._tag === "Failed") {
        const next = ["AuthenticationRequired", "InvalidContinuation"].includes(result.error._tag) ? Option.none() : old.page.next;
        const delay = result.error._tag === "RateLimited" && Option.isSome(result.error.retryAfterSeconds) ? result.error.retryAfterSeconds.value * 1000 : undefined;
        if (delay !== undefined) cooldowns.set(name, setTimeout(() => { cooldowns.delete(name); provider.setRows(rows); }, Math.min(delay, 2 ** 31 - 1)));
        return { result: { ...old, page: { ...old.page, next } }, error: result.error, ...(delay === undefined ? {} : { retryAt: performance.now() + delay }) };
      }
      return { result: { ...old, page: { ...old.page, next: Option.none() } }, error: "LoadMoreFailed" };
    });
    provider.setRows(rows);
  };
  const connect = async (name: unknown) => {
    if (typeof name !== "string" || !snapshot || discovery || pending.size) return;
    const next = snapshot;
    const choice = await vscode.window.showInformationMessage("Provider sign-in can grant broad repository read/write permissions. Duff only reads pull requests and never changes Git or provider data.", { modal: true }, "Continue to Sign In");
    if (choice !== "Continue to Sign In" || snapshot !== next) return;
    clear();
    const request = generation;
    const abort = new AbortController();
    discovery = abort;
    view.message = "Connecting provider…";
    const result = await runOperation(runtime, "Duff.connectProvider", ProviderDiscovery.use((service) => service.connect(next, name)), undefined, abort.signal);
    if (request !== generation || abort.signal.aborted) return;
    discovery = undefined;
    if (result) await vscode.commands.executeCommand("duff.refreshProviders");
    else view.message = "Provider connection unavailable or cancelled. Refresh to retry.";
  };
  context.subscriptions.push(provider, view, { dispose: clear },
    vscode.commands.registerCommand("duff.refreshProviders", async () => {
      await vscode.commands.executeCommand("duff.inspectContext", "manual");
      await vscode.commands.executeCommand("duff.providers.focus");
    }),
    vscode.commands.registerCommand("duff.loadMoreProviders", loadMore),
    vscode.commands.registerCommand("duff.connectProvider", connect),
  );
  return { clear, discover };
}
