import AsyncLock from 'async-lock'
import { statfs } from 'fs/promises'
import fs from 'fs-extra'
import Joi from 'joi'
import mortice from 'mortice'
import path from 'path'
import { Server } from 'socket.io'

import { getBucket } from './auth.js'

const isObject = (value) => typeof value === 'object' && value !== null

// Socket.IO closes the connection on messages larger than this, so the data
// limit leaves room for the rest of the request to fail it with an error
const MAX_MESSAGE_SIZE = 1e6
const MAX_DATA_LENGTH = MAX_MESSAGE_SIZE - 1000

// Requests of a socket are limited with a token bucket, which allows bursts
// of RATE_BURST requests and RATE_PER_SECOND requests on average
const RATE_BURST = 20
const RATE_PER_SECOND = 5

export function createServer({ storageDir, minFreeSpace = 0 }) {
  fs.ensureDirSync(storageDir)

  const execLock = mortice('exec-lock', { timeout: 30000 })
  const blobLock = new AsyncLock()

  const server = new Server({ cors: { origin: true }, maxHttpBufferSize: MAX_MESSAGE_SIZE })

  server.use((socket, next) => {
    socket.bucket = getBucket(socket.handshake.auth.token)
    if (!socket.bucket) return next(new Error('Access denied'))
    socket.ip = socket.handshake.headers['x-real-ip']
    next()
  })

  const subscriptions = new Map()

  const refSchema = Joi.string().allow(null).lowercase().hex().length(64)
  const dataSchema = Joi.string().base64().max(MAX_DATA_LENGTH)
  const versionSchema = Joi.number().integer().min(1).optional()
  const blobSchema = Joi.object({
    data: Joi.string().required(),
    version: Joi.number().integer().min(1).required()
  }).unknown(true)

  server.on('connection', (socket) => {
    console.log(`Socket ${socket.id} connected`)

    let tokens = RATE_BURST
    let refilled = Date.now()

    socket.use((packet, next) => {
      const now = Date.now()
      tokens = Math.min(RATE_BURST, tokens + ((now - refilled) / 1000) * RATE_PER_SECOND)
      refilled = now
      if (tokens >= 1) {
        tokens -= 1
        return next()
      }
      const ack = packet[packet.length - 1]
      if (typeof ack !== 'function') return socket.disconnect()
      ack({ error: 'Too many requests' })
    })

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
        // Restore blob from backup left by an interrupted write of older versions
        await fs.rename(blobBackupPath, blobPath)
      }
      if (!(await fs.pathExists(blobPath))) return
      // Other read errors (e.g. permissions) are passed on to the client
      const content = await fs.readFile(blobPath, 'utf8')
      let blob, problem
      try {
        blob = JSON.parse(content)
        problem = blobSchema.validate(blob).error?.message
      } catch (err) {
        problem = err.message
      }
      if (!problem) return blob
      // Keep the corrupted blob for investigation and treat it as missing
      const corruptedPath = `${blobPath}.corrupted-${Date.now()}`
      console.error(`Blob ${blobPath} is corrupted (${problem}), moved to ${corruptedPath}`)
      await fs.rename(blobPath, corruptedPath)
    }

    const writeBlob = async (value) => {
      const blobPath = getBlobPath()
      const blobTempPath = `${blobPath}.temp`
      // Write to a temporary file first and then atomically replace the blob
      // with it (rename within a directory), so that an interrupted write
      // never damages the blob
      await fs.outputJson(blobTempPath, value)
      await fs.rename(blobTempPath, blobPath)
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

    socket.on('get', async (params, ack) => {
      if (typeof ack !== 'function') return socket.disconnect()
      if (!isObject(params)) return ack({ error: 'Invalid request' })
      const { known } = params
      const release = await execLock.readLock()
      try {
        assertRef()
        await versionSchema.validateAsync(known)
        const blob = await blobLock.acquire(getKey(), readBlob)
        ack(
          blob && {
            ...(blob.version !== known && { data: blob.data }),
            version: blob.version
          }
        )
      } catch (err) {
        return ack({ error: err.message })
      } finally {
        release()
      }
    })

    socket.on('set', async (params, ack) => {
      if (typeof ack !== 'function') return socket.disconnect()
      if (!isObject(params)) return ack({ error: 'Invalid request' })
      const { data, version } = params
      const release = await execLock.readLock()
      try {
        assertRef()
        await dataSchema.validateAsync(data)
        await versionSchema.validateAsync(version)
        // Keep the storage readable and the rest of the server working when
        // the disk is filling up
        const { bavail, bsize } = await statfs(storageDir)
        if (bavail * bsize < minFreeSpace) throw new Error('Storage is full')
        const res = await blobLock.acquire(getKey(), async () => {
          const nextBlob = { data }
          const prevBlob = await readBlob()
          if (prevBlob) {
            if (prevBlob.version !== version) {
              return { success: false, data: prevBlob.data, version: prevBlob.version }
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
          return { success: true, version: nextBlob.version }
        })
        ack(res)
        if (res.success) emit('changed')
      } catch (err) {
        return ack({ error: err.message })
      } finally {
        release()
      }
    })
  })

  return { server, execLock }
}
