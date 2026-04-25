/**
 * @packageDocumentation
 * Utilities for network interfaces.
 */
import net from "node:net";

/**
 * Finds a free port within the given range.
 * @param minPort lowest port to try
 * @param maxPort highest port to try
 * @returns A promise that resolves to an available port number.
 * @throws Error if no ports are available in the range.
 */
export async function findFreePort(minPort: number, maxPort: number): Promise<number> {
  const isPortFree = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
      server.on("error", () => resolve(false));
    });
  };

  for (let port = minPort; port <= maxPort; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(`No free ports available in range ${minPort}-${maxPort}`);
}
