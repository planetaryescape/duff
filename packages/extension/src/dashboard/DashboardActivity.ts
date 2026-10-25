export class DashboardActivity {
  #ready = false
  #closed = false
  #pending: Promise<void> | undefined
  #controller = new AbortController()

  constructor(
    readonly active: () => boolean,
    readonly dashboard: () => boolean,
    readonly refresh: (options: { readonly signal: AbortSignal }) => Promise<void>,
  ) {}

  ready(): void {
    this.#ready = true
  }

  check(): Promise<void> {
    if (this.#closed || !this.#ready || !this.active() || !this.dashboard())
      return Promise.resolve()

    if (this.#pending) return this.#pending
    const controller = this.#controller

    const pending = this.refresh({ signal: controller.signal }).finally(() => {
      if (this.#pending === pending) this.#pending = undefined
    })

    this.#pending = pending

    return pending
  }

  windowChanged(focused: boolean): Promise<void> {
    return focused ? this.check() : Promise.resolve()
  }

  dispose(): void {
    this.#closed = true
    this.#ready = false
    this.#controller.abort()
  }
}

interface Disposable {
  readonly dispose: () => void
}

class ActivitySubscriptions {
  constructor(
    readonly activity: DashboardActivity,
    readonly listeners: ReadonlyArray<Disposable>,
  ) {}

  dispose(): void {
    this.activity.dispose()

    for (const listener of this.listeners) listener.dispose()
  }
}

export function listenForDashboardActivity(
  panel: {
    readonly onDidChangeViewState: (listener: () => void) => Disposable
    readonly onDidDispose: (listener: () => void) => Disposable
  },
  window: {
    readonly onDidChangeWindowState: (
      listener: (event: { readonly focused: boolean }) => void,
    ) => Disposable
  },
  activity: DashboardActivity,
  run: (work: () => Promise<void>) => void,
): Disposable {
  const subscriptions = new ActivitySubscriptions(activity, [
    panel.onDidChangeViewState(() => run(() => activity.check())),
    window.onDidChangeWindowState((event) => run(() => activity.windowChanged(event.focused))),
    panel.onDidDispose(() => subscriptions.dispose()),
  ])

  return subscriptions
}
