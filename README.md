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

## Development

```bash
npm test        # Run tests
npm run check   # Run the linter and check formatting
```

## Deployment

Every deployment uploads a self-contained build to `~/blobs/releases/<date>-<time>-<commit>` on the server, switches the `~/blobs/current` link to it atomically and restarts the app with PM2. If the restarted app doesn't respond, the release which was active before is restored. The 5 latest releases are kept, as well as the current and the previous ones.

The app configuration, including secrets, lives only on the server in `~/blobs/ecosystem.json` and is never uploaded.

### Releasing

Pushing a version tag runs the tests and deploys the release from GitHub Actions:

```bash
npm version patch   # or minor, major: commits the version and tags it
git push --follow-tags
```

The same can be done manually with `npm run deploy` (requires a clean working tree and SSH access to the server). `npm run rollback` switches back to the release which was active before the current one.

### Server Setup

The server needs Node.js 24 installed with nvm, PM2 installed globally for it, and rsync.

1. Create `~/blobs/ecosystem.json` from [deploy/ecosystem.example.json](deploy/ecosystem.example.json), set `TOKEN_SECRET`, `PORT` and `STORAGE`, and make it private with `chmod 600 ~/blobs/ecosystem.json`.
2. Deploy the first release, then save the PM2 process list and make PM2 start on boot (once per server): `pm2 save` and `pm2 startup`.

PM2 doesn't reread the ecosystem file on restarts, so after changing it:

- for `env` changes run `pm2 startOrReload ecosystem.json --update-env && pm2 save`,
- for other changes, like `script`, run `pm2 delete blobs && pm2 start ecosystem.json && pm2 save`.

Deployments fail with a hint when PM2 runs the app from another path than `~/blobs/current/index.js`.

### GitHub Actions Secrets

Deployments from GitHub Actions need an SSH key dedicated to them and the server host key:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-blobs" -f blobs-deploy
```

1. Append `blobs-deploy.pub` to `~/.ssh/authorized_keys` of the deployment user on the server.
2. Set the repository secrets (Settings → Secrets and variables → Actions), e.g. with the GitHub CLI:
   - `DEPLOY_SSH_KEY`: the private key, `gh secret set DEPLOY_SSH_KEY < blobs-deploy`
   - `DEPLOY_KNOWN_HOSTS`: the server host key from your own `known_hosts`, `ssh-keygen -F blobs.mayfleet.com | grep -v '^#' | gh secret set DEPLOY_KNOWN_HOSTS`
3. Delete the local `blobs-deploy` files.

### Tokens

As the secret lives only on the server, generate tokens in a checkout of this repository passing the secret for the single command:

```bash
TOKEN_SECRET=<secret from ~/blobs/ecosystem.json> npm run token <bucket>
```

### Migration from the Previous Deployment

Previously the build and its `.env` were uploaded directly to `~/blobs`, and PM2 ran `~/blobs/index.js`.

1. On the server, replace `~/blobs/ecosystem.json` with the new one (see Server Setup) moving `TOKEN_SECRET`, `PORT` and `STORAGE` from `~/blobs/.env`. If `STORAGE` isn't set there, leave the default path from the example or remove it, otherwise the existing blobs won't be found.
2. Deploy the first release. It's expected to fail with the hint to recreate the app, while the old app keeps working.
3. Recreate the app as hinted, which starts it from the new release in seconds, and make sure it works: `pm2 delete blobs && pm2 start ecosystem.json && pm2 save`.
4. Remove the files of the previous deployment from `~/blobs`, keeping `releases`, `current`, `previous` and `ecosystem.json`.

## License

Distributed under the GNU General Public License v3.0. See the [LICENSE](./LICENSE) file for more details.
