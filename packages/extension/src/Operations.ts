import * as vscode from "vscode";
import { Effect, ManagedRuntime } from "effect";
import { BranchReview, ReviewError } from "@duff/core/review";
import { GitContext, GitContextError } from "@duff/core/git-context";
import { observeOperation, Operation } from "./telemetry/Telemetry";

export type CommandRuntime = ManagedRuntime.ManagedRuntime<BranchReview | GitContext, never>;

export async function runOperation<A>(
  runtime: CommandRuntime,
  operation: Operation,
  work: Effect.Effect<A, ReviewError | GitContextError, BranchReview | GitContext>,
  onFailure?: () => void,
) {
  try {
    return await runtime.runPromise(observeOperation(operation, work).pipe(
      Effect.catchTag(["ReviewError", "GitContextError"], (error) => Effect.promise(async () => {
        onFailure?.();
        await vscode.window.showErrorMessage(`Duff: ${error.message}`);
        return undefined;
      })),
    ));
  } catch {
    onFailure?.();
    await vscode.window.showErrorMessage("Duff encountered an unexpected error. Reload the extension and try again.");
    return undefined;
  }
}
