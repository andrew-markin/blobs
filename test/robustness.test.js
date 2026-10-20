// Tests of the server resistance to malformed requests and storage failures

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { io } from 'socket.io-client'

process.env.TOKEN_SECRET = 'TEST_SECRET'

const { getToken } = await import('../src/auth.js')
const { createServer } = await import('../src/app.js')

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blobs-test-'))
const { server } = createServer({ storageDir })
server.listen(0)
const url = `http://localhost:${server.httpServer.address().port}`

const clients = []

function connect(token = getToken('test')) {
  return new Promise((resolve, reject) => {
    const client = io(url, { transports: ['websocket'], auth: { token }, reconnection: false })
    clients.push(client)
    client.on('connect', () => resolve(client))
    client.on('connect_error', reject)
  })
}

function submit(client, event, ...args) {
  return client.timeout(5000).emitWithAck(event, ...args)
}

const randomRef = () => randomBytes(32).toString('hex')

after(async () => {
  clients.forEach((client) => client.disconnect())
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(storageDir, { recursive: true, force: true })
})

describe('malformed requests', () => {
  for (const event of ['get', 'set']) {
    for (const params of [null, 'text', 42]) {
      it(`${event} with ${JSON.stringify(params)} params fails without crashing`, async () => {
        const client = await connect()
        await submit(client, 'ref', randomRef())
        const res = await submit(client, event, params)
        assert.equal(typeof res?.error, 'string')
        // The server is still alive
        assert.equal(typeof (await submit(client, 'now')).timestamp, 'number')
      })
    }
  }
})

const blobPath = (bucket, ref) => path.join(storageDir, bucket, ref.substring(0, 2), `${ref}.json`)

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe('storage failures', () => {
  const blob = { data: 'AAAA', version: 3, created: 1 }

  it('restore the blob from its backup when the write was interrupted', async () => {
    const ref = randomRef()
    const file = blobPath('test', ref)
    await writeFile(`${file}.backup`, JSON.stringify(blob))
    const client = await connect()
    await submit(client, 'ref', ref)
    assert.deepEqual(await submit(client, 'get', {}), { data: 'AAAA', version: 3 })
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), blob)
    await assert.rejects(fs.access(`${file}.backup`))
  })

  it('prefer the backup over a partially written blob', async () => {
    const ref = randomRef()
    const file = blobPath('test', ref)
    await writeFile(file, '{"data":"BB')
    await writeFile(`${file}.backup`, JSON.stringify(blob))
    const client = await connect()
    await submit(client, 'ref', ref)
    assert.deepEqual(await submit(client, 'get', {}), { data: 'AAAA', version: 3 })
    // Stale versions are still rejected after the recovery
    const res = await submit(client, 'set', { data: 'CCCC', version: 1 })
    assert.deepEqual(res, { success: false, data: 'AAAA', version: 3 })
  })
})
