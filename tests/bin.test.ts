/**
 * The executable, exercised the way people actually invoke it.
 *
 * `harness init` once exited silently with status 0 under `npm link`: the CLI
 * decided whether it was "the program" by comparing `import.meta.url` to
 * `process.argv[1]`, and those never match through a symlink, because the
 * former resolves symlinks and the latter does not. Running `node dist/cli.js`
 * directly worked fine, which is exactly why it shipped.
 *
 * So these run the built binary through a symlink, not directly.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BIN = resolve('dist/bin.js')
const built = existsSync(BIN)
// Vitest runs against src; this needs `npm run build` first.
const whenBuilt = built ? describe : describe.skip

whenBuilt('the harness binary', () => {
  const run = (path: string, args: string[] = ['--version']): string =>
    execFileSync(path, args, { encoding: 'utf8', timeout: 60_000 }).trim()

  it('runs when invoked directly', () => {
    expect(run(process.execPath, [BIN, '--version'])).toBe('0.1.0')
  })

  it('runs through a symlink, which is how npm link installs it', () => {
    chmodSync(BIN, 0o755)
    const dir = mkdtempSync(join(tmpdir(), 'harness-bin-'))
    const link = join(dir, 'harness')
    symlinkSync(BIN, link)
    expect(run(link)).toBe('0.1.0')
  })

  it('runs through a chain of symlinks, which is how global installs resolve', () => {
    chmodSync(BIN, 0o755)
    const dir = mkdtempSync(join(tmpdir(), 'harness-bin-'))
    const first = join(dir, 'harness')
    const second = join(dir, 'harness-shim')
    symlinkSync(BIN, first)
    symlinkSync(first, second)
    expect(run(second)).toBe('0.1.0')
  })

  it('reaches its subcommands through the symlink, not just --version', () => {
    chmodSync(BIN, 0o755)
    const dir = mkdtempSync(join(tmpdir(), 'harness-bin-'))
    const link = join(dir, 'harness')
    symlinkSync(BIN, link)
    const help = run(link, ['--help'])
    for (const command of ['init', 'up', 'send', 'tail', 'doctor', 'mcp']) {
      expect(help, command).toContain(command)
    }
  })
})

describe('the cli module', () => {
  it('parses no argv on import, so importing it cannot exit the process', async () => {
    // If this module had a top-level main(), importing it here would parse
    // vitest's argv and call process.exit mid-suite.
    const mod = await import('../src/cli.js')
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.describeError).toBe('function')
  })
})
