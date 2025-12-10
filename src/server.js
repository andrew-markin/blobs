import 'dotenv/config'

import AsyncLock from 'async-lock'
import fs from 'fs-extra'
import Joi from 'joi'
import mortice from 'mortice'
import os from 'os'
import path from 'path'
import { Server } from 'socket.io'

import { getBucket } from './auth.js'

const storageDir = process.env.STORAGE || path.join(os.homedir(), '.local/share/blobs/storage')
fs.ensureDirSync(storageDir)

const execLock = mortice('exec-lock', { timeout: 30000 })
const blobLock = new AsyncLock()

const server = new Server({ cors: { origin: true } })

server.use((socket, next) => {
  socket.bucket = getBucket(socket.handshake.auth.token)
  if (!socket.bucket) return next(new Error('Access denied'))
  socket.ip = socket.handshake.headers['x-real-ip']
  next()
})

const subscriptions = new Map()

const refSchema = Joi.string().allow(null).lowercase().hex().length(64)
const dataSchema = Joi.string().base64().max(0x100000) // 1MB
const versionSchema = Joi.number().integer().min(1).optional()

server.on('connection', (socket) => {
  console.log(`Socket ${socket.id} connected`)

  const assertRef = () => {
    if (!socket.ref) throw new Error('Reference is not provided')
  }

  const getKey = () => {
    return `${socket.bucket}:${socket.ref}`
  }

  const subscribe = (ref) => {
    unsubscribe()
    socket.ref = ref
    if (!ref) return
    const key = getKey()
    const sockets = subscriptions.get(key) || []
    sockets.push(socket)
    subscriptions.set(key, sockets)
  }

  const unsubscribe = () => {
    if (!socket.ref) return
    const key = getKey()
    let sockets = subscriptions.get(key) || []
    sockets = sockets.filter((item) => item !== socket)
    if (sockets.length > 0) subscriptions.set(key, sockets)
    else subscriptions.delete(key)
  }

  const emit = (event, ...args) => {
    if (!socket.ref) return
    const key = getKey()
    const sockets = subscriptions.get(key) || []
    for (const sibling of sockets) {
      if (sibling === socket) continue
      sibling.emit(event, ...args)
    }
  }

  const getBlobPath = () => {
    const { bucket, ref } = socket
    return path.join(storageDir, bucket, ref.substring(0, 2), `${ref}.json`)
  }

  const readBlob = async () => {
    const blobPath = getBlobPath()
    const blobBackupPath = `${blobPath}.backup`
    if (await fs.pathExists(blobBackupPath)) {
      // Restore blob from backup if needed
      fs.move(blobBackupPath, blobPath, { overwrite: true })
    }
    // Read blob if it exists
    return (
      ((await fs.pathExists(blobPath)) && (await fs.readJson(blobPath, { throws: false }))) ||
      undefined
    )
  }

  const writeBlob = async (value) => {
    const blobPath = getBlobPath()
    const blobBackupPath = `${blobPath}.backup`
    if (await fs.pathExists(blobPath)) {
      // Backup existing version of the blob
      await fs.move(blobPath, blobBackupPath, { overwrite: true })
    }
    // Write blob and remove backup
    await fs.outputJson(blobPath, value)
    await fs.remove(blobBackupPath)
  }

  socket.on('disconnect', (reason) => {
    unsubscribe()
    console.log(`Socket ${socket.id} disconnected due to ${reason}`)
  })

  socket.on('now', async (ack) => {
    if (typeof ack !== 'function') return socket.disconnect()
    const release = await execLock.readLock()
    try {
      ack({ timestamp: Date.now() })
    } catch (err) {
      return ack({ error: err.message })
    } finally {
      release()
    }
  })

  socket.on('ref', async (ref, ack) => {
    if (typeof ack !== 'function') return socket.disconnect()
    const release = await execLock.readLock()
    try {
      await refSchema.validateAsync(ref)
      subscribe(ref)
      ack()
    } catch (err) {
      return ack({ error: err.message })
    } finally {
      release()
    }
  })

  socket.on('get', async ({ known }, ack) => {
    if (typeof ack !== 'function') return socket.disconnect()
    const release = await execLock.readLock()
    try {
      assertRef()
      await versionSchema.validateAsync(known)
      blobLock.acquire(
        getKey(),
        async (done) => {
          try {
            const blob = await readBlob()
            done(
              null,
              blob && {
                ...(blob.version !== known && { data: blob.data }),
                version: blob.version
              }
            )
          } catch (err) {
            done(err)
          }
        },
        (err, res) => {
          ack(err ? { error: err.message } : res)
        }
      )
    } catch (err) {
      return ack({ error: err.message })
    } finally {
      release()
    }
  })

  socket.on('set', async ({ data, version }, ack) => {
    if (typeof ack !== 'function') return socket.disconnect()
    const release = await execLock.readLock()
    try {
      assertRef()
      await dataSchema.validateAsync(data)
      await versionSchema.validateAsync(version)
      blobLock.acquire(
        getKey(),
        async (done) => {
          try {
            const nextBlob = { data }
            const prevBlob = await readBlob()
            if (prevBlob) {
              if (prevBlob.version !== version) {
                return done(null, {
                  success: false,
                  data: prevBlob.data,
                  version: prevBlob.version
                })
              }
              nextBlob.version = version + 1
              nextBlob.created = prevBlob.created
              nextBlob.updated = Date.now()
            } else {
              nextBlob.version = 1
              nextBlob.created = Date.now()
            }
            nextBlob.ip = socket.ip || 'unknown'
            await writeBlob(nextBlob)
            done(null, {
              success: true,
              version: nextBlob.version
            })
            emit('changed')
          } catch (err) {
            done(err)
          }
        },
        (err, res) => {
          ack(err ? { error: err.message } : res)
        }
      )
    } catch (err) {
      return ack({ error: err.message })
    } finally {
      release()
    }
  })
})

const shutdown = async () => {
  await execLock.writeLock()
  console.log('\nShutting down...')
  server.close(() => {
    console.log('Server terminated')
    process.exit()
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(process.env.PORT || 3000)
