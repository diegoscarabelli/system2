import { Cron } from 'croner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger.js';
import { Scheduler } from './scheduler.js';

// Replace Cron so that constructing a job does not actually schedule a timer;
// we just want to capture the handler that the Scheduler hands to Croner and
// invoke it ourselves.
vi.mock('croner', () => ({
  Cron: vi.fn(function (
    this: { stop: () => void },
    _pattern: string,
    _handler: () => void | Promise<void>
  ) {
    this.stop = vi.fn();
  }),
}));

const cronMock = Cron as unknown as ReturnType<typeof vi.fn>;

describe('Scheduler.schedule', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cronMock.mockClear();
    vi.spyOn(log, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression test for https://github.com/diegoscarabelli/system2/issues/184:
  // a rejecting cron handler used to propagate out of Croner as an unhandled
  // promise rejection and crash the daemon (Node 25 default behavior).
  it('does not propagate rejections from job handlers (prevents daemon crash)', async () => {
    const scheduler = new Scheduler();
    const handlerError = new Error('boom');

    scheduler.schedule('test-job', '* * * * *', async () => {
      throw handlerError;
    });

    expect(cronMock).toHaveBeenCalledTimes(1);
    const wrappedHandler = cronMock.mock.calls[0][1] as () => Promise<void>;

    // The wrapped handler MUST resolve, not reject. If it rejected we'd crash
    // the daemon when Croner's _trigger awaited it without options.catch.
    await expect(wrappedHandler()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0];
    expect(String(args[0])).toContain('test-job');
    expect(args).toContain(handlerError);
  });

  it('does not log when handler resolves successfully', async () => {
    const scheduler = new Scheduler();
    scheduler.schedule('ok-job', '* * * * *', async () => {});

    const wrappedHandler = cronMock.mock.calls[0][1] as () => Promise<void>;
    await wrappedHandler();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('catches synchronously-thrown errors too', async () => {
    const scheduler = new Scheduler();
    const handlerError = new Error('sync boom');

    scheduler.schedule('sync-throw-job', '* * * * *', () => {
      throw handlerError;
    });

    const wrappedHandler = cronMock.mock.calls[0][1] as () => Promise<void>;
    await expect(wrappedHandler()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toContain(handlerError);
  });
});
