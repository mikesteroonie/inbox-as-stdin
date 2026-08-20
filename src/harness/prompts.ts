/**
 * Prompt template loader (§7). Templates are files, not string literals, so
 * they can be read and edited by a person without touching TypeScript.
 *
 * Substitution is deliberately dumb: `{{name}}` → value, no logic, no
 * includes, no partials. A template language is a place for bugs to hide, and
 * these are prompts, not a rendering engine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Resolve `prompts/` next to the compiled output, or in src when run via tsx. */
function promptsDir(): string {
  const candidates = [
    join(here, 'prompts'),
    resolve(here, '../../src/harness/prompts'),
    resolve(process.cwd(), 'src/harness/prompts'),
  ]
  for (const dir of candidates) if (existsSync(dir)) return dir
  throw new Error(`prompt templates not found; looked in:\n  ${candidates.join('\n  ')}`)
}

const cache = new Map<string, string>()

export type PromptName =
  | 'system'
  | 'task'
  | 'resume-answer'
  | 'resume-unavailable'
  | 'outreach-question'
  | 'outreach-footer'
  | 'permission'

export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const text = readFileSync(join(promptsDir(), `${name}.md`), 'utf8')
  cache.set(name, text)
  return text
}

/**
 * Replace `{{key}}` with `vars[key]`. Unknown placeholders render empty and
 * are reported by `missingVars` — a silently blank prompt section is a bug we
 * want visible in tests, not in production.
 */
export function render(template: string, vars: Record<string, string | number>): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const v = vars[key]
      return v === undefined ? '' : String(v)
    })
    // Collapse the blank-line runs left behind by empty optional sections.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function missingVars(template: string, vars: Record<string, unknown>): string[] {
  const names = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)
  return [...new Set(names.filter((n) => vars[n] === undefined))]
}

export function renderPrompt(name: PromptName, vars: Record<string, string | number>): string {
  return render(loadPrompt(name), vars)
}
