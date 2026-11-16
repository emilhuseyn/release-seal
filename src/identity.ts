// BCH <-> Nostr identity link. Built on NIP-39 ("i" tags in a kind 10011 event) with Bitcoin Cash as the proof platform:
// - the BCH side is a transaction whose input 0 spends a coin of the address and whose OP_RETURN carries NIP-39's own
//   verification text naming the npub (only the holder of that address's key can make it);
// - the Nostr side is the kind 10011 event, signed by the Nostr key, with ["i", "bch:<address>", "<txid of that proof>"].
// Each key signs only for itself; neither side sees or reuses the other's private key. Anyone holding either half finds the
// other: from an npub through any relay, from an address through its own transaction history on any Fulcrum server.
import {
  binToHex,
  binToUtf8,
  cashAddressToLockingBytecode,
  encodeDataPush,
  encodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  Opcodes,
  utf8ToBin,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import { nip19, verifyEvent, type Event, type EventTemplate } from "nostr-tools";
import { getTx, history, type Rpc } from "./chain";
import { opReturnPushes } from "./seal";
import type { Utxo, WalletPath } from "./tx";

export const LINK_PREFIX = "nip39";
export const PLATFORM = "bch";
export const EXTERNAL_IDENTITIES = 10011;
export const AUTH_KIND = 22242;
const PROOF = "Verifying that I control the following Nostr public key: ";
const REVOKE = "Revoking my link to the following Nostr public key: ";

export const npubOf = (pubkey: string) => nip19.npubEncode(pubkey);

// A hex key, an npub or an nprofile, as people paste them; undefined for anything else.
export const pubkeyFrom = (text: string): string | undefined => {
  const t = text.trim().replace(/^nostr:/, "");
  if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  try {
    const d = nip19.decode(t);
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    // not bech32
  }
  return undefined;
};

// --- the BCH half -------------------------------------------------------------------------------------------------------

export const proofText = (pubkey: string) => PROOF + npubOf(pubkey);

export const encodeLink = (pubkey: string, revoke = false) => {
  const text = utf8ToBin((revoke ? REVOKE : PROOF) + npubOf(pubkey));
  return Uint8Array.from([Opcodes.OP_RETURN, ...encodeDataPush(utf8ToBin(LINK_PREFIX)), ...encodeDataPush(text)]);
};

export const decodeLink = (script: Uint8Array): { pubkey: string; revoke: boolean } | undefined => {
  const pushes = opReturnPushes(script);
  if (!pushes || pushes.length !== 2 || binToUtf8(pushes[0]) !== LINK_PREFIX) return undefined;
  const text = binToUtf8(pushes[1]);
  const revoke = text.startsWith(REVOKE);
  if (!revoke && !text.startsWith(PROOF)) return undefined;
  const pubkey = pubkeyFrom(text.slice((revoke ? REVOKE : PROOF).length));
  return pubkey ? { pubkey, revoke } : undefined;
};

// The address an identity is shown and tagged by: the plain q form without its prefix, the way NIP-39 normalises names.
export const addressName = (lock: Uint8Array) => {
  const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: "bitcoincash" });
  if (typeof r === "string") throw new Error(r);
  return r.address.replace(/^bitcoincash:/, "");
};

// Any mainnet form people paste (q or z, with or without the prefix) to its locking bytecode.
export const lockFromAddress = (address: string) => {
  const a = address.trim().toLowerCase();
  const r = cashAddressToLockingBytecode(a.includes(":") ? a : `bitcoincash:${a}`);
  if (typeof r === "string" || r.prefix !== "bitcoincash") throw new Error("Not a Bitcoin Cash mainnet address");
  return r.bytecode;
};

const P2PKH_UNLOCK_SIZE = 108;
const DUST = 546n;
const largestFirst = (coins: Utxo[]) => [...coins].sort((a, b) => (a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1));
const sizeOf = (tx: Transaction) =>
  encodeTransaction({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array(P2PKH_UNLOCK_SIZE) })) }).length;

export interface PlannedTx {
  transaction: Transaction;
  sourceOutputs: Output[];
  paths: WalletPath[];
  fee: bigint;
  lock: Uint8Array;
}

// The link (or revoke) transaction. The identity is the address of input 0, the wallet's largest plain coin; only coins of
// that address are spent and the change goes back to it, so the address keeps its funds and can be paid by identity later.
export const buildLinkTx = ({ pubkey, funding, revoke = false, feeRate = 1n }: { pubkey: string; funding: Utxo[]; revoke?: boolean; feeRate?: bigint }): PlannedTx => {
  const plain = largestFirst(funding.filter((u) => !u.token && u.lock));
  if (!plain.length) throw new Error("No BCH in this wallet yet. A link costs a few hundred satoshis in fees.");
  const lock = plain[0].lock!;
  const own = plain.filter((u) => binToHex(u.lock!) === binToHex(lock));
  const record: Output = { lockingBytecode: encodeLink(pubkey, revoke), valueSatoshis: 0n };
  for (let n = 1; n <= own.length; n++) {
    const coins = own.slice(0, n);
    const inputs = coins.map((u) => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }));
    const total = coins.reduce((s, u) => s + u.satoshis, 0n);
    const withChange: Transaction = { version: 2, locktime: 0, inputs, outputs: [record, { lockingBytecode: lock, valueSatoshis: 0n }] };
    const fee = BigInt(sizeOf(withChange)) * feeRate;
    const sourceOutputs = coins.map((u) => ({ lockingBytecode: u.lock!, valueSatoshis: u.satoshis }));
    const paths = coins.map((u) => u.path ?? (["receive", 0] as WalletPath));
    if (total - fee >= DUST) {
      withChange.outputs[1].valueSatoshis = total - fee;
      return { transaction: withChange, sourceOutputs, paths, fee, lock };
    }
    const bare: Transaction = { ...withChange, outputs: [record] };
    if (total >= BigInt(sizeOf(bare)) * feeRate) return { transaction: bare, sourceOutputs, paths, fee: total, lock };
  }
  throw new Error("Not enough BCH on one address of this wallet for the link fee");
};

// A plain payment to someone found by their identity: largest coins first, change back to the payer's receive/0.
export const buildPayTx = ({ to, amount, funding, changeLock, feeRate = 1n }: { to: Uint8Array; amount: bigint; funding: Utxo[]; changeLock: Uint8Array; feeRate?: bigint }): PlannedTx => {
  if (amount < DUST) throw new Error(`The smallest payment is ${DUST} sats`);
  const coins = largestFirst(funding.filter((u) => !u.token));
  for (let n = 1; n <= coins.length; n++) {
    const use = coins.slice(0, n);
    const inputs = use.map((u) => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }));
    const total = use.reduce((s, u) => s + u.satoshis, 0n);
    const tx: Transaction = { version: 2, locktime: 0, inputs, outputs: [{ lockingBytecode: to, valueSatoshis: amount }, { lockingBytecode: changeLock, valueSatoshis: 0n }] };
    const fee = BigInt(sizeOf(tx)) * feeRate;
    const sourceOutputs = use.map((u) => ({ lockingBytecode: u.lock ?? changeLock, valueSatoshis: u.satoshis }));
    const paths = use.map((u) => u.path ?? (["receive", 0] as WalletPath));
    if (total - amount - fee >= DUST) {
      tx.outputs[1].valueSatoshis = total - amount - fee;
      return { transaction: tx, sourceOutputs, paths, fee, lock: to };
    }
    const bare: Transaction = { ...tx, outputs: [tx.outputs[0]] };
    const bareFee = BigInt(sizeOf(bare)) * feeRate;
    if (total - amount >= bareFee) return { transaction: bare, sourceOutputs, paths, fee: total - amount, lock: to };
  }
  throw new Error("Not enough BCH in the wallet for this payment and its fee");
};

export interface LinkRecord {
  txid: string;
  height: number;
  pubkey: string;
  revoke: boolean;
}

// A transaction's link record, if it carries one and its input 0 spends a coin of `lock` (the proof of control).
export const readLinkTx = async (rpc: Rpc, txid: string, lock: Uint8Array): Promise<Omit<LinkRecord, "height"> | undefined> => {
  const tx = await getTx(rpc, txid);
  const rec = tx.outputs.map((o) => decodeLink(o.lockingBytecode)).find(Boolean);
  if (!rec || !tx.inputs.length) return undefined;
  const first = tx.inputs[0];
  const prev = await getTx(rpc, binToHex(first.outpointTransactionHash));
  const spent = prev.outputs[first.outpointIndex];
  if (!spent || binToHex(spent.lockingBytecode) !== binToHex(lock)) return undefined;
  return { txid, ...rec };
};

const CHUNK = 20;

// Every link record an address has made, oldest first (mempool last). Only transactions in blocks at or after `from` are read,
// CHUNK at once, and at most `max`, so an everyday wallet address with a long history stays quick.
export const linkRecords = async (rpc: Rpc, address: string, from = 0, max = 400): Promise<LinkRecord[]> => {
  const lock = lockFromAddress(address);
  const h = (await history(rpc, `bitcoincash:${addressName(lock)}`))
    .filter((e) => e.height <= 0 || e.height >= from)
    .sort((a, b) => (a.height <= 0 ? Infinity : a.height) - (b.height <= 0 ? Infinity : b.height))
    .slice(-max);
  const out: LinkRecord[] = [];
  for (let i = 0; i < h.length; i += CHUNK) {
    const part = await Promise.all(h.slice(i, i + CHUNK).map(async (e) => {
      const r = await readLinkTx(rpc, e.tx_hash, lock).catch(() => undefined);
      return r && { ...r, height: Math.max(0, e.height) };
    }));
    out.push(...part.filter((r): r is LinkRecord => !!r));
  }
  return out;
};

// The Nostr key an address points at now: its latest link, unless a later revoke of that key cleared it.
export const currentKey = (records: LinkRecord[]) => {
  const last = records.at(-1);
  return last && !last.revoke ? last : undefined;
};

// nostr-tools caches a verdict on the event object under a symbol, and a spread copy carries it along, so a copy changed after
// verifying would pass. Only the seven NIP-01 fields are checked, on a fresh object.
export const signedBy = (e: Event) =>
  verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig } as Event);

// --- the Nostr half -----------------------------------------------------------------------------------------------------

export interface NostrIO {
  query(filter: { kinds: number[]; authors: string[] }): Promise<Event[]>;
  publish(event: Event): Promise<string[]>;
}

export const latestIdentities = async (io: NostrIO, pubkey: string) =>
  (await io.query({ kinds: [EXTERNAL_IDENTITIES], authors: [pubkey] }))
    .filter((e) => e.pubkey === pubkey && e.kind === EXTERNAL_IDENTITIES && signedBy(e))
    .sort((a, b) => b.created_at - a.created_at)[0];

export const bchClaims = (e: Event | undefined) =>
  (e?.tags ?? []).filter((t) => t[0] === "i" && t[1]?.startsWith(`${PLATFORM}:`) && t[2]).map((t) => ({ address: t[1].slice(PLATFORM.length + 1), txid: t[2] }));

// The kind 10011 event to sign: the user's other identities are kept, earlier bch claims are replaced by this one (or dropped,
// to unlink).
export const identitiesTemplate = (previous: Event | undefined, claim: { address: string; txid: string } | undefined, now = Math.floor(Date.now() / 1000)): EventTemplate => ({
  kind: EXTERNAL_IDENTITIES,
  created_at: Math.max(now, (previous?.created_at ?? 0) + 1),
  content: previous?.content ?? "",
  tags: [...(previous?.tags ?? []).filter((t) => !(t[0] === "i" && t[1]?.startsWith(`${PLATFORM}:`))), ...(claim ? [["i", `${PLATFORM}:${claim.address}`, claim.txid]] : [])],
});

// --- verification -------------------------------------------------------------------------------------------------------

export interface Check {
  label: string;
  ok: boolean;
}

export interface Verdict {
  pubkey: string;
  address?: string;
  txid?: string;
  height?: number;
  verified: boolean;
  checks: Check[];
}

// Starting from a Nostr key: its signed claim, the proof transaction it names, and the address's own latest record.
export const verifyFromNostr = async (rpc: Rpc, io: NostrIO, pubkey: string, max = 400): Promise<Verdict> => {
  const event = await latestIdentities(io, pubkey);
  const checks: Check[] = [{ label: "Signed NIP-39 identity list (kind 10011) found on the relays", ok: !!event }];
  const claim = bchClaims(event)[0];
  checks.push({ label: "It claims a Bitcoin Cash address with a proof transaction", ok: !!claim });
  if (!claim) return { pubkey, verified: false, checks };
  let lock: Uint8Array;
  try {
    lock = lockFromAddress(claim.address);
  } catch {
    checks.push({ label: "The claimed address is a mainnet address", ok: false });
    return { pubkey, address: claim.address, txid: claim.txid, verified: false, checks };
  }
  const address = addressName(lock);
  const proof = await readLinkTx(rpc, claim.txid, lock).catch(() => undefined);
  checks.push({ label: "The proof transaction spends a coin of that address (only its key could sign it)", ok: !!proof });
  checks.push({ label: "Its OP_RETURN carries the NIP-39 verification text for this npub", ok: !!proof && !proof.revoke && proof.pubkey === pubkey });
  const records = proof ? await linkRecords(rpc, address, 0, max).catch(() => []) : [];
  const now = currentKey(records);
  checks.push({ label: "The address has not linked another key or revoked this one since", ok: !!now && now.pubkey === pubkey });
  return { pubkey, address, txid: claim.txid, height: records.find((r) => r.txid === claim.txid)?.height, verified: checks.every((c) => c.ok), checks };
};

// Starting from a BCH address: its own latest record names the key, and that key's signed claim must name the address back.
// `max` bounds how much of the address history is read (the newest entries), for pages that check many addresses.
export const verifyFromAddress = async (rpc: Rpc, io: NostrIO, address: string, max = 400): Promise<Verdict | undefined> => {
  const name = addressName(lockFromAddress(address));
  const now = currentKey(await linkRecords(rpc, name, 0, max));
  if (!now) return undefined;
  const v = await verifyFromNostr(rpc, io, now.pubkey, max);
  const back = v.address === name;
  return { ...v, address: name, txid: now.txid, height: now.height, verified: v.verified && back, checks: [...v.checks, { label: "The key's signed claim names this address back", ok: back }] };
};

// --- sign-in --------------------------------------------------------------------------------------------------------------

export const newChallenge = () => binToHex(crypto.getRandomValues(new Uint8Array(32)));

// The NIP-42 auth event shape, with the app's origin where a relay URL would go.
export const authTemplate = (challenge: string, origin: string, now = Math.floor(Date.now() / 1000)): EventTemplate => ({
  kind: AUTH_KIND,
  created_at: now,
  content: "",
  tags: [
    ["relay", origin],
    ["challenge", challenge],
  ],
});

export const checkAuth = (e: Event, challenge: string, origin: string, now = Math.floor(Date.now() / 1000), maxAge = 600) => {
  const tag = (k: string) => e.tags.find((t) => t[0] === k)?.[1];
  if (e.kind !== AUTH_KIND) return "Not a sign-in event";
  if (tag("challenge") !== challenge) return "The signed challenge is not the one this app issued";
  if (tag("relay") !== origin) return "The event was signed for another app";
  if (Math.abs(now - e.created_at) > maxAge) return "The signature is too old";
  if (!signedBy(e)) return "The signature does not verify";
  return undefined;
};
