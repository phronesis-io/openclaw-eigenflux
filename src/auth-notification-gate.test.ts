import { AuthNotificationGate } from './auth-notification-gate';

afterEach(() => jest.restoreAllMocks());

test('successful reminders expire after a short cooldown', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  const gate = new AuthNotificationGate();
  const notify = jest.fn().mockResolvedValue(true);

  await expect(gate.deliver(notify)).resolves.toBe(true);
  await expect(gate.deliver(notify)).resolves.toBe(false);
  expect(notify).toHaveBeenCalledTimes(1);

  now.mockReturnValue(1000 + 5 * 60 * 1000);
  await expect(gate.deliver(notify)).resolves.toBe(true);
  expect(notify).toHaveBeenCalledTimes(2);
});

test('a failed or thrown delivery remains retryable', async () => {
  const gate = new AuthNotificationGate();
  const notify = jest.fn()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('host unavailable'))
    .mockResolvedValueOnce(true);

  await expect(gate.deliver(notify)).resolves.toBe(false);
  await expect(gate.deliver(notify)).rejects.toThrow('host unavailable');
  await expect(gate.deliver(notify)).resolves.toBe(true);
  expect(notify).toHaveBeenCalledTimes(3);
});

test('coalesces concurrent sources without marking pending delivery successful', async () => {
  const gate = new AuthNotificationGate();
  let finish!: (delivered: boolean) => void;
  const notify = jest.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
    finish = resolve;
  })).mockResolvedValueOnce(true);

  const first = gate.deliver(notify);
  await expect(gate.deliver(notify)).resolves.toBe(false);
  expect(notify).toHaveBeenCalledTimes(1);
  finish(false);
  await expect(first).resolves.toBe(false);
  await expect(gate.deliver(notify)).resolves.toBe(true);
});

test('a successful authenticated poll resets the notification gate', async () => {
  const gate = new AuthNotificationGate();
  const notify = jest.fn().mockResolvedValue(true);
  await gate.deliver(notify);
  gate.reset();
  await expect(gate.deliver(notify)).resolves.toBe(true);
  expect(notify).toHaveBeenCalledTimes(2);
});

test('each Home and server runtime owns its own notification gate', async () => {
  const first = new AuthNotificationGate();
  const second = new AuthNotificationGate();
  const notify = jest.fn().mockResolvedValue(true);
  await first.deliver(notify);
  await expect(second.deliver(notify)).resolves.toBe(true);
  expect(notify).toHaveBeenCalledTimes(2);
});
