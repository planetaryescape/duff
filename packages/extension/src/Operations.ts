import { type GitComparison, GitComparisonError } from '@duff/core/git-comparison'
import { type GitRepository, GitRepositoryError } from '@duff/core/git-repository'
import { type RepositorySession } from '@duff/core/repository-session'
import { Cause, type Effect, type ManagedRuntime, Option } from 'effect'
import * as vscode from 'vscode'

import { observeOperation, type Operation } from './telemetry/Telemetry'

export type CommandRuntime = ManagedRuntime.ManagedRuntime<
  GitComparison | GitRepository | RepositorySession,
  never
>

export async function runOperation<A, E>(
  runtime: CommandRuntime,
  operation: Operation,
  work: Effect.Effect<A, E, GitComparison | GitRepository | RepositorySession>,
  onFailure?: () => void,
  signal?: AbortSignal,
  summarize?: (value: A) => 'success' | 'partial',
) {
  const exit = await runtime.runPromiseExit(observeOperation(operation, work, summarize), {
    signal,
  })

  if (exit._tag === 'Success') return exit.value

  if (Cause.hasInterruptsOnly(exit.cause)) return undefined
  onFailure?.()
  const error = Cause.findErrorOption(exit.cause)

  const message =
    Option.isSome(error) &&
    (error.value instanceof GitComparisonError || error.value instanceof GitRepositoryError)
      ? error.value.message
      : 'Operation failed. Refresh to retry; provider sign-in may be unavailable in this editor.'

  await vscode.window.showErrorMessage(`Duff: ${message}`)

  return undefined
}
