# GitHub Backend — OAuth / CORS Research Notes

Last updated: 2026-05-05

## Summary

Browser-only OAuth with GitHub is not reliably possible today. This document
records what was tried, what was found, and what to watch for when the situation
changes.

---

## The problem

The GitHub Contents API (used for all reads and writes) accepts a Bearer token
without any CORS issues. The blocker is **obtaining** that token from a browser.

GitHub's token exchange endpoint:

```
POST https://github.com/login/oauth/access_token
```

does not return `Access-Control-Allow-Origin` headers for browser-based
requests, so any `fetch()` or `XMLHttpRequest` to it from a web page fails with
a CORS NetworkError before the response body is ever read.

This affects the Authorization Code + PKCE flow, which is otherwise the correct
approach for public (secret-less) browser clients per RFC 7636.

---

## What was tried

### OAuth Apps + PKCE

GitHub OAuth Apps are the older, simpler app type. PKCE support was added in
July 2025 (GitHub Changelog). However:

- The token endpoint does **not** support CORS for OAuth Apps — this is
  confirmed as a permanent limitation, not a bug.
- GitHub has no plans to add CORS to the OAuth Apps token endpoint.
- The implicit grant flow (which avoids the token exchange) is not supported by
  GitHub at all.

**Result: does not work browser-only.**

### GitHub Apps + PKCE (SPA Preview)

GitHub Apps are a newer, more capable app type. In August 2025 GitHub shipped
a Preview feature ("Single page app support for GitHub Apps", roadmap #1153)
that is designed to solve exactly this problem:

- CORS is enabled on `/access_token` when the redirect URI is "marked as a SPA
  client"
- No client secret required (public client)
- Token expiration required
- Refresh tokens supported (valid ~24 hours)
- Follows the IETF Browser-Based Apps draft RFC

**What we found in practice (May 2026):**

- The GitHub Docs registration page has **no UI option** to mark a callback URL
  as "SPA client" type
- The token endpoint still returns a CORS NetworkError when exchanged from a
  browser, even using a GitHub App with PKCE and no client secret
- The mechanism to "mark a redirect URI as SPA client" is not documented and
  not accessible via the GitHub App settings UI
- The feature appears to still be in limited Preview and not generally available

**Result: does not work browser-only yet, despite being on the roadmap.**

---

## Current working approach

### Personal Access Token (PAT)

A fine-grained PAT scoped to a single repository with Contents read/write
permission bypasses the token exchange entirely. The token is passed directly
in the `setApiKeys` config:

```js
remoteStorage.setApiKeys({
  github: {
    token:  'github_pat_...',
    owner:  'username',
    repo:   'rs-storage',
  }
});
```

Security properties:
- Scoped to one repo only (fine-grained PAT)
- Contents read/write permission only
- Can be set to expire
- Stored in `localStorage` under `remotestorage:github`, same as how Dropbox
  and Google Drive store their OAuth tokens

This is the only reliably working browser-only auth method as of May 2026.

---

## What to watch for

The GitHub App SPA Preview feature will become usable when **any of** the
following happen:

1. The GitHub App settings UI shows a way to designate a callback URL as
   "SPA client" type
2. GitHub publishes documentation for the SPA token exchange flow with a
   working example
3. The `POST https://github.com/login/oauth/access_token` endpoint starts
   returning `Access-Control-Allow-Origin` headers for GitHub App requests
   using PKCE without a client secret

When that happens, the PKCE code already in `src/github.ts` (`connect()`,
`configure()`) should work as-is — it already:

- Generates a code verifier and S256 challenge via `generateCodeVerifier()`
- Stores the verifier under `remotestorage:codeVerifier` (the key the
  `Authorize` module reads)
- Does not send a `client_secret` in the token exchange
- Sends `Accept: application/json` so GitHub returns JSON instead of
  URL-encoded form data

The only change needed will be in setup documentation (how to create the GitHub
App and enable SPA mode).

---

## References

- [PKCE support for OAuth and GitHub App authentication — GitHub Changelog (Jul 2025)](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
- [Single page app support for GitHub Apps \[Preview\] — github/roadmap #1153](https://github.com/github/roadmap/issues/1153)
- [Feedback: Authenticating with a SPA without a relay — community Discussion #40077](https://github.com/orgs/community/discussions/40077)
- [OAuth web flow endpoints don't support CORS — isaacs/github Issue #330](https://github.com/isaacs/github/issues/330)
- [Authorizing OAuth apps — GitHub Docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Generating a user access token for a GitHub App — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
