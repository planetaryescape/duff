import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, openSync } from 'node:fs'

const stderr = 2

export function protectTerminalOutput(platform: 'darwin' | 'linux'): () => void {
  if (!process.stderr.isTTY) return () => {}

  const libc = dlopen(platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    dup: { args: [FFIType.int], returns: FFIType.int },
    dup2: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  })

  try {
    const sink = openSync('/dev/null', 'w')

    try {
      const saved = libc.symbols.dup(stderr)

      if (saved < 0) throw new Error('Could not save stderr')

      if (libc.symbols.dup2(sink, stderr) < 0) {
        closeSync(saved)
        throw new Error('Could not redirect stderr')
      }

      return () => {
        try {
          libc.symbols.dup2(saved, stderr)
          closeSync(saved)
        } finally {
          libc.close()
        }
      }
    } finally {
      closeSync(sink)
    }
  } catch (error) {
    libc.close()
    throw error
  }
}
