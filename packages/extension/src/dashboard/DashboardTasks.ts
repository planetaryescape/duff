import { Effect } from 'effect'

export class DashboardTasks {
  #controller = new AbortController()

  constructor(readonly start: (work: Effect.Effect<void>, options: Effect.RunOptions) => void) {}

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  run(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.signal.aborted) return
    this.start(Effect.promise(work), { signal: this.signal })
  }

  dispose(): void {
    this.#controller.abort()
  }
}
