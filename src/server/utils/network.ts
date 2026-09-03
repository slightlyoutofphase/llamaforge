/**
 * @packageDocumentation
 * Utilities for network interfaces.
 */

/**
 * Finds a free port within the given range.
 * @param minPort lowest port to try
 * @param maxPort highest port to try
 * @returns A promise that resolves to an available port number.
 * @throws Error if no ports are available in the range.
 */
export async function findFreePort(minPort: number, maxPort: number): Promise<number> {
  /**
   * Tests whether a single TCP port can be bound on the loopback interface.
   *
   * @param port - Candidate port to probe.
   * @returns `true` when the port is currently free.
   */
  const isPortFree = async (port: number): Promise<boolean> => {
    try {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      });
      listener.stop();
      return true;
    } catch {
      return false;
    }
  };

  for (let port = minPort; port <= maxPort; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(`No free ports available in range ${minPort}-${maxPort}`);
}
