/**
 * Minimal .env loader (no dependency): first definition wins. Must be
 * imported before anything that reads process.env at module init.
 */

import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    const key = match?.[1]
    if (key && match && process.env[key] === undefined) {
      process.env[key] = match[2]
    }
  }
}
