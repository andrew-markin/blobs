import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(script, env) {
  // Run in an empty directory, so that no .env file is loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-startup-'))
  try {
    const { TOKEN_SECRET, ...rest } = process.env // eslint-disable-line no-unused-vars
    return spawnSync(process.execPath, [path.join(root, script), 'bucket'], {
      cwd,
      env: { ...rest, STORAGE: cwd, PORT: '0', ...env },
      encoding: 'utf8',
      timeout: 10000
    })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

describe('startup', () => {
  for (const script of ['src/server.js', 'src/token.js']) {
    it(`${script} refuses to run without TOKEN_SECRET`, () => {
      const { status, stderr } = run(script, {})
      assert.notEqual(status, 0)
      assert.match(stderr, /TOKEN_SECRET environment variable is not set/)
    })
  }

  it('src/token.js issues tokens with TOKEN_SECRET', () => {
    const { status, stdout } = run('src/token.js', { TOKEN_SECRET: 'TEST_SECRET' })
    assert.equal(status, 0)
    assert.match(stdout, /^Token for bucket: bucket\neyJ/)
  })
})
