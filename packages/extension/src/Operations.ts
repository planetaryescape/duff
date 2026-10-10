import { type GitContext, GitContextError } from '@duff/core/git-context'
import { type BranchReview, ReviewError } from '@duff/core/review'
import { type ReviewSession } from '@duff/core/review-session'
import { Cause, type Effect, type ManagedRuntime, Option } from 'effect'
import * as vscode from 'vscode'

import { observeOperation, type Operation } from './telemetry/Telemetry'

export type CommandRuntime = ManagedRuntime.ManagedRuntime<
  BranchReview | GitContext | ReviewSession,
  never
>

export async function runOperation<A, E>(
  runtime: CommandRuntime,
  operation: Operation,
  work: Effect.Effect<A, E, BranchReview | GitContext | ReviewSession>,
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
    (error.value instanceof ReviewError || error.value instanceof GitContextError)
      ? error.value.message
      : 'Operation failed. Refresh to retry; provider sign-in may be unavailable in this editor.'

  await vscode.window.showErrorMessage(`Duff: ${message}`)

  return undefined
}
