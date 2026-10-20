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
