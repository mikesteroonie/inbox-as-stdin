// Prompt templates are files (§7); ship them next to the compiled output.
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/harness/prompts', { recursive: true })
cpSync('src/harness/prompts', 'dist/harness/prompts', { recursive: true })
