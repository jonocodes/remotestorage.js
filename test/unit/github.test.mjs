import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import fetchMock from 'fetch-mock';

import { localStorage, sessionStorage } from '../helpers/memoryStorage.mjs';

// Expose sessionStorage globally for the Node.js test environment
if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = sessionStorage;
}

import GitHub from '../../build/github.js';
import { RemoteStorage } from '../../build/remotestorage.js';

chai.use(chaiAsPromised);

const SETTINGS_KEY  = 'remotestorage:github';
const API_BASE      = 'https://api.github.com';
const OWNER         = 'testuser';
const REPO          = 'rs-storage';
const BRANCH        = 'main';
const ROOT          = 'remoteStorage';
const CLIENT_ID     = 'test-client-id';
const ACCESS_TOKEN  = 'ghu_testtoken';
const USER_LOGIN    = 'testuser';

const GITHUB_CONFIG = {
  clientId: CLIENT_ID,
  owner:    OWNER,
  repo:     REPO,
  branch:   BRANCH,
  root:     ROOT + '/',
};

function contentsUrl(path) {
  const full = `${ROOT}/${path.replace(/^\//, '')}`.replace(/\/+/g, '/');
  return `${API_BASE}/repos/${OWNER}/${REPO}/contents/${full}`;
}

function makeFileResponse(path, content, sha = 'abc123') {
  const encoded = Buffer.from(content).toString('base64');
  return {
    name: path.split('/').pop(),
    path: `${ROOT}/${path}`,
    sha,
    size: content.length,
    content: encoded + '\n',
    encoding: 'base64',
  };
}

describe('GitHub backend', () => {
  const sandbox = sinon.createSandbox();
  let rs, github;

  beforeEach(() => {
    localStorage.removeItem(SETTINGS_KEY);
    rs = new RemoteStorage();
    rs.setApiKeys({ github: GITHUB_CONFIG });
    rs.stopSync();
    rs._handlers['connected'] = [];

    github = rs.github;
    github.configure({ userAddress: USER_LOGIN, token: ACCESS_TOKEN });
    github.connected = true;
    github.online = true;
  });

  afterEach(() => {
    rs.stopSync();
    rs.disconnect();
    GitHub._rs_cleanup(rs);
    fetchMock.reset();
    sandbox.restore();
  });

  after(() => {
    localStorage.clear();
  });

  // ------------------------------------------------------------------ auth

  describe('PKCE helpers', () => {
    it('generateCodeVerifier produces verifier and challenge', async () => {
      // generateCodeVerifier is from util.ts, tested via connect() side-effects
      // We verify sessionStorage is populated when connect() is called without token
      const githubNoToken = rs.github;
      githubNoToken.token = undefined;
      githubNoToken.connected = false;

      let authorizeArgs;
      rs.authorize = (args) => { authorizeArgs = args; };

      // Mock /user endpoint in case configure() fires
      fetchMock.get(`${API_BASE}/user`, { status: 200, body: { login: USER_LOGIN } });

      await githubNoToken.connect();

      expect(sessionStorage.getItem('remotestorage:github:codeVerifier')).to.be.a('string').with.length.greaterThan(10);
      expect(sessionStorage.getItem('remotestorage:state')).to.be.a('string').with.length.greaterThan(10);
    });

    it('connect() calls rs.authorize with correct GitHub OAuth params', async () => {
      const githubNoToken = rs.github;
      githubNoToken.token = undefined;
      githubNoToken.connected = false;

      let authorizeArgs;
      rs.authorize = (args) => { authorizeArgs = args; };

      await githubNoToken.connect();

      expect(authorizeArgs.authURL).to.equal('https://github.com/login/oauth/authorize');
      expect(authorizeArgs.clientId).to.equal(CLIENT_ID);
      expect(authorizeArgs.response_type).to.equal('code');
      expect(authorizeArgs.code_challenge_method).to.equal('S256');
      expect(authorizeArgs.scope).to.include('public_repo');
    });
  });

  // ------------------------------------------------------------------ GET file

  describe('get() - file', () => {
    it('returns body and revision for existing file', async () => {
      const content = 'hello world';
      const sha = 'deadbeef';
      const url = contentsUrl('notes/hello.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 200, body: makeFileResponse('notes/hello.txt', content, sha) });

      const result = await github.get('/notes/hello.txt');

      expect(result.statusCode).to.equal(200);
      expect(result.revision).to.equal(sha);
      expect(result.body).to.include('hello world');
    });

    it('returns 404 for missing file', async () => {
      const url = contentsUrl('missing.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 404, body: { message: 'Not Found' } });

      const result = await github.get('/missing.txt');
      expect(result.statusCode).to.equal(404);
    });

    it('returns 304 when ETag matches', async () => {
      const sha = 'abc123';
      const url = contentsUrl('doc.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 200, body: makeFileResponse('doc.txt', 'content', sha) });

      const result = await github.get('/doc.txt', { ifNoneMatch: sha });
      expect(result.statusCode).to.equal(304);
    });

    it('returns body when ETag does not match', async () => {
      const sha = 'newsha';
      const url = contentsUrl('doc.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 200, body: makeFileResponse('doc.txt', 'updated', sha) });

      const result = await github.get('/doc.txt', { ifNoneMatch: 'oldsha' });
      expect(result.statusCode).to.equal(200);
      expect(result.revision).to.equal(sha);
    });

    it('parses JSON body correctly', async () => {
      const obj = { foo: 'bar', n: 42 };
      const sha = 'jsonsha';
      const url = contentsUrl('data.json') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 200, body: makeFileResponse('data.json', JSON.stringify(obj), sha) });

      const result = await github.get('/data.json');
      expect(result.statusCode).to.equal(200);
      expect(result.body).to.deep.equal(obj);
      expect(result.contentType).to.include('application/json');
    });
  });

  // ------------------------------------------------------------------ GET folder

  describe('get() - folder listing', () => {
    it('lists files and directories', async () => {
      const url = contentsUrl('notes') + `?ref=${BRANCH}`;
      const entries = [
        { name: 'hello.txt', type: 'file', sha: 'sha1', size: 11 },
        { name: 'subdir',    type: 'dir',  sha: 'sha2', size: 0  },
      ];
      fetchMock.get(url, { status: 200, body: entries });

      const result = await github.get('/notes/');
      expect(result.statusCode).to.equal(200);
      expect(result.body).to.have.property('hello.txt');
      expect(result.body['hello.txt'].ETag).to.equal('sha1');
      expect(result.body).to.have.property('subdir/');
    });

    it('returns empty listing for missing folder (404)', async () => {
      const url = contentsUrl('nonexistent') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 404, body: { message: 'Not Found' } });

      const result = await github.get('/nonexistent/');
      expect(result.statusCode).to.equal(200);
      expect(result.body).to.deep.equal({});
    });
  });

  // ------------------------------------------------------------------ PUT

  describe('put()', () => {
    it('creates a new file (no existing sha)', async () => {
      const path = '/new-file.txt';
      const getUrl = contentsUrl('new-file.txt') + `?ref=${BRANCH}`;
      const putUrl = contentsUrl('new-file.txt');
      const newSha = 'newfilesha';

      fetchMock.get(getUrl, { status: 404 });
      fetchMock.put(putUrl, { status: 201, body: { content: { sha: newSha } } });

      const result = await github.put(path, 'hello', 'text/plain');
      expect(result.statusCode).to.equal(200);
      expect(result.revision).to.equal(newSha);
    });

    it('updates existing file with matching sha', async () => {
      const path = '/existing.txt';
      const sha = 'existingsha';
      const getUrl = contentsUrl('existing.txt') + `?ref=${BRANCH}`;
      const putUrl = contentsUrl('existing.txt');
      const newSha = 'updatedsha';

      fetchMock.get(getUrl, { status: 200, body: makeFileResponse('existing.txt', 'old', sha) });
      fetchMock.put(putUrl, { status: 200, body: { content: { sha: newSha } } });

      const result = await github.put(path, 'new content', 'text/plain', { ifMatch: sha });
      expect(result.statusCode).to.equal(200);
      expect(result.revision).to.equal(newSha);
    });

    it('returns 412 when ifNoneMatch=* and file exists', async () => {
      const path = '/taken.txt';
      const sha = 'existingsha';
      const getUrl = contentsUrl('taken.txt') + `?ref=${BRANCH}`;

      fetchMock.get(getUrl, { status: 200, body: makeFileResponse('taken.txt', 'data', sha) });

      const result = await github.put(path, 'new', 'text/plain', { ifNoneMatch: '*' });
      expect(result.statusCode).to.equal(412);
      expect(result.revision).to.equal(sha);
    });

    it('returns 412 on stale sha conflict', async () => {
      const path = '/stale.txt';
      const currentSha = 'newsha';
      const getUrl = contentsUrl('stale.txt') + `?ref=${BRANCH}`;

      fetchMock.get(getUrl, { status: 200, body: makeFileResponse('stale.txt', 'data', currentSha) });

      const result = await github.put(path, 'update', 'text/plain', { ifMatch: 'oldsha' });
      expect(result.statusCode).to.equal(412);
      expect(result.revision).to.equal(currentSha);
    });

    it('returns 412 when GitHub responds with 409 conflict', async () => {
      const path = '/conflict.txt';
      const getUrl = contentsUrl('conflict.txt') + `?ref=${BRANCH}`;
      const putUrl = contentsUrl('conflict.txt');

      fetchMock.get(getUrl, { status: 404 });
      fetchMock.put(putUrl, { status: 409, body: { message: 'conflict' } });

      const result = await github.put(path, 'data', 'text/plain');
      expect(result.statusCode).to.equal(412);
    });
  });

  // ------------------------------------------------------------------ DELETE

  describe('delete()', () => {
    it('deletes an existing file', async () => {
      const path = '/del.txt';
      const sha = 'delsha';
      const getUrl = contentsUrl('del.txt') + `?ref=${BRANCH}`;
      const delUrl = contentsUrl('del.txt');

      fetchMock.get(getUrl, { status: 200, body: makeFileResponse('del.txt', 'bye', sha) });
      fetchMock.delete(delUrl, { status: 200, body: { commit: {} } });

      const result = await github['delete'](path);
      expect(result.statusCode).to.equal(200);
    });

    it('returns 404 for missing file', async () => {
      const path = '/gone.txt';
      const getUrl = contentsUrl('gone.txt') + `?ref=${BRANCH}`;

      fetchMock.get(getUrl, { status: 404 });

      const result = await github['delete'](path);
      expect(result.statusCode).to.equal(404);
    });

    it('returns 412 when ifMatch does not match current sha', async () => {
      const path = '/changed.txt';
      const currentSha = 'current';
      const getUrl = contentsUrl('changed.txt') + `?ref=${BRANCH}`;

      fetchMock.get(getUrl, { status: 200, body: makeFileResponse('changed.txt', 'data', currentSha) });

      const result = await github['delete'](path, { ifMatch: 'stale' });
      expect(result.statusCode).to.equal(412);
      expect(result.revision).to.equal(currentSha);
    });
  });

  // ------------------------------------------------------------------ auth errors

  describe('auth errors', () => {
    it('emits error event on 401 response', async () => {
      const errorSpy = sinon.spy();
      rs.on('error', errorSpy);
      const url = contentsUrl('secret.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 401, body: { message: 'Requires authentication' } });

      await github.get('/secret.txt');
      expect(errorSpy.called).to.be.true;
    });

    it('emits error event on 403 response', async () => {
      const errorSpy = sinon.spy();
      rs.on('error', errorSpy);
      const url = contentsUrl('forbidden.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 403, body: { message: 'Forbidden' } });

      await github.get('/forbidden.txt');
      expect(errorSpy.called).to.be.true;
    });
  });

  // ------------------------------------------------------------------ path normalization

  describe('path normalization', () => {
    it('strips leading slash from file path', async () => {
      const url = contentsUrl('test.txt') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 404 });

      // Should not throw and should hit the right URL
      const result = await github.get('/test.txt');
      expect(fetchMock.called(url)).to.be.true;
      expect(result.statusCode).to.equal(404);
    });

    it('prepends root prefix to path', async () => {
      // The root is 'remoteStorage', so /foo.txt -> remoteStorage/foo.txt
      const expectedUrl = `${API_BASE}/repos/${OWNER}/${REPO}/contents/${ROOT}/foo.txt?ref=${BRANCH}`;
      fetchMock.get(expectedUrl, { status: 404 });

      await github.get('/foo.txt');
      expect(fetchMock.called(expectedUrl)).to.be.true;
    });

    it('handles folder path by stripping trailing slash for API call', async () => {
      // /notes/ -> contentsUrl should strip trailing slash for GitHub API
      const url = contentsUrl('notes') + `?ref=${BRANCH}`;
      fetchMock.get(url, { status: 200, body: [] });

      const result = await github.get('/notes/');
      expect(fetchMock.called(url)).to.be.true;
    });
  });

  // ------------------------------------------------------------------ write queue

  describe('write serialization', () => {
    it('serializes concurrent writes', async () => {
      const callOrder = [];
      const sha = 'sha1';
      const getUrl1 = contentsUrl('a.txt') + `?ref=${BRANCH}`;
      const putUrl1 = contentsUrl('a.txt');
      const getUrl2 = contentsUrl('b.txt') + `?ref=${BRANCH}`;
      const putUrl2 = contentsUrl('b.txt');

      fetchMock.get(getUrl1, () => { callOrder.push('get-a'); return { status: 404 }; });
      fetchMock.put(putUrl1, () => { callOrder.push('put-a'); return { status: 201, body: { content: { sha: 'sha-a' } } }; });
      fetchMock.get(getUrl2, () => { callOrder.push('get-b'); return { status: 404 }; });
      fetchMock.put(putUrl2, () => { callOrder.push('put-b'); return { status: 201, body: { content: { sha: 'sha-b' } } }; });

      // Fire both concurrently
      const [r1, r2] = await Promise.all([
        github.put('/a.txt', 'aaa', 'text/plain'),
        github.put('/b.txt', 'bbb', 'text/plain'),
      ]);

      expect(r1.statusCode).to.equal(200);
      expect(r2.statusCode).to.equal(200);
      // Verify that put-a completed before get-b started (serialized)
      expect(callOrder.indexOf('put-a')).to.be.lessThan(callOrder.indexOf('get-b'));
    });
  });

  // ------------------------------------------------------------------ configure / session

  describe('configure()', () => {
    it('persists token and userAddress to localStorage', async () => {
      localStorage.removeItem(SETTINGS_KEY);
      const gh = new GitHub(rs);
      await gh.configure({ token: 'tok', userAddress: 'user' });

      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      expect(saved.token).to.equal('tok');
      expect(saved.userAddress).to.equal('user');
    });

    it('fetches user login when userAddress is absent', async () => {
      localStorage.removeItem(SETTINGS_KEY);
      fetchMock.get(`${API_BASE}/user`, { status: 200, body: { login: 'octocat' } });

      const gh = new GitHub(rs);
      await gh.configure({ token: 'tok' });

      expect(gh.userAddress).to.equal('octocat');
    });
  });
});
