// Reads a project's seal history from a Fulcrum (Electrum protocol) server.
// The category is the txid whose output 0 the genesis spent. Fulcrum has no spender index, so the walk reads the history of the
// address holding the NFT and follows each spend of it; when it moves to a new address (maintainer rotation), the walk
// continues on that address.
import {
  binToHex,
  decodeTransaction,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  type Transaction,
} from "@bitauth/libauth";
import { decodeRecord, type SealRecord } from "./seal";
import type { Utxo, WalletPath } from "./tx";

export interface Rpc {
  request(method: string, ...params: (string | number | boolean)[]): Promise<unknown>;
}

// "moved": the holder sent the NFT on without a seal record (a plain wallet send to a new maintainer).
export interface SealEvent extends Omit<SealRecord, "kind"> {
  kind: SealRecord["kind"] | "moved";
  txid: string;
  vout: number;
  height: number;
  commitment: string;
  publisher: string;
  revoked?: boolean;
}

interface HistoryItem {
  tx_hash: string;
  height: number;
}

const txCache = new Map<string, Transaction>();

export const getTx = async (rpc: Rpc, txid: string) => {
  const hit = txCache.get(txid);
  if (hit) return hit;
  const raw = await rpc.request("blockchain.transaction.get", txid);
  if (typeof raw !== "string") throw new Error(`Could not read transaction ${txid}`);
  const tx = decodeTransaction(hexToBin(raw));
  if (typeof tx === "string") throw new Error(tx);
  txCache.set(txid, tx);
  return tx;
};

const addressOf = (lock: Uint8Array) => {
  const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: "bitcoincash", tokenSupport: true });
  return typeof r === "string" ? r : r.address;
};

const history = async (rpc: Rpc, address: string) => {
  const h = await rpc.request("blockchain.address.get_history", address);
  if (!Array.isArray(h)) throw new Error(`Could not read history of ${address}`);
  return h as HistoryItem[];
};

// Each transaction read is a round trip (about 280 ms from Baku, 4 Nov) and a judge's own wallet address can hold hundreds, so a
// step reads only what can spend the current output (confirmed in its block or later, or in the mempool), CHUNK at once.
const CHUNK = 20;

export const walkProject = async (rpc: Rpc, category: string, maxSteps = 500): Promise<SealEvent[]> => {
  const parent = await getTx(rpc, category);
  let address = addressOf(parent.outputs[0].lockingBytecode);
  let current = { txid: category, vout: 0 };
  let currentHeight: number | undefined;
  const events: SealEvent[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const items = await history(rpc, address);
    // A mempool entry has height 0, or -1 when one of its parents is unconfirmed too (genesis right after the prep tx).
    currentHeight ??= items.find((i) => i.tx_hash === current.txid)?.height;
    const h = currentHeight;
    const candidates = items.filter((i) => h === undefined || i.height <= 0 || (h > 0 && i.height >= h));
    let next: { txid: string; height: number; rawHeight: number; tx: Transaction } | undefined;
    for (let at = 0; at < candidates.length && !next; at += CHUNK) {
      const chunk = candidates.slice(at, at + CHUNK);
      const txs = await Promise.all(chunk.map((i) => getTx(rpc, i.tx_hash)));
      const k = txs.findIndex((tx) =>
        tx.inputs.some((i) => binToHex(i.outpointTransactionHash) === current.txid && i.outpointIndex === current.vout),
      );
      if (k >= 0) next = { txid: chunk[k].tx_hash, height: Math.max(0, chunk[k].height), rawHeight: chunk[k].height, tx: txs[k] };
    }
    if (!next) break;
    // Our seal transactions keep the NFT at output 0; a wallet's own token send may put it anywhere. No NFT left: burned.
    const vout = next.tx.outputs.findIndex((o) => o.token?.nft && binToHex(o.token.category) === category);
    if (vout < 0) break;
    const out = next.tx.outputs[vout];
    const found = next.tx.outputs.map((o) => decodeRecord(o.lockingBytecode)).find(Boolean);
    // Any CashTokens NFT moves without records; only one that started with a seal record is a project.
    if (!found && !events.length) break;
    const record = found ?? { kind: "moved" as const, version: "", manifestUrl: "" };
    if (record.kind === "revoke") {
      const target = [...events].reverse().find((e) => e.kind === "release" && e.version === record.version);
      if (target) target.revoked = true;
    }
    const publisher = addressOf(out.lockingBytecode);
    events.push({ ...record, txid: next.txid, vout, height: next.height, commitment: binToHex(out.token!.nft!.commitment), publisher });
    address = publisher;
    current = { txid: next.txid, vout };
    currentHeight = next.rawHeight;
  }
  return events;
};

export interface FulcrumUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  token_data?: { category: string; amount: string; nft?: { capability: "none" | "mutable" | "minting"; commitment: string } };
}

export const listUnspent = async (rpc: Rpc, address: string) => {
  const r = await rpc.request("blockchain.address.listunspent", address, "include_tokens");
  if (!Array.isArray(r)) throw new Error(`Could not read coins of ${address}`);
  return (r as FulcrumUtxo[]).map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: BigInt(u.value),
    token: u.token_data
      ? {
          category: hexToBin(u.token_data.category),
          amount: BigInt(u.token_data.amount),
          nft: u.token_data.nft ? { capability: u.token_data.nft.capability, commitment: hexToBin(u.token_data.nft.commitment) } : undefined,
        }
      : undefined,
  }));
};

// Cashonize, Paytaca and Selene are HD wallets: a judge's coins sit on receive/n and change/n, rarely all on receive/0. Each chain
// the wallet shared is read until GAP addresses in a row have no history (the usual BIP44 gap), MAX addresses at most.
export const walletCoins = async (
  rpc: Rpc,
  lockAt: (chain: number, index: number) => Uint8Array | undefined,
  gap = 20,
  max = 200,
): Promise<Utxo[]> => {
  const chain = async (name: string, child: number) => {
    const found: Utxo[] = [];
    if (!lockAt(child, 0)) return found;
    let used = -1;
    for (let from = 0; from <= used + gap && from < max; ) {
      const to = Math.min(used + gap + 1, max);
      const batch = Array.from({ length: to - from }, (_, k) => ({ index: from + k, address: addressOf(lockAt(child, from + k)!) }));
      const seen = await Promise.all(batch.map(async (a) => (await history(rpc, a.address)).length > 0));
      const hit = batch.filter((_, k) => seen[k]);
      if (hit.length) used = hit[hit.length - 1].index;
      const coins = await Promise.all(
        hit.map(async (a) =>
          (await listUnspent(rpc, a.address)).map((u): Utxo => ({ ...u, lock: lockAt(child, a.index), path: [name, a.index] as WalletPath })),
        ),
      );
      found.push(...coins.flat());
      from = to;
    }
    return found;
  };
  return (await Promise.all([chain("receive", 0), chain("change", 1)])).flat();
};

export interface HeldProject {
  category: string;
  kind: SealEvent["kind"];
  version: string;
  txid: string;
}

// Projects the publisher holds. After a seal the NFT sits at output 0 of a transaction whose record names the last step (a
// genesis record carries the project name). A project handed over by a plain wallet send has no record and may sit at any
// output: it counts only if the project's own walk ends at this very coin, and it is listed by its name as "moved".
export const heldProjects = async (
  rpc: Rpc,
  coins: { txid: string; vout: number; token?: { category: Uint8Array; nft?: { capability: string } } }[],
): Promise<HeldProject[]> => {
  const held = coins.filter((c) => c.token?.nft?.capability === "mutable");
  const found = await Promise.all(
    held.map(async (c) => {
      const category = binToHex(c.token!.category);
      const tx = await getTx(rpc, c.txid);
      const record = tx.outputs.map((o) => decodeRecord(o.lockingBytecode)).find(Boolean);
      if (record && c.vout === 0) return { category, kind: record.kind, version: record.version, txid: c.txid };
      const events = await walkProject(rpc, category).catch(() => []);
      const last = events.at(-1);
      if (events[0]?.kind !== "genesis" || last?.txid !== c.txid || last.vout !== c.vout) return undefined;
      return { category, kind: "moved" as const, version: events[0].version, txid: c.txid };
    }),
  );
  return found.filter((p): p is HeldProject => !!p);
};

// The wallet is asked to broadcast, but a wallet may only sign, so the page sends the signed transaction too.
// A node that already has it answers "txn-already-known" or "transaction already in block chain"; both mean it is out.
export const broadcast = async (rpc: Rpc, signedHex: string) => {
  const txid = hashTransaction(hexToBin(signedHex));
  try {
    const r = await rpc.request("blockchain.transaction.broadcast", signedHex);
    if (r !== txid) throw new Error(`Server answered ${String(r)} instead of txid ${txid}`);
  } catch (e) {
    if (!/already[- ](known|in block ?chain)/i.test(String((e as Error).message ?? e))) throw e;
  }
  return txid;
};
