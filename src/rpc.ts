import { ElectrumClient } from "@electrum-cash/network";
import type { Rpc } from "./chain";

// Public Fulcrum servers that answered over wss on 3 Nov 2026 (electroncash.de timed out).
export const SERVERS = ["bch.imaginary.cash", "bch.loping.net"];

// The connection failed, as opposed to an error the server answered with (that one carries the JSON-RPC error as its cause).
export class ConnectionError extends Error {}

export interface Conn extends Rpc {
  host: string;
  close(): void;
}

export type Connect = (host: string) => Promise<Conn>;

const connectTo: Connect = async (host) => {
  const client = new ElectrumClient("release-seal", "1.5.3", host);
  try {
    await Promise.race([client.connect(), new Promise((_, reject) => setTimeout(() => reject(new Error(`${host} timed out`)), 8000))]);
  } catch (e) {
    // a failed connect keeps retrying in the background otherwise
    client.disconnect(true).catch(() => {});
    throw e;
  }
  return {
    host,
    request: async (method, ...params) => {
      let r: unknown;
      try {
        r = await client.request(method, ...params);
      } catch (e) {
        throw new ConnectionError(String((e as Error).message ?? e));
      }
      if (r instanceof Error) throw r.cause === undefined ? new ConnectionError(r.message) : r;
      return r;
    },
    close: () => void client.disconnect(true).catch(() => {}),
  };
};

// One shared connection. When it drops (server restart, laptop asleep, tab left open), the next request closes it, moves that
// server to the back and retries once on a fresh connection, so a page left open does not stay broken until a reload.
export const makeRpc = (connect: Connect, servers: string[]) => {
  let order = [...servers];
  let open: Promise<Conn> | undefined;
  const get = () =>
    (open ??= (async () => {
      for (const host of order) {
        try {
          return await connect(host);
        } catch {
          // try the next server
        }
      }
      open = undefined;
      throw new Error("No Fulcrum server answered");
    })());
  const shared: Rpc = {
    request: async (method, ...params) => {
      for (let attempt = 0; ; attempt++) {
        const p = get();
        const conn = await p;
        try {
          return await conn.request(method, ...params);
        } catch (e) {
          if (!(e instanceof ConnectionError) || attempt > 0) throw e;
          if (open === p) {
            open = undefined;
            order = [...order.filter((h) => h !== conn.host), conn.host];
          }
          conn.close();
        }
      }
    },
  };
  return async () => {
    await get();
    return shared;
  };
};

export const rpc = makeRpc(connectTo, SERVERS);
