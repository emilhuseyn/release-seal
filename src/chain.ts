// Reads a project's seal history from a Fulcrum (Electrum protocol) server.
// The category is the txid whose output 0 the genesis spent. Fulcrum has no spender index, so the walk reads the history of the
// address holding the NFT and follows each spend of output 0; when output 0 moves to a new address (maintainer rotation),
// the walk continues on that address.
import {
  binToHex,
  decodeTransaction,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  type Transaction,
} from "@bitauth/libauth";
import { decodeRecord, type SealRecord } from "./seal";

export interface Rpc {
  request(method: string, ...params: (string | number | boolean)[]): Promise<unknown>;
}

export interface SealEvent extends SealRecord {
  txid: string;
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

export const walkProject = async (rpc: Rpc, category: string, maxSteps = 500): Promise<SealEvent[]> => {
  const parent = await getTx(rpc, category);
  let address = addressOf(parent.outputs[0].lockingBytecode);
  let current = { txid: category, vout: 0 };
  const events: SealEvent[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const items = await history(rpc, address);
    let next: { txid: string; height: number; tx: Transaction } | undefined;
    for (const item of items) {
      const tx = await getTx(rpc, item.tx_hash);
      const spends = tx.inputs.some((i) => binToHex(i.outpointTransactionHash) === current.txid && i.outpointIndex === current.vout);
      if (spends) {
        // A mempool entry has height 0, or -1 when one of its parents is unconfirmed too (genesis right after the prep tx).
        next = { txid: item.tx_hash, height: Math.max(0, item.height), tx };
        break;
      }
    }
    if (!next) break;
    const out0 = next.tx.outputs[0];
    const nft = out0?.token?.nft;
    if (!out0 || !nft || binToHex(out0.token!.category) !== category) break;
    const record = next.tx.outputs.map((o) => decodeRecord(o.lockingBytecode)).find(Boolean);
    if (!record) break;
    if (record.kind === "revoke") {
      const target = [...events].reverse().find((e) => e.kind === "release" && e.version === record.version);
      if (target) target.revoked = true;
    }
    const publisher = addressOf(out0.lockingBytecode);
    events.push({ ...record, txid: next.txid, height: next.height, commitment: binToHex(nft.commitment), publisher });
    address = publisher;
    current = { txid: next.txid, vout: 0 };
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
