import { KeyedDeliveryCoordinator } from './delivery-coordinator';

describe('KeyedDeliveryCoordinator', () => {
  test('serializes the same key', async () => {
    const coordinator = new KeyedDeliveryCoordinator(2);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = coordinator.run('conv-1', async () => {
      order.push('first:start');
      markFirstStarted();
      await firstGate;
      order.push('first:end');
    });
    const second = coordinator.run('conv-1', async () => {
      order.push('second:start');
    });

    await firstStarted;
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('caps concurrency across different keys', async () => {
    const coordinator = new KeyedDeliveryCoordinator(1);
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = coordinator.run('conv-1', async () => {
      active += 1;
      peak = Math.max(peak, active);
      markFirstStarted();
      await firstGate;
      active -= 1;
    });
    const second = coordinator.run('conv-2', async () => {
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
    });

    await firstStarted;
    expect(peak).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });
});
