import { posix, win32 } from 'node:path'

/** Resolve host-local user storage independently of the editor's profile or product name. */
export function dashboardDataDirectory(input: {
  readonly platform: string
  readonly homedir: string
  readonly environment: Readonly<Record<string, string | undefined>>
}): string {
  if (input.platform === 'win32') {
    const configured = input.environment.LOCALAPPDATA

    const base =
      configured !== undefined && win32.isAbsolute(configured)
        ? configured
        : win32.join(input.homedir, 'AppData', 'Local')

    return win32.join(base, 'Duff', 'dashboard')
  }

  if (input.platform === 'darwin')
    return posix.join(input.homedir, 'Library', 'Application Support', 'Duff', 'dashboard')
  const configured = input.environment.XDG_DATA_HOME

  const base =
    configured !== undefined && posix.isAbsolute(configured)
      ? configured
      : posix.join(input.homedir, '.local', 'share')

  return posix.join(base, 'duff', 'dashboard')
}
