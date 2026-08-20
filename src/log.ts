/**
 * Structured-ish logging. One line per event, prefixed with a level and a
 * scope, so `harness up` output greps cleanly. Not a framework.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const raw = (process.env.HARNESS_LOG_LEVEL ?? 'info').toLowerCase()
  return ORDER[raw as Level] ?? ORDER.info
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${scope}]`, msg]
  if (fields && Object.keys(fields).length > 0) {
    parts.push(
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' '),
    )
  }
  const line = parts.join(' ')
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(sub: string): Logger
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => logger(`${scope}:${sub}`),
  }
}
