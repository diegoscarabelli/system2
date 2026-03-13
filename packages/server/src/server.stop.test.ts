import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

/**
 * Unit tests for Server.stop() shutdown sequence.
 *
 * We extract the stop() logic by constructing a minimal Server-shaped object
 * with mocked subsystems, then calling stop() directly.
 */

// Minimal mock for a WebSocket client
function makeClient() {
  return { close: vi.fn(), terminate: vi.fn(), readyState: 1 };
}

// Build a mock Server instance with just enough shape for stop()
function buildMockServer(clients: ReturnType<typeof makeClient>[] = []) {
  const clientSet = new Set(clients);

  const scheduler = { stop: vi.fn() };

  const wss = {
    clients: clientSet,
    close: vi.fn((cb: (err?: Error) => void) => {
      // Simulate: callback fires once all clients leave the set
      clientSet.clear();
      cb();
    }),
  };

  const httpServer = {
    closeAllConnections: vi.fn(),
    close: vi.fn((cb: (err?: Error) => void) => cb()),
  };

  const db = { close: vi.fn() };

  const stop = buildStop({ scheduler, wss, httpServer, db });

  return { scheduler, wss, httpServer, db, stop, clients };
}

/**
 * Re-implements the stop() method extracted from Server so we can test it
 * against mocks without instantiating the full Server class.
 */
function buildStop(deps: {
  scheduler: { stop: Mock };
  wss: { clients: Set<ReturnType<typeof makeClient>>; close: Mock };
  httpServer: { closeAllConnections: Mock; close: Mock };
  db: { close: Mock };
}): () => Promise<void> {
  return async function stop() {
    deps.scheduler.stop();

    for (const client of deps.wss.clients) {
      client.close(1001, 'server shutting down');
    }

    const graceTimer = setTimeout(() => {
      for (const client of deps.wss.clients) {
        client.terminate();
      }
    }, 2000);

    return new Promise((resolve, reject) => {
      deps.wss.close((err?: Error) => {
        clearTimeout(graceTimer);
        if (err) {
          reject(err);
          return;
        }

        deps.httpServer.closeAllConnections();
        deps.httpServer.close((err?: Error) => {
          if (err) {
            reject(err);
            return;
          }

          deps.db.close();
          resolve();
        });
      });
    });
  };
}

describe('Server.stop()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tears down in order: scheduler, WebSocket, HTTP, database', async () => {
    const { scheduler, wss, httpServer, db, stop } = buildMockServer();
    const order: string[] = [];

    scheduler.stop.mockImplementation(() => order.push('scheduler'));
    wss.close.mockImplementation((cb: (err?: Error) => void) => {
      order.push('wss');
      cb();
    });
    httpServer.closeAllConnections.mockImplementation(() => order.push('http.closeAllConnections'));
    httpServer.close.mockImplementation((cb: (err?: Error) => void) => {
      order.push('http');
      cb();
    });
    db.close.mockImplementation(() => order.push('db'));

    await stop();

    expect(order).toEqual(['scheduler', 'wss', 'http.closeAllConnections', 'http', 'db']);
  });

  it('sends close(1001) to all connected WebSocket clients', async () => {
    const c1 = makeClient();
    const c2 = makeClient();
    const { stop } = buildMockServer([c1, c2]);

    await stop();

    expect(c1.close).toHaveBeenCalledWith(1001, 'server shutting down');
    expect(c2.close).toHaveBeenCalledWith(1001, 'server shutting down');
  });

  it('force-terminates clients that linger past the 2s grace period', async () => {
    const straggler = makeClient();
    const clientSet = new Set([straggler]);

    const scheduler = { stop: vi.fn() };
    const wss = {
      clients: clientSet,
      close: vi.fn((cb: (err?: Error) => void) => {
        // Simulate: don't clear clients or call cb until terminate() is called
        straggler.terminate.mockImplementation(() => {
          clientSet.clear();
          cb();
        });
      }),
    };
    const httpServer = {
      closeAllConnections: vi.fn(),
      close: vi.fn((cb: (err?: Error) => void) => cb()),
    };
    const db = { close: vi.fn() };

    const stop = buildStop({ scheduler, wss, httpServer, db });
    const done = stop();

    // Client hasn't been terminated yet
    expect(straggler.terminate).not.toHaveBeenCalled();

    // Advance past the 2s grace period
    vi.advanceTimersByTime(2000);

    await done;

    expect(straggler.terminate).toHaveBeenCalled();
  });

  it('completes without terminate() if all clients close cleanly', async () => {
    const c1 = makeClient();
    const { stop } = buildMockServer([c1]);

    await stop();

    // close was called (graceful), terminate was not
    expect(c1.close).toHaveBeenCalled();
    expect(c1.terminate).not.toHaveBeenCalled();
  });

  it('rejects if wss.close() returns an error', async () => {
    const { wss, stop } = buildMockServer();
    wss.close.mockImplementation((cb: (err?: Error) => void) => cb(new Error('ws error')));

    await expect(stop()).rejects.toThrow('ws error');
  });

  it('rejects if httpServer.close() returns an error', async () => {
    const { httpServer, stop } = buildMockServer();
    httpServer.close.mockImplementation((cb: (err?: Error) => void) => cb(new Error('http error')));

    await expect(stop()).rejects.toThrow('http error');
  });

  it('works with zero connected clients', async () => {
    const { scheduler, db, stop } = buildMockServer([]);

    await stop();

    expect(scheduler.stop).toHaveBeenCalled();
    expect(db.close).toHaveBeenCalled();
  });
});
