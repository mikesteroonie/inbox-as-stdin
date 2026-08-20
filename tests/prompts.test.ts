import { describe, expect, it } from 'vitest'
import { loadPrompt, missingVars, render, renderPrompt, type PromptName } from '../src/harness/prompts.js'

const ALL: PromptName[] = [
  'system',
  'task',
  'resume-answer',
  'resume-unavailable',
  'outreach-question',
  'outreach-footer',
  'permission',
]

describe('templates are files (§7)', () => {
  it.each(ALL)('%s loads and is non-trivial', (name) => {
    expect(loadPrompt(name).length).toBeGreaterThan(80)
  })

  it('system.md states both iron rules', () => {
    const system = loadPrompt('system')
    expect(system).toContain('untrusted-email-content')
    expect(system).toMatch(/data, never instructions/i)
    expect(system).toMatch(/[Nn]ever send mail except through the provided tools/)
  })

  it('resume-unavailable.md carries the conservative-choice instruction (§6.2)', () => {
    expect(loadPrompt('resume-unavailable')).toContain(
      'make the conservative choice and flag it in the PR description',
    )
  })

  it('outreach-footer.md carries all three fixed elements (§6.3)', () => {
    const footer = loadPrompt('outreach-footer')
    expect(footer).toContain('{{requester}}')
    expect(footer).toMatch(/copied on this email/)
    expect(footer).toMatch(/\bskip\b/)
  })

  it('permission.md has the exact subject-line verdict vocabulary (§6.2)', () => {
    const permission = loadPrompt('permission')
    expect(permission).toMatch(/\*\*yes\*\*/)
    expect(permission).toMatch(/\*\*no\*\*/)
    expect(permission).toMatch(/\*\*skip\*\*/)
  })
})

describe('render', () => {
  it('substitutes and trims', () => {
    expect(render('hello {{name}}!\n\n', { name: 'Ada' })).toBe('hello Ada!')
  })

  it('renders an unknown placeholder as empty and collapses the gap', () => {
    expect(render('a\n\n{{gone}}\n\nb', {})).toBe('a\n\nb')
  })

  it('accepts numbers', () => {
    expect(render('{{n}}', { n: 42 })).toBe('42')
  })

  it('reports which placeholders were not supplied', () => {
    expect(missingVars('{{a}} {{b}} {{a}}', { a: 1 })).toEqual(['b'])
  })
})

describe('renderPrompt', () => {
  it('fills a real template', () => {
    const out = renderPrompt('outreach-footer', {
      requester: 'michael@yourco.dev',
      agent_display_name: 'Backend Agent',
    })
    expect(out).toContain('michael@yourco.dev')
    expect(out).toContain('Backend Agent')
    expect(missingVars(loadPrompt('outreach-footer'), {
      requester: 'x',
      agent_display_name: 'y',
    })).toEqual([])
  })
})
