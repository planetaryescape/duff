import type { AppState } from './ReviewApp'

export class ReviewStore {
  private state: AppState
  private readonly listeners = new Set<() => void>()

  constructor(initial: AppState) {
    this.state = initial
  }

  readonly getSnapshot = (): AppState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  set(state: AppState): void {
    this.state = state

    for (const listener of this.listeners) listener()
  }
}
