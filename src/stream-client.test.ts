import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const spawnedChildren: Array<EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
}> = [];

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    child.kill.mockImplementation(() => {
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    });
    spawnedChildren.push(child);
    return child;
  }),
}));

import { EigenFluxStreamClient } from './stream-client';
import { Logger } from './logger';

test('keeps retrying at capped backoff after more than twenty failures', async () => {
  jest.useFakeTimers();
  spawnedChildren.length = 0;
  const baseLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const logger = new Logger(baseLogger as any);
  const client = new EigenFluxStreamClient({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    logger,
    onPmEvent: jest.fn().mockResolvedValue(undefined),
    onAuthRequired: jest.fn().mockResolvedValue(undefined),
  });

  await client.start();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    spawnedChildren[attempt].emit('exit', 1, null);
    jest.runOnlyPendingTimers();
  }

  expect(client.isRunning()).toBe(true);
  expect(spawnedChildren).toHaveLength(26);
  expect(baseLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('giving up'));
  const stopping = client.stop();
  jest.runAllTimers();
  await stopping;
  jest.useRealTimers();
});
