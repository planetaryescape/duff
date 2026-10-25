import { type RepositoryCatalog, CatalogError } from '@duff/core/dashboard-repositories'
import { type GitContext, GitContextError } from '@duff/core/git-context'
import { DiscoveryError } from '@duff/core/git-hosting-provider'
import { type PullRequestReview } from '@duff/core/pull-request-review'
import { type RepositoryDirectory } from '@duff/core/repository-directory'
import { type BranchReview, ReviewError } from '@duff/core/review'
import { type ReviewSession } from '@duff/core/review-session'
import { type ReviewWorkspaces } from '@duff/core/review-workspaces'
import { type ReviewSessions } from '@duff/core/saved-review-sessions'
import { ReviewStorageError } from '@duff/core/saved-reviews'
import { Cause, type Effect, type ManagedRuntime, Option, Schema } from 'effect'
import * as vscode from 'vscode'

import { providerError } from './pull-requests/ProviderError'
import { observeOperation, type Operation } from './telemetry/Telemetry'

export type CommandRuntime = ManagedRuntime.ManagedRuntime<
  | BranchReview
  | GitContext
  | ReviewSession
  | PullRequestReview
  | ReviewSessions
  | RepositoryCatalog
  | RepositoryDirectory
  | ReviewWorkspaces,
  never
>

export async function runOperation<A, E>(
  runtime: CommandRuntime,
  operation: Operation,
  work: Effect.Effect<
    A,
    E,
    | BranchReview
    | GitContext
    | ReviewSession
    | PullRequestReview
    | ReviewSessions
    | RepositoryCatalog
    | RepositoryDirectory
    | ReviewWorkspaces
  >,
  onFailure?: () => void | Promise<void>,
  signal?: AbortSignal,
  summarize?: (value: A) => 'success' | 'partial',
) {
  const exit = await runtime.runPromiseExit(observeOperation(operation, work, summarize), {
    signal,
  })

  if (exit._tag === 'Success') return exit.value

  if (Cause.hasInterruptsOnly(exit.cause)) return undefined
  await onFailure?.()
  const error = Cause.findErrorOption(exit.cause)
  const provider = Option.flatMap(error, Schema.decodeUnknownOption(DiscoveryError))

  const message =
    Option.isSome(error) &&
    (error.value instanceof ReviewError || error.value instanceof GitContextError)
      ? error.value.message
      : Option.isSome(error) && error.value instanceof ReviewStorageError
        ? reviewStorageMessage(error.value)
        : Option.isSome(error) && error.value instanceof CatalogError
          ? 'The shared Duff catalog could not be read or updated. Check disk access and try again. Existing data has been preserved.'
          : Option.isSome(provider)
            ? providerError(provider.value)
            : 'Operation failed. Refresh to retry; provider sign-in may be unavailable in this editor.'

  await vscode.window.showErrorMessage(`Duff: ${message}`)

  return undefined
}

export function reviewStorageMessage(error: ReviewStorageError): string {
  switch (error.reason) {
    case 'busy':
      return 'Saved reviews are in use by another window. Close that workspace window and reload to resume.'
    case 'invalid':
      return 'Saved review data is invalid. It has been preserved; restore valid review storage before reloading.'
    case 'unavailable':
      return 'Saved reviews require a workspace with local editor storage. Open a folder and try again.'
    case 'write-failed':
      return 'Could not confirm that review progress was saved. Check workspace storage and reload before continuing; the last durable session will be recovered.'
  }
}
