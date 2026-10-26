import { type Effect } from 'effect'
import { expect, it } from 'vitest'

import { DashboardTasks } from './DashboardTasks'

it('attaches the panel lifetime to every callback and prevents scheduling after close', () => {
  const scheduled: Effect.RunOptions[] = []

  const tasks = new DashboardTasks((_work, options) => {
    scheduled.push(options)
  })

  tasks.run(async () => {})
  tasks.run(async () => {})
  expect(scheduled).toHaveLength(2)
  expect(
    scheduled.every((options) => options.signal === tasks.signal && !options.signal.aborted),
  ).toBe(true)
  tasks.dispose()
  expect(scheduled.every((options) => options.signal?.aborted)).toBe(true)
  tasks.run(async () => {
    throw new Error('Closed panels cannot start callbacks')
  })
  expect(scheduled).toHaveLength(2)
})
