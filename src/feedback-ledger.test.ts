import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { LedgerStore, LEDGER_TTL_MS, makeShortTitle } from './feedback-ledger';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

function writeCacheFile(broadcastsDir: string, dateDir: string, file: string, payload: unknown): string {
  const dir = path.join(broadcastsDir, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, file);
  fs.writeFileSync(fp, JSON.stringify(payload));
  return fp;
}

describe('LedgerStore', () => {
  let dir: string;
  let broadcastsDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    broadcastsDir = path.join(dir, 'broadcasts');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('records items and looks them up', () => {
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    store.record([{ item_id: 'a1', summary: 'hello world' }], 'srv', 1_000_000);
    const result = store.lookup('a1', 1_000_000);
    expect(result.status).toBe('hit');
    expect(result.entry?.server_id).toBe('srv');
    expect(result.entry?.short_title).toBe('hello world');
  });

  test('stamps the impression_id onto recorded entries', () => {
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    store.record([{ item_id: 'a1' }], 'srv', 1_000_000, 'imp-7');
    expect(store.lookup('a1', 1_000_000).entry?.impression_id).toBe('imp-7');
  });

  test('returns missing for unknown item_id when bootstrap finds nothing', () => {
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.lookup('nope', 1_000_000).status).toBe('missing');
  });

  test('returns expired after TTL', () => {
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    store.record([{ item_id: 'a1' }], 'srv', 1_000_000);
    const after = 1_000_000 + LEDGER_TTL_MS + 1;
    expect(store.lookup('a1', after).status).toBe('expired');
  });

  test('prune removes expired entries', () => {
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    store.record([{ item_id: 'a1' }], 'srv', 1_000_000);
    store.record([{ item_id: 'a2' }], 'srv', 2_000_000_000);
    store.prune(2_000_000_000);
    expect(store.lookup('a1', 2_000_000_000).status).toBe('missing');
    expect(store.lookup('a2', 2_000_000_000).status).toBe('hit');
  });

  test('lazy bootstrap pulls item_ids from the CLI broadcast cache on first miss', () => {
    const fp = writeCacheFile(broadcastsDir, '20260626', 'feeds-20260626-100000.json', {
      items: [
        { item_id: 'cached-a', summary: 'a from cache' },
        { item_id: 'cached-b', summary: 'b from cache' },
      ],
      has_more: false,
    });
    // Make the cache file recent so it falls inside the TTL window.
    const now = Date.now();
    fs.utimesSync(fp, new Date(now), new Date(now));

    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.size()).toBe(0);

    const hit = store.lookup('cached-a', now);
    expect(hit.status).toBe('hit');
    expect(hit.entry?.server_id).toBe('srv');
    expect(hit.entry?.short_title).toBe('a from cache');
    // Bootstrap loaded both items in one scan
    expect(store.size()).toBe(2);
    expect(store.lookup('cached-b', now).status).toBe('hit');
  });

  test('bootstrap only fires once — after record() it short-circuits', () => {
    writeCacheFile(broadcastsDir, '20260626', 'feeds-20260626-100000.json', {
      items: [{ item_id: 'cached-a' }],
    });
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    // record() marks bootstrapped = true before any miss has triggered a scan
    store.record([{ item_id: 'live-x' }], 'srv', Date.now());
    // 'cached-a' is in the cache file but bootstrap should NOT run now
    expect(store.lookup('cached-a', Date.now()).status).toBe('missing');
    expect(store.lookup('live-x', Date.now()).status).toBe('hit');
  });

  test('bootstrap skips files older than TTL', () => {
    const fp = writeCacheFile(broadcastsDir, '20260101', 'feeds-20260101-000000.json', {
      items: [{ item_id: 'ancient' }],
    });
    const ancient = Date.now() - (LEDGER_TTL_MS + 60_000);
    fs.utimesSync(fp, new Date(ancient), new Date(ancient));
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.lookup('ancient', Date.now()).status).toBe('missing');
  });

  test('bootstrap tolerates corrupt cache files and continues with the rest', () => {
    fs.mkdirSync(path.join(broadcastsDir, '20260626'), { recursive: true });
    fs.writeFileSync(path.join(broadcastsDir, '20260626', 'feeds-broken.json'), '{this is not json');
    const goodFile = writeCacheFile(broadcastsDir, '20260626', 'feeds-good.json', {
      items: [{ item_id: 'survivor' }],
    });
    const now = Date.now();
    fs.utimesSync(goodFile, new Date(now), new Date(now));

    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.lookup('survivor', now).status).toBe('hit');
  });

  test('bootstrap accepts both bare items[] and wrapped data.items[]', () => {
    const fp = writeCacheFile(broadcastsDir, '20260626', 'feeds-wrapped.json', {
      data: { items: [{ item_id: 'wrapped' }] },
    });
    const now = Date.now();
    fs.utimesSync(fp, new Date(now), new Date(now));
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.lookup('wrapped', now).status).toBe('hit');
  });

  test('bootstrap is a no-op when broadcasts dir does not exist', () => {
    const store = new LedgerStore(path.join(dir, 'does-not-exist'), 'srv', createLogger());
    expect(store.lookup('anything', Date.now()).status).toBe('missing');
  });

  test('bootstrap ignores junk filenames and non-date dirs', () => {
    fs.mkdirSync(path.join(broadcastsDir, 'not-a-date'), { recursive: true });
    fs.writeFileSync(
      path.join(broadcastsDir, 'not-a-date', 'feeds-x.json'),
      JSON.stringify({ items: [{ item_id: 'should-not-load' }] })
    );
    fs.mkdirSync(path.join(broadcastsDir, '20260626'), { recursive: true });
    fs.writeFileSync(
      path.join(broadcastsDir, '20260626', 'publish-x.json'),
      JSON.stringify({ items: [{ item_id: 'should-not-load' }] })
    );
    const store = new LedgerStore(broadcastsDir, 'srv', createLogger());
    expect(store.lookup('should-not-load', Date.now()).status).toBe('missing');
  });

  test('makeShortTitle truncates with ellipsis', () => {
    const long = 'x'.repeat(200);
    expect(makeShortTitle({ item_id: 'a', summary: long }).length).toBeLessThanOrEqual(80);
    expect(makeShortTitle({ item_id: 'a', summary: long }).endsWith('…')).toBe(true);
  });

  test('makeShortTitle normalizes whitespace', () => {
    expect(makeShortTitle({ item_id: 'a', summary: '  hello\n\nworld  ' })).toBe('hello world');
  });

  test('makeShortTitle returns empty when summary missing', () => {
    expect(makeShortTitle({ item_id: 'a' })).toBe('');
  });
});
