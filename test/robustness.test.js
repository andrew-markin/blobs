// Tests of the server resistance to malformed requests and storage failures

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import fsExtra from 'fs-extra'
import { io } from 'socket.io-client'

process.env.TOKEN_SECRET = 'TEST_SECRET'

const { getToken } = await import('../src/auth.js')
const { createServer } = await import('../src/app.js')

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blobs-test-'))
const { server, execLock } = createServer({ storageDir })
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

describe('rate limit', () => {
  it('fails requests above the burst until it refills', async () => {
    const client = await connect()
    const results = await Promise.all(Array.from({ length: 25 }, () => submit(client, 'now')))
    const limited = results.filter((res) => res.error === 'Too many requests')
    assert.equal(limited.length, 5)
    // 5 requests per second refill a token in 200ms
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(typeof (await submit(client, 'now')).timestamp, 'number')
  })
})

describe('data limit', () => {
  it('accepts the longest data and fails longer data with an error', async () => {
    const client = await connect()
    await submit(client, 'ref', randomRef())
    const longest = 'A'.repeat(999000)
    assert.deepEqual(await submit(client, 'set', { data: longest }), { success: true, version: 1 })
    const res = await submit(client, 'set', { data: `${longest}AAAA`, version: 1 })
    assert.equal(typeof res.error, 'string')
    assert.equal(client.connected, true)
  })
})

// Blobs of random references may share directories, so only the files of the
// given blob are listed
async function blobFiles(bucket, ref) {
  const names = await fs.readdir(path.dirname(blobPath(bucket, ref)))
  return names.filter((name) => name.startsWith(ref))
}

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

  it('keep a corrupted blob aside and treat it as missing', async () => {
    const ref = randomRef()
    const file = blobPath('test', ref)
    await writeFile(file, 'not json')
    const client = await connect()
    await submit(client, 'ref', ref)
    assert.equal(await submit(client, 'get', {}), null)
    const kept = (await fs.readdir(path.dirname(file))).filter((name) =>
      name.startsWith(`${ref}.json.corrupted-`)
    )
    assert.equal(kept.length, 1)
    assert.equal(await fs.readFile(path.join(path.dirname(file), kept[0]), 'utf8'), 'not json')
    assert.deepEqual(await submit(client, 'set', { data: 'DDDD' }), { success: true, version: 1 })
  })

  it('report read errors without touching the blob', async () => {
    const ref = randomRef()
    const file = blobPath('test', ref)
    await writeFile(file, JSON.stringify(blob))
    await fs.chmod(file, 0o000)
    try {
      const client = await connect()
      await submit(client, 'ref', ref)
      assert.equal(typeof (await submit(client, 'get', {})).error, 'string')
      assert.equal(typeof (await submit(client, 'set', { data: 'GGGG' })).error, 'string')
    } finally {
      await fs.chmod(file, 0o600)
    }
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), blob)
    assert.deepEqual(await blobFiles('test', ref), [`${ref}.json`])
  })

  it('leave no temporary files after writes', async () => {
    const ref = randomRef()
    const client = await connect()
    await submit(client, 'ref', ref)
    await submit(client, 'set', { data: 'EEEE' })
    await submit(client, 'set', { data: 'FFFF', version: 1 })
    assert.deepEqual(await blobFiles('test', ref), [`${ref}.json`])
  })
})

describe('full storage', () => {
  it('fails writes but keeps reads working', async () => {
    const ref = randomRef()
    const client = await connect()
    await submit(client, 'ref', ref)
    await submit(client, 'set', { data: 'IIII' })

    const full = createServer({ storageDir, minFreeSpace: Infinity }).server
    full.listen(0)
    try {
      const fullClient = io(`http://localhost:${full.httpServer.address().port}`, {
        transports: ['websocket'],
        auth: { token: getToken('test') },
        reconnection: false
      })
      clients.push(fullClient)
      await submit(fullClient, 'ref', ref)
      const res = await submit(fullClient, 'set', { data: 'JJJJ', version: 1 })
      assert.deepEqual(res, { error: 'Storage is full' })
      assert.deepEqual(await submit(fullClient, 'get', {}), { data: 'IIII', version: 1 })
    } finally {
      await new Promise((resolve) => full.close(resolve))
    }
  })
})

describe('shutdown', () => {
  it('waits for writes in progress', async () => {
    const ref = randomRef()
    const client = await connect()
    await submit(client, 'ref', ref)
    // Slow the write down, and take the lock as the shutdown does meanwhile
    const { outputJson } = fsExtra
    let locked
    fsExtra.outputJson = async (...args) => {
      locked = execLock.writeLock().then(async (release) => {
        const written = await fs.access(blobPath('test', ref)).then(
          () => true,
          () => false
        )
        release()
        return written
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      return outputJson(...args)
    }
    try {
      assert.deepEqual(await submit(client, 'set', { data: 'HHHH' }), { success: true, version: 1 })
    } finally {
      fsExtra.outputJson = outputJson
    }
    assert.equal(await locked, true)
  })
})
