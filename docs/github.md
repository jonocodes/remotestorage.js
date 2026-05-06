# GitHub backend (experimental)

rs.js has experimental support for storing data in a GitHub repository using the
[GitHub Contents API](https://docs.github.com/en/rest/repos/contents). Each read
or write maps to a GitHub API call; each write creates a commit in the repo.

This backend is designed for **client-side only** apps — no server required.
Auth is done with a GitHub Personal Access Token (PAT) passed directly in config.

> **Experimental** — not recommended for production use. See [Known issues](#known-issues).

## Prerequisites

- A GitHub repository to use as storage (public for MVP; private repos planned)
- A GitHub **fine-grained Personal Access Token** scoped to that repo

## 1. Create a storage repo

Create the repository on GitHub before connecting. It must already exist — the
backend does not auto-create it.

## 2. Create a fine-grained Personal Access Token

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Set an expiration
4. Under **Repository access**, choose **Only select repositories** and pick your storage repo
5. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**
6. Generate and copy the token (`github_pat_…`)

Fine-grained tokens are scoped to one repo with one permission — much safer than
a classic token.

## 3. Configure the backend

```js
remoteStorage.setApiKeys({
  github: {
    token:  'github_pat_YOUR_TOKEN',
    owner:  'username-or-org',
    repo:   'rs-storage',
    branch: 'main',          // optional, defaults to 'main'
    root:   'remoteStorage/' // optional, defaults to repo root
  }
});
```

That's it — no OAuth app, no redirect, no server. The backend connects automatically.

## Trying it locally in 5 minutes

Save this as `index.html` and serve it with any static file server:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>remoteStorage GitHub backend demo</title>
  <script src="https://unpkg.com/remotestoragejs@latest/release/remotestorage.js"></script>
</head>
<body>
  <button id="write">Write test file</button>
  <button id="read">Read test file</button>
  <pre id="output"></pre>

  <script>
    const remoteStorage = new RemoteStorage({ logging: true });

    remoteStorage.setApiKeys({
      github: {
        token:  'github_pat_YOUR_TOKEN',
        owner:  'YOUR_USERNAME',
        repo:   'rs-storage',
        branch: 'main',
        root:   'remoteStorage/',
      }
    });

    remoteStorage.access.claim('demo', 'rw');
    remoteStorage.caching.enable('/demo/');

    const client = remoteStorage.scope('/demo/');

    remoteStorage.on('connected', () => console.log('connected'));

    document.getElementById('write').onclick = async () => {
      await client.storeFile('application/json', 'hello.json',
        JSON.stringify({ message: 'Hello from rs.js!', ts: new Date().toISOString() }, null, 2));
      document.getElementById('output').textContent = 'Written!';
    };

    document.getElementById('read').onclick = async () => {
      const file = await client.getFile('hello.json');
      document.getElementById('output').textContent = file?.data ?? '(not found)';
    };
  </script>
</body>
</html>
```

```sh
npx serve .    # or: python3 -m http.server 8000
```

Click **Write test file** — a commit will appear in your repo under
`remoteStorage/demo/hello.json`.

## Storage mapping

| rs.js operation | GitHub API call |
|---|---|
| `get(path)` | `GET /repos/{owner}/{repo}/contents/{root+path}?ref={branch}` |
| `put(path, body)` | `PUT /repos/{owner}/{repo}/contents/{root+path}` (creates a commit) |
| `delete(path)` | `DELETE /repos/{owner}/{repo}/contents/{root+path}` (creates a commit) |
| `get(folder/)` | `GET /repos/{owner}/{repo}/contents/{root+folder}?ref={branch}` |

The file `sha` returned by GitHub is used as the rs.js revision token (ETag).

## Security model

The PAT is the credential. To keep it safe:

- Use a **fine-grained token** scoped to one repo with Contents read/write only
- Set a token **expiration date** and rotate it periodically
- Don't hardcode the token in source code — load it from user input or a secret store

This is the same security posture as any API-key-based storage backend. The token
is stored in `localStorage` under `remotestorage:github`, the same way Dropbox
and Google Drive store their OAuth tokens.

## Known issues

- **Experimental** — API and behavior may change
- **Public repos only** in this release; private repos planned
- **No OAuth flow** — GitHub's token exchange endpoint blocks CORS, making browser-only OAuth impossible without a server proxy; PAT is the practical alternative
- **One commit per write** — not suitable for high-frequency sync
- **No Content-Type round-trip** — content type is inferred on read (JSON detection), not stored as metadata
- **Conflicts are surfaced, not merged** — concurrent writes produce 412 responses; the sync layer handles retry
- **No `getItemURL`** — not implemented

## Troubleshooting

**"Could not fetch GitHub user info"**
The token is invalid or has expired. Generate a new fine-grained PAT.

**403 on write**
The token doesn't have Contents write permission, or the wrong repo is configured.

**409 / 412 conflicts on writes**
Expected when two clients write the same file concurrently. The sync engine retries automatically.

**Files appear in wrong location**
Check your `root` config. A root of `remoteStorage/` means files land at
`remoteStorage/{module}/{path}` inside the repo.
