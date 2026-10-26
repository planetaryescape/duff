import { expect, it } from 'vitest'

import { DashboardActivity, listenForDashboardActivity } from './DashboardActivity'

it('checks only a ready active dashboard and ignores window blur, hidden panels and picker mode', async () => {
  let active = true
  let dashboard = true
  const requests: AbortSignal[] = []

  const activity = new DashboardActivity(
    () => active,
    () => dashboard,
    async ({ signal }) => {
      requests.push(signal)
    },
  )

  await activity.check()
  expect(requests).toHaveLength(0)
  activity.ready()
  await activity.windowChanged(false)
  active = false
  await activity.windowChanged(true)
  await activity.check()
  active = true
  dashboard = false
  await activity.windowChanged(true)
  expect(requests).toHaveLength(0)
  dashboard = true
  await activity.check()
  await activity.windowChanged(true)
  expect(requests).toHaveLength(2)
  activity.dispose()
  await activity.check()
  expect(requests).toHaveLength(2)
})

it('joins concurrent activation and focus checks and cancels owned work on panel disposal', async () => {
  const requests: AbortSignal[] = []

  const activity = new DashboardActivity(
    () => true,
    () => true,
    ({ signal }) =>
      new Promise<void>((resolve) => {
        requests.push(signal)
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
  )

  activity.ready()
  const activation = activity.check()
  const focused = activity.windowChanged(true)
  expect(requests).toHaveLength(1)
  expect(focused).toBe(activation)
  activity.dispose()
  expect(requests[0]?.aborted).toBe(true)
  await Promise.all([activation, focused])
  await activity.windowChanged(true)
  expect(requests).toHaveLength(1)
})

class NativeEvent<A> {
  readonly listeners = new Set<(event: A) => void>()
  readonly event = (listener: (event: A) => void) => {
    this.listeners.add(listener)

    return {
      dispose: () => {
        this.listeners.delete(listener)
      },
    }
  }

  emit(event: A): void {
    for (const listener of this.listeners) listener(event)
  }
}

it('wires native activation and window callbacks through the same check and releases listeners on panel disposal', async () => {
  const view = new NativeEvent<void>()
  const window = new NativeEvent<{ focused: boolean }>()
  const disposed = new NativeEvent<void>()
  const requests: AbortSignal[] = []
  const work: Promise<void>[] = []
  let active = false
  let dashboard = true

  const activity = new DashboardActivity(
    () => active,
    () => dashboard,
    async ({ signal }) => {
      requests.push(signal)
    },
  )

  listenForDashboardActivity(
    { onDidChangeViewState: view.event, onDidDispose: disposed.event },
    { onDidChangeWindowState: window.event },
    activity,
    (run) => {
      work.push(run())
    },
  )
  activity.ready()
  window.emit({ focused: true })
  view.emit()
  await Promise.all(work)
  expect(requests).toHaveLength(0)
  active = true
  view.emit()
  window.emit({ focused: true })
  await Promise.all(work)
  expect(requests).toHaveLength(1)
  dashboard = false
  view.emit()
  window.emit({ focused: true })
  await Promise.all(work)
  expect(requests).toHaveLength(1)
  disposed.emit()
  expect(requests[0]?.aborted).toBe(true)
  expect(view.listeners.size).toBe(0)
  expect(window.listeners.size).toBe(0)
  expect(disposed.listeners.size).toBe(0)
  active = true
  dashboard = true
  view.emit()
  window.emit({ focused: true })
  await Promise.all(work)
  expect(requests).toHaveLength(1)
})
