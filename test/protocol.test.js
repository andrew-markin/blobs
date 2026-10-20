// Contract tests of the Socket.IO protocol used by the existing clients
// (Split, Split-One and Gestalt). They must keep passing unchanged.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

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

function waitForEvent(client, event, timeout = 300) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout)
    client.once(event, () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

const randomRef = () => randomBytes(32).toString('hex')
const randomData = () => randomBytes(64).toString('base64')

after(async () => {
  clients.forEach((client) => client.disconnect())
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(storageDir, { recursive: true, force: true })
})

describe('authorization', () => {
  it('rejects connections without a valid token', async () => {
    await assert.rejects(connect('invalid'), { message: 'Access denied' })
    await assert.rejects(connect(null), { message: 'Access denied' })
  })
})

describe('now', () => {
  it('returns the server timestamp', async () => {
    const client = await connect()
    const { timestamp } = await submit(client, 'now')
    assert.ok(Math.abs(timestamp - Date.now()) < 5000)
  })
})

describe('ref', () => {
  let client
  before(async () => (client = await connect()))

  it('acknowledges a valid reference with no data', async () => {
    assert.equal(await submit(client, 'ref', randomRef()), undefined)
  })

  it('accepts null and undefined to unsubscribe', async () => {
    assert.equal(await submit(client, 'ref', null), undefined)
    assert.equal(await submit(client, 'ref', undefined), undefined)
  })

  it('rejects an invalid reference', async () => {
    const res = await submit(client, 'ref', 'not-a-ref')
    assert.equal(typeof res.error, 'string')
  })
})

describe('get and set', () => {
  let client
  before(async () => (client = await connect()))

  it('require a reference', async () => {
    await submit(client, 'ref', null)
    assert.deepEqual(await submit(client, 'get', {}), { error: 'Reference is not provided' })
    assert.deepEqual(await submit(client, 'set', { data: randomData() }), {
      error: 'Reference is not provided'
    })
  })

  // Socket.IO delivers an undefined acknowledgement as null
  it('return null for a missing blob', async () => {
    await submit(client, 'ref', randomRef())
    assert.equal(await submit(client, 'get', {}), null)
    assert.equal(await submit(client, 'get', { known: undefined }), null)
  })

  it('create, read and update a blob with versions', async () => {
    await submit(client, 'ref', randomRef())
    const first = randomData()
    assert.deepEqual(await submit(client, 'set', { data: first }), { success: true, version: 1 })
    assert.deepEqual(await submit(client, 'get', {}), { data: first, version: 1 })
    assert.deepEqual(await submit(client, 'get', { known: undefined }), { data: first, version: 1 })
    // The data is omitted when the known version is the current one
    assert.deepEqual(await submit(client, 'get', { known: 1 }), { version: 1 })

    const second = randomData()
    assert.deepEqual(await submit(client, 'set', { data: second, version: 1 }), {
      success: true,
      version: 2
    })
    assert.deepEqual(await submit(client, 'get', { known: 1 }), { data: second, version: 2 })
  })

  it('reject updates of stale versions returning the current blob', async () => {
    await submit(client, 'ref', randomRef())
    const current = randomData()
    await submit(client, 'set', { data: current })
    await submit(client, 'set', { data: current, version: 1 })

    const conflict = { success: false, data: current, version: 2 }
    assert.deepEqual(await submit(client, 'set', { data: randomData(), version: 1 }), conflict)
    assert.deepEqual(await submit(client, 'set', { data: randomData() }), conflict)
    assert.deepEqual(await submit(client, 'get', {}), { data: current, version: 2 })
  })

  it('reject invalid data and versions', async () => {
    await submit(client, 'ref', randomRef())
    assert.equal(typeof (await submit(client, 'set', { data: 'not base64!' })).error, 'string')
    assert.equal(
      typeof (await submit(client, 'set', { data: randomData(), version: 0 })).error,
      'string'
    )
    assert.equal(typeof (await submit(client, 'get', { known: 'one' })).error, 'string')
  })
})

describe('oversized requests', () => {
  // Socket.IO limits messages to 1e6 bytes, so such requests break the
  // connection instead of failing
  it('disconnect the client', async () => {
    const client = await connect()
    await submit(client, 'ref', randomRef())
    const disconnected = new Promise((resolve) => client.once('disconnect', resolve))
    client.emit('set', { data: 'A'.repeat(1e6) }, () => {})
    assert.equal(await disconnected, 'transport close')
  })
})

describe('isolation', () => {
  it('separates blobs of different buckets', async () => {
    const ref = randomRef()
    const one = await connect(getToken('one'))
    const two = await connect(getToken('two'))
    await submit(one, 'ref', ref)
    await submit(two, 'ref', ref)
    await submit(one, 'set', { data: randomData() })
    assert.equal(await submit(two, 'get', {}), null)
  })
})

describe('changed', () => {
  it('notifies other subscribers of the same blob only', async () => {
    const ref = randomRef()
    const author = await connect()
    const sibling = await connect()
    const stranger = await connect()
    const foreigner = await connect(getToken('other'))
    await submit(author, 'ref', ref)
    await submit(sibling, 'ref', ref)
    await submit(stranger, 'ref', randomRef())
    await submit(foreigner, 'ref', ref)

    const events = [author, sibling, stranger, foreigner].map((c) => waitForEvent(c, 'changed'))
    await submit(author, 'set', { data: randomData() })
    assert.deepEqual(await Promise.all(events), [false, true, false, false])
  })

  it('is not sent for rejected updates', async () => {
    const ref = randomRef()
    const author = await connect()
    const sibling = await connect()
    await submit(author, 'ref', ref)
    await submit(sibling, 'ref', ref)
    const created = waitForEvent(sibling, 'changed')
    await submit(author, 'set', { data: randomData() })
    // The notification is sent after the acknowledgement to the author
    assert.equal(await created, true)

    const event = waitForEvent(sibling, 'changed')
    await submit(author, 'set', { data: randomData(), version: 5 })
    assert.equal(await event, false)
  })

  it('stops after unsubscribing', async () => {
    const ref = randomRef()
    const author = await connect()
    const sibling = await connect()
    await submit(author, 'ref', ref)
    await submit(sibling, 'ref', ref)
    await submit(sibling, 'ref', null)

    const event = waitForEvent(sibling, 'changed')
    await submit(author, 'set', { data: randomData() })
    assert.equal(await event, false)
  })
})

describe('requests without acknowledgement', () => {
  it('disconnect the client', async () => {
    const client = await connect()
    const disconnected = new Promise((resolve) => client.once('disconnect', resolve))
    client.emit('now')
    assert.equal(await disconnected, 'io server disconnect')
  })
})
