import type { BoxRenderable, EmbeddedTerminalRenderable } from '@opentui/core'
import { useLayoutEffect, useRef } from 'react'

interface EditorPaneProps {
  readonly terminal: EmbeddedTerminalRenderable
}

export function EditorPane({ terminal }: EditorPaneProps) {
  const container = useRef<BoxRenderable>(null)
  useLayoutEffect(() => {
    const box = container.current
    box?.add(terminal)

    return () => {
      box?.remove(terminal)
    }
  }, [terminal])

  return <box ref={container} flexGrow={1} minWidth={1} overflow="hidden" />
}
