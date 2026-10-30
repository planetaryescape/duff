import { createInterface } from 'node:readline'

import { makeStandaloneBridge } from './Bridge'

const bridge = makeStandaloneBridge(process.env)

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })

const shutdown = new AbortController()

function stop() {
  shutdown.abort()
  input.close()
  process.stdin.destroy()
}

process.once('SIGTERM', stop)

process.once('SIGINT', stop)

try {
  for await (const line of input) {
    if (shutdown.signal.aborted) break

    const response = await bridge
      .handle(line, shutdown.signal)
      .catch(() => ({ id: 0, ok: false, error: 'Review operation unavailable.' }))

    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(response)}\n`, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }
} catch {
  // A closed pipe or shutdown is not a reason to print platform diagnostics.
  process.exitCode = shutdown.signal.aborted ? 0 : 1
} finally {
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  input.close()
  await bridge.dispose().catch(() => {
    process.exitCode = 1
  })
}
