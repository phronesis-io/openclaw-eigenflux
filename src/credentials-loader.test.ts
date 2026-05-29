import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CredentialsLoader } from './credentials-loader';
import { Logger } from './logger';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('CredentialsLoader', () => {
  let eigenfluxHome: string;
  const serverName = 'testserver';

  beforeEach(() => {
    eigenfluxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-home-'));
    const serverDir = path.join(eigenfluxHome, 'servers', serverName);
    fs.mkdirSync(serverDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(eigenfluxHome, { recursive: true, force: true });
  });

  test('loads access token from credentials.json', () => {
    const serverDir = path.join(eigenfluxHome, 'servers', serverName);
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_file_token' }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), eigenfluxHome, serverName);
    expect(loader.loadAccessToken()).toBe('at_file_token');
  });

  test('returns null when credentials file is missing', () => {
    const loader = new CredentialsLoader(createLogger(), eigenfluxHome, serverName);
    expect(loader.loadAccessToken()).toBeNull();
  });

  test('returns available even when local expires_at is in the past (trusts server-side sliding expiration)', () => {
    const serverDir = path.join(eigenfluxHome, 'servers', serverName);
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({
        access_token: 'at_expired_token',
        expires_at: Date.now() - 1_000,
      }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), eigenfluxHome, serverName);
    expect(loader.loadAuthState()).toEqual(
      expect.objectContaining({
        status: 'available',
        accessToken: 'at_expired_token',
      })
    );
    expect(loader.loadAccessToken()).toBe('at_expired_token');
  });

  test('saveAccessToken creates the server directory and writes credentials.json', () => {
    const nestedHome = path.join(eigenfluxHome, 'nested');
    const loader = new CredentialsLoader(createLogger(), nestedHome, 'newserver');

    loader.saveAccessToken('at_saved_token', 'bot@example.com', 1_760_000_000_000);

    const credentialsPath = path.join(nestedHome, 'servers', 'newserver', 'credentials.json');
    expect(fs.existsSync(credentialsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'))).toEqual({
      access_token: 'at_saved_token',
      email: 'bot@example.com',
      expires_at: 1_760_000_000_000,
    });
  });
});
