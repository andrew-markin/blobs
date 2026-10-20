import 'dotenv/config'

import os from 'os'
import path from 'path'

import { createServer } from './app.js'

const storageDir = process.env.STORAGE || path.join(os.homedir(), '.local/share/blobs/storage')

const { server, execLock } = createServer({ storageDir })

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
