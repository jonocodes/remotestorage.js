import 'mocha';
import * as chai from "chai";
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import fetchMock from 'fetch-mock';

import { localStorage } from '../helpers/memoryStorage.mjs';

import GoogleDrive from "../../build/googledrive.js";
import { RemoteStorage } from '../../build/remotestorage.js';

const SETTINGS_KEY = 'remotestorage:googledrive';
const BASE_URL = 'https://www.googleapis.com';
const FILE_ID = 'abc123fileId';
const PUBLIC_PATH = '/public/photo.jpg';
const SHARE_URL = 'https://drive.google.com/file/d/abc123fileId/view?usp=drivesdk';
const USER_ADDRESS = 'user@gmail.com';
const ACCESS_TOKEN = 'ya29.sometoken';

chai.use(chaiAsPromised);

describe('GoogleDrive backend', () => {
  const CLIENT_ID = 'some-client-id.apps.googleusercontent.com';
  const sandbox = sinon.createSandbox();
  let rs, gdrive;

  beforeEach(() => {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(`${SETTINGS_KEY}:shares`);
    rs = new RemoteStorage();
    rs.setApiKeys({ googledrive: { clientId: CLIENT_ID } });

    gdrive = rs.googledrive;
    gdrive.configure({
      userAddress: USER_ADDRESS,
      token: ACCESS_TOKEN,
    });
    gdrive.connected = true;
    gdrive.online = true;
  });

  afterEach(() => {
    rs.disconnect();
    GoogleDrive._rs_cleanup(rs);
    fetchMock.reset();
    sandbox.restore();
  });

  after(() => {
    localStorage.clear();
  });

  describe("getItemURL", () => {
    const PERMISSIONS_URL = `${BASE_URL}/drive/v2/files/${FILE_ID}/permissions`;
    const META_URL = `${BASE_URL}/drive/v2/files/${FILE_ID}?fields=webViewLink`;

    beforeEach(() => {
      // Pre-populate the file ID cache so _share() doesn't need to list folders
      gdrive._fileIdCache.set(`/remotestorage${PUBLIC_PATH}`, FILE_ID);
    });

    it("returns undefined for non-public paths", async () => {
      const url = await gdrive.getItemURL('/private/secret.txt');
      expect(url).to.be.undefined;
    });

    it("returns undefined for public folder paths (not files)", async () => {
      const url = await gdrive.getItemURL('/public/');
      expect(url).to.be.undefined;
    });

    it("returns cached URL from _itemRefs without making an API call", async () => {
      gdrive._itemRefs[PUBLIC_PATH] = SHARE_URL;

      const url = await gdrive.getItemURL(PUBLIC_PATH);

      expect(url).to.equal(SHARE_URL);
      expect(fetchMock.calls()).to.have.lengthOf(0);
    });

    it("sets public permission and returns webViewLink when not cached", async () => {
      fetchMock.mock(
        { name: 'postPermission', method: 'POST', url: PERMISSIONS_URL },
        { status: 200, body: JSON.stringify({ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }) }
      );
      fetchMock.mock(
        { name: 'getMeta', method: 'GET', url: META_URL },
        { status: 200, body: JSON.stringify({ id: FILE_ID, webViewLink: SHARE_URL }) }
      );

      const url = await gdrive.getItemURL(PUBLIC_PATH);

      expect(url).to.equal(SHARE_URL);
      expect(gdrive._itemRefs[PUBLIC_PATH]).to.equal(SHARE_URL);

      const permCall = fetchMock.calls('postPermission')[0];
      expect(JSON.parse(permCall[1].body)).to.deep.equal({ role: 'reader', type: 'anyone' });
    });

    it("persists the URL to localStorage after sharing", async () => {
      fetchMock.mock(
        { name: 'postPermission', method: 'POST', url: PERMISSIONS_URL },
        { status: 200, body: JSON.stringify({ id: 'anyoneWithLink' }) }
      );
      fetchMock.mock(
        { name: 'getMeta', method: 'GET', url: META_URL },
        { status: 200, body: JSON.stringify({ id: FILE_ID, webViewLink: SHARE_URL }) }
      );

      await gdrive.getItemURL(PUBLIC_PATH);

      const stored = JSON.parse(localStorage.getItem(`${SETTINGS_KEY}:shares`));
      expect(stored).to.have.property(PUBLIC_PATH, SHARE_URL);
    });

    it("proceeds when permission already exists (400 response)", async () => {
      fetchMock.mock(
        { name: 'postPermission', method: 'POST', url: PERMISSIONS_URL },
        { status: 400, body: JSON.stringify({ error: { message: 'Bad Request' } }) }
      );
      fetchMock.mock(
        { name: 'getMeta', method: 'GET', url: META_URL },
        { status: 200, body: JSON.stringify({ id: FILE_ID, webViewLink: SHARE_URL }) }
      );

      const url = await gdrive.getItemURL(PUBLIC_PATH);
      expect(url).to.equal(SHARE_URL);
    });

    it("rejects when setting permission fails with an unexpected status", async () => {
      fetchMock.mock(
        { name: 'postPermission', method: 'POST', url: PERMISSIONS_URL },
        { status: 403, body: JSON.stringify({ error: { message: 'Forbidden' } }) }
      );

      await expect(gdrive.getItemURL(PUBLIC_PATH)).to.be.rejectedWith('Could not set public permission');
    });

    it("rejects when fetching metadata fails", async () => {
      fetchMock.mock(
        { name: 'postPermission', method: 'POST', url: PERMISSIONS_URL },
        { status: 200, body: JSON.stringify({ id: 'anyoneWithLink' }) }
      );
      fetchMock.mock(
        { name: 'getMeta', method: 'GET', url: META_URL },
        { status: 404, body: JSON.stringify({ error: { message: 'Not Found' } }) }
      );

      await expect(gdrive.getItemURL(PUBLIC_PATH)).to.be.rejectedWith('Could not get metadata');
    });
  });
});
