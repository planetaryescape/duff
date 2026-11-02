import { createInterface } from 'node:readline'

import { Option, Schema } from 'effect'

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

// A private control line is observed independently of the sequential request loop.
// Closing Rune during acquisition must interrupt its Effect scope before Node exits.
function control(line: string) {
  if (line === '{"op":"shutdown"}') stop()
}

input.on('line', control)

const tasks = new Set<Promise<void>>()

async function respond(line: string) {
  const envelope = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ id: Schema.Int })),
  )(line)

  const id = Option.isSome(envelope) ? envelope.value.id : 0

  const response = await bridge
    .handle(line, shutdown.signal)
    .catch(() => ({ id, ok: false, error: 'Review operation unavailable.' }))

  if (shutdown.signal.aborted) return

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, (error) =>
      error ? reject(error) : resolve(),
    )
  })
}

try {
  for await (const line of input) {
    if (shutdown.signal.aborted) break

    // The task set owns every promise, including rejection and shutdown. Read-only
    // language requests must not hold the durable review mutation semaphore.
    const task = respond(line)
      .catch(() => {
        if (!shutdown.signal.aborted) process.exitCode = 1
      })
      .finally(() => tasks.delete(task))

    tasks.add(task)

    if (tasks.size >= 32) await Promise.race(tasks)
  }

  await Promise.all(tasks)
} catch {
  // A closed pipe or shutdown is not a reason to print platform diagnostics.
  process.exitCode = shutdown.signal.aborted ? 0 : 1
} finally {
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  input.removeListener('line', control)
  input.close()
  shutdown.abort()
  await Promise.all(tasks)
  await bridge.dispose().catch(() => {
    process.exitCode = 1
  })
}
