#!/usr/bin/env node
/**
 * The executable. Nothing but the entry point lives here.
 *
 * `cli.ts` used to invoke itself when it decided it was the program, which
 * broke the moment the binary was reached through a symlink — `npm link`, a
 * global install, a Homebrew shim — because `import.meta.url` resolves
 * symlinks and `process.argv[1]` does not, so the two never matched and the
 * command exited silently with status 0. Splitting the entry point out means
 * there is nothing to detect: importing `cli.ts` runs no argv parsing, and
 * running this file always does.
 */

import { main } from './cli.js'

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
