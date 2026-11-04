import { ElectrumClient } from "@electrum-cash/network";
import type { Rpc } from "./chain";

// Public Fulcrum servers (2.1.4) that answered every call the page makes over wss on 4 Nov 2026, one per operator;
// electroncash.de, bch0.kister.net and bch.cyberbits.eu timed out.
export const SERVERS = [
  "bch.imaginary.cash",
  "bch.loping.net",
  "electroncash.dk",
  "fulcrum.criptolayer.net",
  "bch.soul-dev.com",
  "fulcrum.greyh.at",
  "blackie.c3-soft.com",
];

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

// Servers are tried in order, but one that has not connected after `stagger` ms does not hold up the next: the next starts
// beside it, the first to connect is kept and any later one is closed. A hung server costs `stagger`, not the 8 s timeout.
const race = (connect: Connect, hosts: string[], stagger: number) =>
  new Promise<Conn>((resolve, reject) => {
    let next = 0;
    let failed = 0;
    let won = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      clearTimeout(timer);
      if (won || next >= hosts.length) return;
      connect(hosts[next++]).then(
        (conn) => {
          if (won) return conn.close();
          won = true;
          clearTimeout(timer);
          resolve(conn);
        },
        () => {
          if (++failed === hosts.length) reject(new Error("No Fulcrum server answered"));
          else start();
        },
      );
      timer = setTimeout(start, stagger);
    };
    start();
  });

// One shared connection. When it drops (server restart, laptop asleep, tab left open), the next request closes it, moves that
// server to the back and retries once on a fresh connection, so a page left open does not stay broken until a reload.
export const makeRpc = (connect: Connect, servers: string[], stagger = 2500) => {
  let order = [...servers];
  let open: Promise<Conn> | undefined;
  const get = () =>
    (open ??= race(connect, order, stagger).catch((e) => {
      open = undefined;
      throw e;
    }));
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
