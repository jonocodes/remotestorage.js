# GitHub backend (experimental)

rs.js has experimental support for storing data in a GitHub repository using the
[GitHub Contents API](https://docs.github.com/en/rest/repos/contents). Each read
or write maps to a GitHub API call; each write creates a commit in the repo.

This backend is designed for **client-side only** apps — no server required.

> **Experimental** — not recommended for production use. See [Known issues](#known-issues).

## Prerequisites

- A GitHub repository to use as storage (public for MVP; private repos planned)
- Auth credentials — see [Authentication](#authentication) below

## Authentication

Two modes are supported:

---

### Mode 1: GitHub App + PKCE (full OAuth, browser-only, recommended)

GitHub Apps with [SPA support (Preview, Aug 2025 — roadmap #1153)](https://github.com/github/roadmap/issues/1153)
enable a complete browser-only OAuth flow with PKCE — no server, no client secret, no
proxy needed. CORS is enabled on the token endpoint for SPA clients, and token
expiration + refresh are handled automatically.

> **Preview status:** as of May 2026 the SPA CORS feature is not yet generally accessible — the
> GitHub App registration UI has no option to mark a callback URL as a SPA client. If you hit a
> CORS NetworkError on token exchange, fall back to Mode 2. See
> [docs/github-oauth-status.md](github-oauth-status.md) for the full research history.

**Setup — create a GitHub App:**

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
2. Fill in **GitHub App name** and **Homepage URL**
3. Set **Callback URL** to your app's URL (e.g. `http://localhost:8000`)
4. Uncheck **Active** under Webhook (not needed)
5. Under **Repository permissions**, set **Contents → Read and write**
6. Under **User authorization tokens**, ensure **Expire user authorization tokens** is **checked** — required for SPA mode
7. Click **Create GitHub App**
8. Copy the **Client ID** shown on the app's settings page (do **not** generate a client secret)

> **"You must generate a private key"** — ignore this prompt. Private keys are for server-to-server
> (installation) auth, which we don't use. The OAuth user authorization flow only needs the Client ID.

**Configure:**

```js
remoteStorage.setApiKeys({
  github: {
    clientId: 'Iv1.your_github_app_client_id',
    owner:    'username-or-org',
    repo:     'rs-storage',
    branch:   'main',          // optional, defaults to 'main'
    root:     'remoteStorage/' // optional, defaults to repo root
  }
});
```

The connect widget will show a GitHub option. Clicking it starts the PKCE
redirect flow. On return, the code is exchanged for a token directly in the
browser — no server involved.


---

### Mode 2: Personal Access Token (simpler, no redirect)

A fine-grained PAT scoped to one repo requires no app registration and no
redirect flow — it connects immediately on load. Good for personal tools,
scripts, and testing.

**Setup:**

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**, set an expiration
3. Under **Repository access**, select your storage repo only
4. Under **Permissions → Contents**, set **Read and write**
5. Generate and copy the token (`github_pat_…`)

**Configure:**

```js
remoteStorage.setApiKeys({
  github: {
    token:  'github_pat_...',
    owner:  'username-or-org',
    repo:   'rs-storage',
    branch: 'main',          // optional
    root:   'remoteStorage/' // optional
  }
});
```

No redirect, no widget interaction needed — connects automatically on load.

---

## Trying it locally in 5 minutes

Save this as `index.html`, fill in your credentials, and serve with any static file server:

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

    // Mode 2: PAT — replace with your values
    remoteStorage.setApiKeys({
      github: {
        token:  'github_pat_...',
        owner:  'your-username',
        repo:   'rs-storage',
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

## Storage mapping

| rs.js operation | GitHub API call |
|---|---|
| `get(path)` | `GET /repos/{owner}/{repo}/contents/{root+path}?ref={branch}` |
| `put(path, body)` | `PUT /repos/{owner}/{repo}/contents/{root+path}` (creates a commit) |
| `delete(path)` | `DELETE /repos/{owner}/{repo}/contents/{root+path}` (creates a commit) |
| `get(folder/)` | `GET /repos/{owner}/{repo}/contents/{root+folder}?ref={branch}` |

The file `sha` returned by GitHub is used as the rs.js revision token (ETag).

## Security model

**GitHub App + PKCE:** tokens are short-lived (8 hours), scoped to what the
user authorized, and automatically refreshed. No credential is stored in source
code — only a transient token in `localStorage`.

**PAT mode:** use a fine-grained token scoped to one repo with Contents
read/write only, and set an expiration date. The token is stored in
`localStorage` under `remotestorage:github`, the same way Dropbox and Google
Drive store their OAuth tokens.

## Known issues

- **Experimental** — API and behavior may change
- **Public repos only** in this release; private repos planned
- **GitHub App SPA support is in Preview** ([roadmap #1153](https://github.com/github/roadmap/issues/1153), [community discussion #40077](https://github.com/orgs/community/discussions/40077)) — if CORS on the token exchange fails, fall back to PAT mode. See [docs/github-oauth-status.md](github-oauth-status.md)
- **One commit per write** — not suitable for high-frequency sync
- **No Content-Type round-trip** — content type is inferred on read (JSON detection), not stored as metadata
- **Conflicts are surfaced, not merged** — concurrent writes produce 412 responses; the sync layer handles retry
- **No `getItemURL`** — not implemented

## Troubleshooting

**CORS error on token exchange**
If using an OAuth App: these permanently block CORS on the token endpoint — switch to a GitHub App
([isaacs/github #330](https://github.com/isaacs/github/issues/330)). If already using a GitHub App:
the SPA Preview CORS feature ([roadmap #1153](https://github.com/github/roadmap/issues/1153)) is not
yet generally available. Use PAT mode as a fallback. See [docs/github-oauth-status.md](github-oauth-status.md)
for the full picture.

**"Could not fetch GitHub user info"**
The token is invalid or has expired. Generate a new PAT, or re-authorize via
the widget.

**403 on write**
The token doesn't have Contents write permission for the configured repo.

**409 / 412 conflicts on writes**
Expected when two clients write the same file concurrently. The sync engine
retries automatically.

**Files appear in wrong location**
Check your `root` config. A root of `remoteStorage/` means files land at
`remoteStorage/{module}/{path}` inside the repo.
