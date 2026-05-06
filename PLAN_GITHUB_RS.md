
# remoteStorage.js GitHub Backend MVP Plan

## Goal

Add an experimental GitHub backend to remoteStorage.js that works fully client-side in the browser, similar to the existing Dropbox/Google Drive backends.

Primary MVP: OAuth App + PKCE, existing public repo only, GitHub Contents API, no auto-merge, configurable root path, mocked API tests.

GitHub supports OAuth authorization code flow with PKCE, and GitHub’s Contents API supports reading directories/files and creating/updating/deleting Base64-encoded repo contents. Use file `sha` as the revision token. :contentReference[oaicite:0]{index=0}

## Decisions Made

- Backend name: `github`
- Auth: GitHub OAuth App using Authorization Code + PKCE
- Fallback auth: not in MVP
- Repo model: existing repo only
- Repo visibility: public repo MVP
- Storage API: GitHub Repository Contents API
- Conflict policy: no auto-merge; surface conflicts to rs.js sync layer
- Path model: configurable root prefix
- Token storage: reuse existing rs.js backend/session patterns
- Tests: mocked GitHub API responses, not live OAuth tests

## Proposed config

```js
remoteStorage.setApiKeys({
  github: {
    clientId: 'GITHUB_OAUTH_CLIENT_ID',
    owner: 'username-or-org',
    repo: 'rs-storage',
    branch: 'main',
    root: 'remoteStorage/'
  }
});
````

## Storage mapping

```text
GET path
  -> GET /repos/{owner}/{repo}/contents/{root + path}?ref={branch}

LIST folder
  -> GET /repos/{owner}/{repo}/contents/{root + folder}?ref={branch}

PUT path
  -> PUT /repos/{owner}/{repo}/contents/{root + path}
     {
       message,
       content: base64(body),
       branch,
       sha?: previousSha
     }

DELETE path
  -> DELETE /repos/{owner}/{repo}/contents/{root + path}
     {
       message,
       branch,
       sha
     }
```

GitHub Contents API uses Base64 file content and requires `sha` when updating or deleting an existing file. Concurrent create/update/delete calls should be serialized because these endpoints can conflict when run in parallel. ([GitHub Docs][1])

## Implementation steps

### 1. Add backend skeleton

Create a GitHub backend module next to the Dropbox/Google Drive backends.

Expected shape, adapted to existing rs.js conventions:

```js
class GitHubBackend {
  constructor(remoteStorage, config) {}

  configure(config) {}

  connect() {}

  disconnect() {}

  get(path) {}

  put(path, body, contentType, incomingRev) {}

  delete(path, incomingRev) {}

  getAll(path) {}
}
```

Register it as `github` wherever rs.js registers external backends.

### 2. Implement PKCE auth

Add helpers:

```js
generateCodeVerifier()
generateCodeChallenge(verifier)
buildAuthorizeUrl()
handleRedirectCallback()
exchangeCodeForToken()
```

Flow:

```text
1. Generate code_verifier.
2. Store verifier and state temporarily.
3. Redirect to GitHub authorize URL with:
   - client_id
   - redirect_uri
   - scope
   - state
   - code_challenge
   - code_challenge_method=S256
4. On callback, validate state.
5. Exchange code + code_verifier for access token.
6. Store token using existing rs.js session/token pattern.
```

Do not use implicit flow; GitHub docs say implicit grant is not supported. ([GitHub Docs][2])

### 3. Implement GitHub API client

Create a small internal wrapper:

```js
githubRequest(method, path, body)
getContent(path)
putContent(path, body, contentType, sha)
deleteContent(path, sha)
listContent(path)
```

Headers:

```text
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

Handle these responses:

```text
200/201 -> success
404     -> missing item
409     -> conflict
401/403 -> auth or permission error
422     -> invalid request, probably stale sha or path issue
```

### 4. Revision handling

Use GitHub file `sha` as rs.js revision.

For `put`:

```text
If incomingRev exists:
  send it as sha.
If incomingRev missing:
  attempt create.
If GitHub says file exists:
  fetch current sha and surface conflict, do not overwrite silently.
```

For `delete`:

```text
Require current sha.
If missing, fetch first.
If stale, surface conflict.
```

### 5. Listing behavior

For folder listing:

```text
GET contents directory
Convert array response to rs.js folder listing format.
For each item:
  name
  type: file/directory
  sha/revision
  size where available
```

Ensure path normalization:

```text
No duplicate slashes
Root prefix always prepended
Folder paths normalized with trailing slash only where rs.js expects it
```

### 6. Serialization

Add a write queue for GitHub backend:

```js
this._writeQueue = Promise.resolve();

enqueueWrite(fn) {
  this._writeQueue = this._writeQueue.then(fn, fn);
  return this._writeQueue;
}
```

Apply to `put` and `delete`.

### 7. Tests

Mock API tests for:

* PKCE verifier/challenge generation
* authorize URL generation
* callback state validation
* get existing file
* get missing file
* list folder
* create file
* update file with sha
* delete file with sha
* stale sha conflict
* 401/403 auth failure
* path normalization
* serialized writes

### 8. Example app/docs

Add docs with:

```js
remoteStorage.setApiKeys({
  github: {
    clientId: '...',
    owner: '...',
    repo: '...',
    branch: 'main',
    root: 'remoteStorage/my-app/'
  }
});
```

Document limitations clearly:

* Experimental backend
* Public repo MVP
* Not equivalent to RemoteStorage protocol
* Coarser permissions than ideal
* Commit-per-write behavior
* Not good for high-frequency sync
* Conflicts are surfaced, not merged

## Post-MVP Backlog

### Auth / permissions

* Support private repos.
* Explore GitHub App auth for finer repository permissions.
* Add Device Flow fallback.
* Add optional token broker for environments where pure SPA auth is insufficient.

### Repo UX

* Auto-create `rs-storage` repo.
* Let users pick repo/branch/root from UI.
* Validate repo access before connecting.
* Detect missing branch/root and offer setup guidance.

### Performance

* Batch writes using Git Data API trees/commits.
* Cache directory listings.
* Reduce redundant sha fetches.
* Add rate-limit awareness and backoff.

### Conflict handling

* Optional JSON merge strategy.
* Text merge helpers.
* Better user-facing conflict metadata.
* Preserve both versions under conflict paths if needed.

### Data model

* Support binary files explicitly.
* Consider chunking or blocking large files.
* Add metadata sidecar option for content type, timestamps, and rs.js-specific metadata.

### Security

* Narrow scopes where possible.
* Clear warning for broad private repo scopes.
* Token expiry/revocation handling.
* Better session cleanup on disconnect.

## MVP acceptance criteria

* Browser-only connection to GitHub OAuth App via PKCE.
* Can read, write, delete, and list files under configured repo root.
* Uses GitHub `sha` as revision token.
* Stale writes produce conflicts, not silent overwrites.
* Writes/deletes are serialized.
* Mock test suite covers success and failure cases.
* Docs include setup, config, limitations, and troubleshooting.

```
::contentReference[oaicite:3]{index=3}
```

[1]: https://docs.github.com/en/rest/repos/contents?utm_source=chatgpt.com "REST API endpoints for repository contents - GitHub Docs"
[2]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps?utm_source=chatgpt.com "Authorizing OAuth apps - GitHub Docs"
