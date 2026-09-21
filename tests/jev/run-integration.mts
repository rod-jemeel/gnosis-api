/**
 * Cross-platform runner for the Jev integration suite: sets the opt-in
 * flag, requires a reachable database URL, and executes the test files
 * in-process (Windows `cmd` cannot parse `VAR=1 cmd` inline forms).
 */

import '../../src/env.js'

if (!process.env.DATABASE_URL) {
  console.error(
    'Integration tests need a reachable database:\n' +
      '  DATABASE_URL=postgres://... pnpm test:jev:integration\n' +
      '(docker compose --profile dev up -d provides one locally.)'
  )
  process.exit(1)
}

process.env.RUN_JEV_INTEGRATION = '1'

const { run } = await import('node:test')
const { spec } = await import('node:test/reporters')

await new Promise((resolve) => {
  run({ files: ['tests/jev/integration.test.mjs'] })
    .on('test:fail', () => process.exitCode = 1)
    .compose(spec)
    .pipe(process.stdout)
    .on('close', resolve)
})
