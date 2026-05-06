import EventHandling from './eventhandling';
import {
  applyMixins,
  isFolder,
  localStorageAvailable,
  getJSONFromLocalStorage,
  generateCodeVerifier,
} from './util';
import { requestWithTimeout } from './requests';
import { Remote, RemoteBase, RemoteResponse, RemoteSettings } from './remote';
import RemoteStorage from './remotestorage';
import UnauthorizedError from './unauthorized-error';

/**
 * EXPERIMENTAL - NOT RECOMMENDED FOR PRODUCTION USE
 *
 * GitHub backend for RemoteStorage.js
 *
 * Uses the GitHub Contents API to store files in a repository.
 * Each write becomes a commit. Not suitable for high-frequency sync.
 *
 * Two auth modes:
 *
 * 1. GitHub App + PKCE (recommended, browser-only OAuth):
 *    Register a GitHub App at github.com/settings/apps with token expiration
 *    enabled. Uses PKCE — no client secret required, no server needed.
 *    Requires GitHub App SPA support (Preview, Aug 2025+).
 *
 * @example
 * remoteStorage.setApiKeys({
 *   github: {
 *     clientId: 'your-github-app-client-id',
 *     owner: 'username-or-org',
 *     repo: 'rs-storage',
 *     branch: 'main',
 *     root: 'remoteStorage/'
 *   }
 * });
 *
 * 2. Personal Access Token (simpler, no redirect):
 *
 * @example
 * remoteStorage.setApiKeys({
 *   github: {
 *     token: 'github_pat_...',
 *     owner: 'username-or-org',
 *     repo: 'rs-storage',
 *   }
 * });
 */

let hasLocalStorage: boolean;

const AUTH_URL    = 'https://github.com/login/oauth/authorize';
const TOKEN_URL   = 'https://github.com/login/oauth/access_token';
const API_BASE    = 'https://api.github.com';
const OAUTH_SCOPE = 'public_repo';
const SETTINGS_KEY = 'remotestorage:github';

interface GitHubConfig {
  owner: string;
  repo: string;
  clientId?: string;  // only needed for OAuth PKCE flow
  token?: string;     // set directly to skip OAuth (PAT flow)
  branch?: string;
  root?: string;
}

class GitHub extends RemoteBase implements Remote {
  clientId: string;
  TOKEN_URL: string;
  token: string;
  userAddress: string;

  owner: string;
  repo: string;
  branch: string;
  root: string;

  // Write serialization queue — GitHub Contents API conflicts on parallel writes
  private _writeQueue: Promise<any>;

  // TODO remove when refactoring eventhandling
  _emit: any;

  constructor(rs: RemoteStorage) {
    super(rs);
    this.online = true;
    this.storageApi = 'draft-dejong-remotestorage-19';
    this.addEvents(['connected', 'not-connected']);
    this.TOKEN_URL = TOKEN_URL;
    this._writeQueue = Promise.resolve();

    const cfg: GitHubConfig = rs.apiKeys['github'] as GitHubConfig;
    this.clientId = cfg.clientId;
    this.owner    = cfg.owner;
    this.repo     = cfg.repo;
    this.branch   = cfg.branch || 'main';
    this.root     = (cfg.root || '').replace(/\/$/, '');  // strip trailing slash

    hasLocalStorage = localStorageAvailable();
    if (hasLocalStorage) {
      const saved = getJSONFromLocalStorage(SETTINGS_KEY);
      if (saved) {
        this.configure(saved);
      }
    }

    // If a token was supplied directly in the config, use it immediately
    if (!this.token && cfg.token) {
      this.configure({ token: cfg.token });
    }

    if (this.connected) {
      setTimeout(this._emit.bind(this), 0, 'connected');
    }
  }

  // ------------------------------------------------------------------ connect

  async connect(): Promise<void> {
    try {
      this.rs.setBackend('github');
      if (this.token) {
        hookRemote(this.rs);
      } else {
        const { codeVerifier, codeChallenge, state } = await generateCodeVerifier();
        sessionStorage.setItem('remotestorage:codeVerifier', codeVerifier);
        sessionStorage.setItem('remotestorage:state', state);
        this.rs.authorize({
          authURL: AUTH_URL,
          scope: OAUTH_SCOPE,
          clientId: this.clientId,
          response_type: 'code',
          state: state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });
      }
    } catch (err) {
      this.rs._emit('error', err);
      this.rs.setBackend(undefined);
      throw err;
    }
  }

  // ---------------------------------------------------------------- configure

  async configure(settings: RemoteSettings): Promise<void> {
    if (typeof settings.userAddress !== 'undefined') { this.userAddress = settings.userAddress; }
    if (typeof settings.token !== 'undefined')       { this.token = settings.token as string; }

    const writeCache = () => {
      if (hasLocalStorage) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          userAddress: this.userAddress,
          token: this.token,
        }));
      }
    };

    const handleError = () => {
      this.connected = false;
      if (hasLocalStorage) { localStorage.removeItem(SETTINGS_KEY); }
      this.rs.setBackend(undefined);
    };

    if (this.token) {
      this.connected = true;
      if (this.userAddress) {
        this._emit('connected');
        writeCache();
      } else {
        try {
          const login = await this._fetchUserLogin();
          this.userAddress = login;
          this._emit('connected');
          writeCache();
        } catch {
          this.connected = false;
          this.rs._emit('error', new Error('Could not fetch GitHub user info.'));
          writeCache();
        }
      }
    } else {
      handleError();
    }
  }

  stopWaitingForToken(): void {
    if (!this.connected) { this._emit('not-connected'); }
  }

  // --------------------------------------------------------------- public API

  get(path: string, options: { ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject('not connected (path: ' + path + ')');
    }
    if (isFolder(path)) {
      return this._listFolder(path);
    }
    return this._getFile(path, options);
  }

  put(path: string, body: XMLHttpRequestBodyInit, contentType: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject('not connected (path: ' + path + ')');
    }
    return this._enqueueWrite(() => this._putFile(path, body, contentType, options));
  }

  async 'delete'(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject('not connected (path: ' + path + ')');
    }
    return this._enqueueWrite(() => this._deleteFile(path, options));
  }

  // ------------------------------------------------------------- internal API

  private _enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    // Flatten errors so the queue doesn't get stuck
    this._writeQueue = this._writeQueue.then(fn, fn) as Promise<T>;
    return this._writeQueue as Promise<T>;
  }

  private _githubPath(path: string): string {
    const p = (this.root ? this.root + '/' : '') + path.replace(/^\//, '');
    return p.replace(/\/+/g, '/').replace(/\/$/, '');
  }

  private _contentsUrl(path: string): string {
    return `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${this._githubPath(path)}`;
  }

  private async _githubRequest(method: string, url: string, body?: object): Promise<any> {
    if (!this.token) { throw new UnauthorizedError('No access token'); }

    const options: { headers: Record<string, string>; body?: string } = {
      headers: {
        'Authorization': 'Bearer ' + this.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json; charset=UTF-8';
    }

    this.rs._emit('wire-busy', { method, isFolder: isFolder(url) });

    try {
      const xhr = await requestWithTimeout(method, url, options);
      if (!this.online) {
        this.online = true;
        this.rs._emit('network-online');
      }
      this.rs._emit('wire-done', { method, isFolder: isFolder(url), success: true });

      if (xhr.status === 401 || xhr.status === 403) {
        this.rs._emit('error', new UnauthorizedError());
      }

      return xhr;
    } catch (err) {
      if (this.online) {
        this.online = false;
        this.rs._emit('network-offline');
      }
      this.rs._emit('wire-done', { method, isFolder: isFolder(url), success: false });
      throw err;
    }
  }

  private async _fetchUserLogin(): Promise<string> {
    const xhr = await this._githubRequest('GET', `${API_BASE}/user`);
    if (xhr.status !== 200) { throw new Error('GitHub /user returned ' + xhr.status); }
    const data = JSON.parse(xhr.responseText);
    return data.login;
  }

  private async _getFile(path: string, options: { ifNoneMatch?: string }): Promise<RemoteResponse> {
    const url = this._contentsUrl(path) + '?ref=' + encodeURIComponent(this.branch);
    const xhr = await this._githubRequest('GET', url);

    if (xhr.status === 404) { return { statusCode: 404 }; }
    if (xhr.status !== 200) { return { statusCode: xhr.status }; }

    let data;
    try { data = JSON.parse(xhr.responseText); } catch {
      return { statusCode: 500 };
    }

    const sha = data.sha as string;

    if (options.ifNoneMatch && options.ifNoneMatch === sha) {
      return { statusCode: 304 };
    }

    // GitHub returns Base64-encoded content with possible newlines
    const raw = atob(data.content.replace(/\n/g, ''));
    let body: string | object;
    let mime = 'application/octet-stream';

    // Try to detect content type from the stored metadata comment in commit msg
    // or fall back to JSON detection
    try {
      body = JSON.parse(raw);
      mime = 'application/json; charset=UTF-8';
    } catch {
      body = raw;
      mime = 'text/plain; charset=UTF-8';
    }

    return {
      statusCode: 200,
      body,
      contentType: mime,
      revision: sha,
    };
  }

  private async _listFolder(path: string): Promise<RemoteResponse> {
    const cleanPath = path.replace(/\/$/, '');
    const url = this._contentsUrl(cleanPath) + '?ref=' + encodeURIComponent(this.branch);
    const xhr = await this._githubRequest('GET', url);

    if (xhr.status === 404) {
      // Treat missing folder as empty
      return {
        statusCode: 200,
        body: {},
        contentType: 'application/json; charset=UTF-8',
        revision: undefined,
      };
    }

    if (xhr.status !== 200) { return { statusCode: xhr.status }; }

    let entries;
    try { entries = JSON.parse(xhr.responseText); } catch {
      return { statusCode: 500 };
    }

    if (!Array.isArray(entries)) {
      // GitHub returns a single object for files, not folders
      return { statusCode: 400 };
    }

    const listing: Record<string, { ETag?: string; 'Content-Length'?: number }> = {};
    for (const item of entries) {
      const name = item.type === 'dir' ? item.name + '/' : item.name;
      if (item.type === 'dir') {
        listing[name] = {};
      } else {
        listing[name] = { ETag: item.sha, 'Content-Length': item.size };
      }
    }

    return {
      statusCode: 200,
      body: listing,
      contentType: 'application/json; charset=UTF-8',
      revision: undefined,
    };
  }

  private async _putFile(
    path: string,
    body: XMLHttpRequestBodyInit,
    contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string }
  ): Promise<RemoteResponse> {
    const url = this._contentsUrl(path);

    // Fetch current sha so we can update or detect conflicts
    let currentSha: string | undefined;
    const existing = await this._githubRequest('GET', url + '?ref=' + encodeURIComponent(this.branch));
    if (existing.status === 200) {
      try { currentSha = JSON.parse(existing.responseText).sha; } catch { /* ignore */ }
    }

    // Conflict checks
    if (options.ifNoneMatch === '*' && currentSha) {
      return { statusCode: 412, revision: currentSha };
    }
    if (options.ifMatch && currentSha && options.ifMatch !== currentSha) {
      return { statusCode: 412, revision: currentSha };
    }
    if (options.ifMatch && !currentSha) {
      // Caller expected a specific revision but file doesn't exist
      return { statusCode: 412 };
    }

    // Encode body to Base64
    let content: string;
    if (typeof body === 'string') {
      content = btoa(unescape(encodeURIComponent(body)));
    } else if (body instanceof ArrayBuffer) {
      content = btoa(String.fromCharCode(...new Uint8Array(body)));
    } else {
      content = btoa(body as unknown as string);
    }

    const payload: Record<string, string> = {
      message: `remotestorage: put ${path}`,
      content,
      branch: this.branch,
    };
    if (currentSha) { payload.sha = currentSha; }

    const xhr = await this._githubRequest('PUT', url, payload);

    if (xhr.status === 409 || xhr.status === 422) {
      // Conflict or stale sha — surface to sync layer
      return { statusCode: 412 };
    }
    if (xhr.status !== 200 && xhr.status !== 201) {
      return { statusCode: xhr.status };
    }

    let newSha: string | undefined;
    try {
      const resp = JSON.parse(xhr.responseText);
      newSha = resp.content?.sha;
    } catch { /* ignore */ }

    return { statusCode: xhr.status === 201 ? 200 : xhr.status, revision: newSha };
  }

  private async _deleteFile(path: string, options: { ifMatch?: string }): Promise<RemoteResponse> {
    const url = this._contentsUrl(path);

    // Fetch current sha — required by GitHub DELETE
    const existing = await this._githubRequest('GET', url + '?ref=' + encodeURIComponent(this.branch));
    if (existing.status === 404) { return { statusCode: 404 }; }
    if (existing.status !== 200) { return { statusCode: existing.status }; }

    let currentSha: string;
    try { currentSha = JSON.parse(existing.responseText).sha; } catch {
      return { statusCode: 500 };
    }

    if (options.ifMatch && options.ifMatch !== currentSha) {
      return { statusCode: 412, revision: currentSha };
    }

    const xhr = await this._githubRequest('DELETE', url, {
      message: `remotestorage: delete ${path}`,
      sha: currentSha,
      branch: this.branch,
    });

    if (xhr.status === 404) { return { statusCode: 404 }; }
    if (xhr.status === 409 || xhr.status === 422) { return { statusCode: 412 }; }
    if (xhr.status !== 200) { return { statusCode: xhr.status }; }

    return { statusCode: 200 };
  }

  // ---------------------------------------------------- static backend hooks

  static _rs_init(rs: RemoteStorage): void {
    hasLocalStorage = localStorageAvailable();
    if (rs.apiKeys['github']) {
      (rs as any).github = new GitHub(rs);
    }
    if (rs.backend === 'github' || (rs.apiKeys['github'] as GitHubConfig)?.token) {
      rs.setBackend('github');
      hookRemote(rs);
    }
  }

  static _rs_supported(): boolean {
    return true;
  }

  static _rs_cleanup(rs: RemoteStorage): void {
    unHookRemote(rs);
    if (hasLocalStorage) { localStorage.removeItem(SETTINGS_KEY); }
    rs.setBackend(undefined);
  }
}

function hookRemote(rs: RemoteStorage): void {
  if ((rs as any)._origRemote) { return; }
  (rs as any)._origRemote = rs.remote;
  rs.remote = (rs as any).github;
}

function unHookRemote(rs: RemoteStorage): void {
  if ((rs as any)._origRemote) {
    rs.remote = (rs as any)._origRemote;
    delete (rs as any)._origRemote;
  }
}

interface GitHub extends EventHandling {}
applyMixins(GitHub, [EventHandling]);

namespace GitHub {
  export interface Config extends GitHubConfig {}
}

export = GitHub;
