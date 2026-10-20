# Blobs: Versioned storage with live sync

[![CI](https://github.com/andrew-markin/blobs/actions/workflows/ci.yml/badge.svg)](https://github.com/andrew-markin/blobs/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js->=24-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Real--Time-blue.svg)](https://socket.io/)

Blobs is a lightweight backend service that provides applications with a simple API to store binary data (BLOBs) using **optimistic concurrency control via versioning**. Each BLOB has a version number that increments with every update. Clients can safely update data by specifying the version they are modifying, preventing accidental overwrites — similar to the ETag pattern in web APIs or versioning in MongoDB. All changes are broadcast in real-time to connected clients via [Socket.IO](https://socket.io/). Server-side storage uses plain JSON files for simplicity and transparency.

The server treats the data as opaque base64 strings, so clients can compress and encrypt it before uploading, and nothing but the clients can read it.

**Core Concept:**

- **Version-Based Consistency:** Every BLOB has a monotonic version counter.
- **Safe Updates:** Client provides exact current version to avoid collisions.
- **Real-Time Sync:** All connected clients receive instant notifications on changes via Socket.IO.
- **Transparent Storage:** Data is stored as readable JSON files — no database setup required.

## Protocol

Clients talk to the server with [Socket.IO](https://socket.io/) 4 over WebSocket. Every request is an event with an acknowledgement callback, and requests without one make the server disconnect the client. Failed requests are acknowledged with `{ error: <message> }`.

The behavior described here is fixed by the contract tests in [test/protocol.test.js](test/protocol.test.js), which have to keep passing for existing clients to keep working.

### Connecting

Data is organized into **buckets**, isolated namespaces for different applications or environments. Every client application gets a token for its bucket, a JWT signed with the server `TOKEN_SECRET` (see [Tokens](#tokens)). Connections without a valid token are refused with `Access denied`.

```javascript
import { io } from 'socket.io-client'

const socket = io('wss://blobs.example.com', {
  transports: ['websocket'],
  auth: { token: 'YOUR_BUCKET_TOKEN' }
})

const submit = (event, ...args) => socket.timeout(10000).emitWithAck(event, ...args)
```

### Requests

| Event | Arguments                                                                           | Acknowledgement                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `now` | none                                                                                | `{ timestamp }`: the server time in milliseconds, e.g. to adjust client clocks                                                                       |
| `ref` | `ref`: 64 lowercase hex characters, or `null` to unsubscribe                        | `null`                                                                                                                                               |
| `get` | `{ known }`: the version the client already has, optional                           | `null` when there's no blob, `{ version }` when `known` is the current version, `{ data, version }` otherwise                                        |
| `set` | `{ data, version }`: the base64 data, and the version it's based on unless it's new | `{ success: true, version }` with the new version, or `{ success: false, data, version }` with the current blob when `version` isn't the current one |

- A socket works with a single blob at a time: `ref` selects it for the following `get` and `set` requests and subscribes the socket to its changes. Requests before it fail with `Reference is not provided`.
- The reference is all it takes to find a blob in a bucket, so derive it from a secret known only to the clients (e.g. as an HMAC of it), never from guessable data.
- `set` of a missing blob creates it with version 1, whatever version is given.
- After a successful `set`, the server emits `changed` with no arguments to the other sockets subscribed to the same blob, but not to its author. The notification is sent after the acknowledgement to the author. Clients usually react to it with `get`.
- `data` is limited to 999,000 base64 characters (749,250 bytes decoded), and longer data fails the request. Messages larger than 1,000,000 bytes close the connection without any acknowledgement.

## Configuration

The server is configured with environment variables. In development they can also be set in a `.env` file in the working directory, see [.env.example](.env.example).

| Variable       | Default                        | Description                                                                                                                                      |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TOKEN_SECRET` | required                       | Secret for signing and verifying bucket tokens. The server and the token script refuse to run without it, and changing it invalidates all tokens |
| `PORT`         | `3000`                         | Port of the HTTP server, which is expected to be behind a reverse proxy terminating TLS                                                          |
| `STORAGE`      | `~/.local/share/blobs/storage` | Directory of the blob files                                                                                                                      |

Use a long random secret, e.g. generated with `openssl rand -base64 32`. In production the variables are set in the PM2 ecosystem file, see [Deployment](#deployment).

### Tokens

Generate a token for a bucket where `TOKEN_SECRET` is set:

```bash
npm run token <bucket>
```

The command prints the token, which gives access to the bucket only:

```
Token for bucket: <bucket>
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

As the production secret lives only on the server, generate production tokens in a checkout of this repository passing the secret for the single command:

```bash
TOKEN_SECRET=<secret from ~/blobs/ecosystem.json> npm run token <bucket>
```

## Storage

Every blob is a JSON file `<STORAGE>/<bucket>/<first 2 characters of the reference>/<reference>.json`:

```json
{
  "data": "AAAA...",
  "version": 3,
  "created": 1760000000000,
  "updated": 1760000500000,
  "ip": "203.0.113.7"
}
```

`created` and `updated` are timestamps in milliseconds, the latter appearing since the second version, and `ip` is the address of the last writer taken from the `X-Real-IP` header of the reverse proxy, `unknown` without it.

- Writes go to a temporary `.temp` file first, which then atomically replaces the blob, so interrupted writes never damage it. `.backup` files left by interrupted writes of older versions are restored on reading.
- Blob files which can't be parsed are logged and renamed to `<reference>.json.corrupted-<timestamp>`, and such blobs are treated as missing, so clients can write them again. Investigate and remove these files manually.
- The storage directory is the only state of the server, so back it up regularly. Copying it while the server runs is safe, as blob files are only ever replaced atomically.

## Development

Development requires Node.js 24 or higher:

```bash
npm install
cp .env.example .env   # and set TOKEN_SECRET in it
npm start              # Start the server at http://localhost:3000
npm test               # Run tests
npm run check          # Run the linter and check formatting
```

Then generate a token for a bucket (see [Tokens](#tokens)) and connect a client as described in [Protocol](#protocol).

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

1. Create `~/blobs/ecosystem.json` from [deploy/ecosystem.example.json](deploy/ecosystem.example.json), set the [variables](#configuration) with a new random `TOKEN_SECRET`, never the one from the examples, and make the file private with `chmod 600 ~/blobs/ecosystem.json`.
2. Deploy the first release, then save the PM2 process list and make PM2 start on boot (once per server): `pm2 save` and `pm2 startup`.

PM2 doesn't reread the ecosystem file on restarts, so after changing it:

- for `env` changes run `pm2 startOrReload ecosystem.json --update-env && pm2 save`,
- for other changes, like `script`, run `pm2 delete blobs && pm2 start ecosystem.json && pm2 save`.

Deployments fail with a hint when PM2 runs the app from another path than `~/blobs/current/index.js`.

The server listens to plain HTTP, so it needs a reverse proxy terminating TLS, passing WebSocket connections through and setting the `X-Real-IP` header. For example, with nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

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

## License

Distributed under the GNU General Public License v3.0. See the [LICENSE](./LICENSE) file for more details.
