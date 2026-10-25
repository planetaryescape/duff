import { Script } from 'node:vm'

import { DashboardPreferenceChange } from '@duff/core/dashboard-preferences'
import { Schema } from 'effect'
import { expect, it } from 'vitest'

import { dashboardLayoutScript } from './DashboardLayout'

const PreferenceMessage = Schema.Struct({
  action: Schema.Literal('preference'),
  change: DashboardPreferenceChange,
})

interface PreferenceMessage extends Schema.Schema.Type<typeof PreferenceMessage> {}

interface SavedLayout {
  readonly otherState?: string
  readonly columnWidths?: {
    readonly navigation?: number | string
    readonly details?: number | string
  }
}

interface EventValues {
  readonly pointerId?: number
  readonly button?: number
  readonly clientX?: number
  readonly key?: string
  readonly shiftKey?: boolean
}

function layoutFixture(saved?: SavedLayout) {
  const messages: unknown[] = []
  const properties = new Map<string, string>()
  const captured = new Set<number>()
  const classes = new Set<string>()

  const handles = ['navigation', 'details'].map((side) => {
    const attributes = new Map<string, string>()

    const handle = {
      dataset: { resize: side },
      getAttribute: (name: string) => attributes.get(name),
      setAttribute: (name: string, value: string | number) => attributes.set(name, String(value)),
      removeAttribute: (name: string) => attributes.delete(name),
    }

    return { ...handle, closest: () => handle }
  })

  type FixtureEvent = EventValues & {
    readonly target: (typeof handles)[number] | undefined
    readonly preventDefault: () => void
  }

  const listeners = new Map<string, (event: FixtureEvent) => void>()

  const layout = {
    clientWidth: 1400,
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    querySelector: (selector: string) =>
      handles.find((handle) => selector.includes('"' + handle.dataset.resize + '"')),
  }

  const window = {
    innerWidth: 1400,
    addEventListener: (name: string, receive: () => void) => listeners.set(name, receive),
  }

  let state = saved

  new Script(dashboardLayoutScript + '\napplyLayout();').runInNewContext({
    bridge: {
      postMessage: (message: PreferenceMessage) =>
        messages.push(Schema.decodeUnknownSync(PreferenceMessage)(message)),
      getState: () => state,
      setState: (value: SavedLayout) => {
        state = value
      },
    },
    document: {
      querySelector: () => layout,
      querySelectorAll: () => handles,
      body: {
        classList: {
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
        },
      },
      documentElement: {
        setPointerCapture: (id: number) => captured.add(id),
        hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => captured.delete(id),
      },
      addEventListener: (name: string, receive: (event: FixtureEvent) => void) =>
        listeners.set(name, receive),
    },
    window,
  })

  return {
    messages,
    layout,
    window,
    captured,
    classes,
    state: () => state,
    width: (side: string) => properties.get('--' + side + '-width'),
    send: (name: string, side = 'navigation', values: EventValues = {}) => {
      listeners.get(name)?.({
        target: handles.find((handle) => handle.dataset.resize === side),
        pointerId: 1,
        button: 0,
        clientX: 240,
        preventDefault: () => {},
        ...values,
      })
    },
  }
}

it('drags both dividers, bounds widths, and restores the saved layout', () => {
  const fixture = layoutFixture({ otherState: 'preserved' })

  fixture.send('pointerdown')
  fixture.send('pointermove', 'navigation', { clientX: 340 })
  expect(fixture.width('navigation')).toBe('340px')
  expect(fixture.captured.has(1)).toBe(true)
  fixture.send('pointerup')
  expect(fixture.captured.size).toBe(0)
  expect(fixture.classes.size).toBe(0)

  fixture.send('pointerdown', 'details', { clientX: 1100 })
  fixture.send('pointermove', 'details', { clientX: 1000 })
  expect(fixture.width('details')).toBe('400px')
  fixture.send('pointermove', 'details', { clientX: -5000 })
  expect(fixture.width('details')).toBe('770px')
  fixture.send('pointercancel', 'details')
  expect(fixture.state()).toEqual({
    otherState: 'preserved',
    columnWidths: { navigation: 340, details: 770 },
  })
  expect(fixture.messages[fixture.messages.length - 1]).toEqual({
    action: 'preference',
    change: { _tag: 'ResizeColumns', columnWidths: { navigation: 340, details: 770 } },
  })

  const restored = layoutFixture(fixture.state())
  expect(restored.width('navigation')).toBe('340px')
  expect(restored.width('details')).toBe('770px')
})

it('supports keyboard resizing without collapsing the center column', () => {
  const fixture = layoutFixture()

  fixture.send('keydown', 'navigation', { key: 'ArrowRight' })
  expect(fixture.width('navigation')).toBe('256px')
  fixture.send('keydown', 'details', { key: 'ArrowLeft', shiftKey: true })
  expect(fixture.width('details')).toBe('348px')
  fixture.send('keydown', 'navigation', { key: 'Home' })
  expect(fixture.width('navigation')).toBe('160px')
  fixture.send('keydown', 'details', { key: 'End' })
  expect(fixture.width('details')).toBe('950px')
  fixture.send('keydown', 'details', { key: 'Home' })
  expect(fixture.width('details')).toBe('240px')
})

it('ignores malformed saved widths and adapts to smaller viewports without losing preferences', () => {
  const fixture = layoutFixture({ columnWidths: { navigation: '700', details: -1 } })

  expect(fixture.width('navigation')).toBe('240px')
  expect(fixture.width('details')).toBe('300px')
  fixture.send('keydown', 'navigation', { key: 'End' })
  expect(fixture.width('navigation')).toBe('810px')
  fixture.layout.clientWidth = 800
  fixture.window.innerWidth = 800
  fixture.send('resize')
  expect(fixture.width('navigation')).toBe('555px')
  fixture.send('keydown', 'details', { key: 'End' })
  fixture.layout.clientWidth = 1400
  fixture.window.innerWidth = 1400
  fixture.send('resize')
  expect(fixture.width('navigation')).toBe('810px')
  expect(fixture.width('details')).toBe('300px')
})

it('ignores secondary buttons and unrelated pointers and releases lost capture', () => {
  const fixture = layoutFixture()

  fixture.send('pointerdown', 'navigation', { button: 2 })
  expect(fixture.captured.size).toBe(0)
  fixture.send('pointerdown')
  fixture.send('pointermove', 'navigation', { clientX: 340, pointerId: 2 })
  fixture.send('pointerup', 'navigation', { pointerId: 2 })
  expect(fixture.width('navigation')).toBe('240px')
  expect(fixture.captured.size).toBe(1)
  fixture.send('lostpointercapture')
  expect(fixture.captured.size).toBe(0)
  expect(fixture.classes.size).toBe(0)
})
