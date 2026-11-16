// Browser side of Nostr for the identity page: public relays through nostr-tools' pool, and a signer that is either the user's
// NIP-07 extension or a key generated and kept in this browser. No key ever leaves the browser or reaches a server of ours.
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool, type Event, type EventTemplate } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { NostrIO } from "./identity";

export const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band"];

let pool: SimplePool | undefined;
const thePool = () => (pool ??= new SimplePool());

export const relays: NostrIO = {
  query: (filter) => thePool().querySync(RELAYS, filter, { maxWait: 5000 }),
  publish: async (event) => {
    const r = await Promise.allSettled(thePool().publish(RELAYS, event));
    return RELAYS.filter((_, i) => r[i].status === "fulfilled");
  },
};

export interface Signer {
  pubkey: string;
  via: "extension" | "browser";
  sign(t: EventTemplate): Promise<Event>;
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<Event>;
}

export const extension = () => (window as unknown as { nostr?: Nip07 }).nostr;

export const extensionSigner = async (): Promise<Signer> => {
  const n = extension();
  if (!n) throw new Error("No Nostr extension (NIP-07) in this browser");
  const pubkey = await n.getPublicKey();
  return { pubkey, via: "extension", sign: (t) => n.signEvent(t) };
};

const KEY = "release-seal-nostr-key";

const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

// The key made here stays in this browser's storage until the user forgets it; the page shows its nsec so it can be saved.
export const browserSigner = (create: boolean): (Signer & { nsec: string }) | undefined => {
  let hex = storage()?.getItem(KEY) ?? "";
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    if (!create) return undefined;
    hex = bytesToHex(generateSecretKey());
    try {
      storage()?.setItem(KEY, hex);
    } catch {
      // a private window may refuse storage; the key then lasts for this page only
    }
  }
  const sk = hexToBytes(hex);
  return { pubkey: getPublicKey(sk), via: "browser", nsec: nip19.nsecEncode(sk), sign: async (t) => finalizeEvent(t, sk) };
};

export const forgetBrowserKey = () => {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // nothing stored
  }
};
