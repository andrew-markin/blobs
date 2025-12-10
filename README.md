# Blobs: Versioned storage with live sync

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js->=24-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Real--Time-blue.svg)](https://socket.io/)

Blobs is a lightweight backend service that provides applications with a simple API to store binary data (BLOBs) using **optimistic concurrency control via versioning**. Each BLOB has a version number that increments with every update. Clients can safely update data by specifying the version they are modifying, preventing accidental overwrites — similar to the ETag pattern in web APIs or versioning in MongoDB. All changes are broadcast in real-time to connected clients via [Socket.IO](https://socket.io/). Server-side storage uses plain JSON files for simplicity and transparency.

**Core Concept:**

- **Version-Based Consistency:** Every BLOB has a monotonic version counter.
- **Safe Updates:** Client provides exact current version to avoid collisions.
- **Real-Time Sync:** All connected clients receive instant notifications on changes via Socket.IO.
- **Transparent Storage:** Data is stored as readable JSON files — no database setup required.

## Setup

### Prerequisites

- Node.js (version 24 or higher)
- npm or yarn

### 1. Configure Environment

Blobs requires a `TOKEN_SECRET` environment variable for signing and verifying API authorization tokens. The easiest way is to create a `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` and set your secure secret:

```env
TOKEN_SECRET=your_secure_random_secret_here
```

**⚠️ Security Note:** Use a strong, randomly generated string. In production, consider using a secure secret management system.

### 2. Generate an Access Token

Blobs organizes data into **buckets** (isolated namespaces for different applications or environments). To access a bucket, you need a dedicated token.

Generate a token for your bucket:

```bash
npm run token your-bucket-name
# or
yarn token your-bucket-name
```

The command will output a JWT token like:

```
Token for bucket: your-bucket-name
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Use the Token in Your Application

Copy this token and include it in your client application's requests as an auth header:

```javascript
// Example in JavaScript
const socket = io('https://your-blobs-server', {
  transports: ['websocket'],
  auth: { token: 'YOUR_GENERATED_TOKEN_HERE' }
})
```

**Note:** Each token is scoped to a specific bucket and cannot access data from other buckets.

### Quick Start Summary

1. Set `TOKEN_SECRET` in `.env`
2. Generate a bucket-specific token with `npm run token <bucket-name>`
3. Use the token in your client's auth header
4. Start the server with `npm start`

## License

Distributed under the GNU General Public License v3.0. See the [LICENSE](./LICENSE) file for more details.
