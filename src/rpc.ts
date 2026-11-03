import { ElectrumClient } from "@electrum-cash/network";
import type { Rpc } from "./chain";

// Public Fulcrum servers that answered over wss on 3 Nov 2026 (electroncash.de timed out).
export const SERVERS = ["bch.imaginary.cash", "bch.loping.net"];

let open: Promise<Rpc> | undefined;

const connectTo = async (host: string): Promise<Rpc> => {
  const client = new ElectrumClient("release-seal", "1.5.3", host);
  await Promise.race([client.connect(), new Promise((_, reject) => setTimeout(() => reject(new Error(`${host} timed out`)), 8000))]);
  return {
    request: async (method, ...params) => {
      const r = await client.request(method, ...params);
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

export const rpc = () =>
  (open ??= (async () => {
    for (const host of SERVERS) {
      try {
        return await connectTo(host);
      } catch {
        // try the next server
      }
    }
    open = undefined;
    throw new Error("No Fulcrum server answered");
  })());
