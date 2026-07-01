import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';
import { FeedbackEventQueue, FeedbackEvent } from './feedback-queue';

jest.mock('./cli-executor');
import { execEigenflux } from './cli-executor';
const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

function ok(): CliResult<unknown> {
  return { kind: 'success', data: { accepted: 1, deduped: 0 } };
}
function fail(): CliResult<unknown> {
  return { kind: 'error', error: new Error('boom'), exitCode: 1, stderr: 'boom' };
}

function makeEvent(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    item_id: 'a1',
    server_id: 'srv',
    kind: 'surface',
    ts: 1_000_000,
    dedup_key: 'k1',
    ...overrides,
  };
}

describe('FeedbackEventQueue', () => {
  let dir: string;
  beforeEach(() => {
    execMock.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('enqueue persists to disk', () => {
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    queue.enqueue(makeEvent());
    const persisted = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(persisted.events).toHaveLength(1);
  });

  test('flush calls CLI with batch json and clears the queue on success', async () => {
    let capturedBatch: { events: FeedbackEvent[] } | undefined;
    execMock.mockImplementation(async (_bin, args) => {
      const batchPath = args[args.indexOf('--batch') + 1];
      capturedBatch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
      return ok();
    });
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    queue.enqueue(makeEvent({ dedup_key: 'k1' }));
    queue.enqueue(makeEvent({ dedup_key: 'k2' }));
    await queue.flushNow(2_000_000);
    expect(execMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execMock.mock.calls[0];
    expect(bin).toBe('eigenflux');
    expect(args[0]).toBe('feed');
    expect(args[1]).toBe('event');
    expect(args[2]).toBe('push');
    expect(args).toContain('--batch');
    expect(capturedBatch?.events).toHaveLength(2);
    expect(queue.size()).toBe(0);
  });

  test('flush retries with back-off on CLI failure', async () => {
    execMock.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok());
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue(
      { storageFile: file, eigenfluxBin: 'eigenflux', baseBackoffMs: 1, maxBackoffMs: 5 },
      createLogger()
    );
    queue.enqueue(makeEvent());
    await queue.flushNow(2_000_000);
    expect(queue.size()).toBe(1);
    // Advance past the back-off window and retry
    await queue.flushNow(2_000_500);
    expect(queue.size()).toBe(0);
  });

  test('honors back-off window — does not call CLI while inside it', async () => {
    execMock.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok());
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue(
      { storageFile: file, eigenfluxBin: 'eigenflux', baseBackoffMs: 10_000, maxBackoffMs: 60_000 },
      createLogger()
    );
    queue.enqueue(makeEvent());
    await queue.flushNow(2_000_000); // fail → back off until 2_010_000
    expect(execMock).toHaveBeenCalledTimes(1);
    await queue.flushNow(2_005_000); // inside the back-off window
    expect(execMock).toHaveBeenCalledTimes(1);
    await queue.flushNow(2_011_000); // past the window
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  test('drops events older than maxAge', async () => {
    let capturedBatch: { events: FeedbackEvent[] } | undefined;
    execMock.mockImplementation(async (_bin, args) => {
      const batchPath = args[args.indexOf('--batch') + 1];
      capturedBatch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
      return ok();
    });
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue(
      { storageFile: file, eigenfluxBin: 'eigenflux', maxAgeMs: 10 },
      createLogger()
    );
    queue.enqueue(makeEvent({ ts: 0 }));
    queue.enqueue(makeEvent({ ts: 100, dedup_key: 'k2' }));
    await queue.flushNow(50);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(capturedBatch?.events).toHaveLength(1);
    expect(capturedBatch?.events[0].dedup_key).toBe('k2');
  });

  test('collapses duplicate dedup_keys at flush, keeping the latest ts', async () => {
    let capturedBatch: { events: FeedbackEvent[] } | undefined;
    execMock.mockImplementation(async (_bin, args) => {
      const batchPath = args[args.indexOf('--batch') + 1];
      capturedBatch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
      return ok();
    });
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    queue.enqueue(makeEvent({ dedup_key: 'k1', ts: 100 }));
    queue.enqueue(makeEvent({ dedup_key: 'k1', ts: 200 }));
    await queue.flushNow(300);
    expect(capturedBatch?.events).toHaveLength(1);
    expect(capturedBatch?.events[0].ts).toBe(200);
  });

  test('reloads persisted events on construction', () => {
    const file = path.join(dir, 'queue.json');
    const q1 = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    q1.enqueue(makeEvent());
    const q2 = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    expect(q2.size()).toBe(1);
  });

  test('flushNow with an empty queue is a no-op', async () => {
    const file = path.join(dir, 'queue.json');
    const queue = new FeedbackEventQueue({ storageFile: file, eigenfluxBin: 'eigenflux' }, createLogger());
    await queue.flushNow(0);
    expect(execMock).not.toHaveBeenCalled();
  });
});
