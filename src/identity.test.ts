// Identity link tests: real signed BCH transactions (throwaway keys, dummy coins) checked in libauth's BCH VM, real signed Nostr
// events, a fake Fulcrum and a fake relay served from memory.
import {
  binToHex,
  createVirtualMachineBCH,
  encodeTransaction,
  hashTransactionUiOrder,
  hexToBin,
  lockingBytecodeToCashAddress,
  publicKeyToP2pkhLockingBytecode,
  secp256k1,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import { finalizeEvent, getPublicKey, nip19, type Event } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { Rpc } from "./chain";
import {
  addressName,
  authTemplate,
  bchClaims,
  buildLinkTx,
  buildPayTx,
  checkAuth,
  decodeLink,
  encodeLink,
  identitiesTemplate,
  latestIdentities,
  lockFromAddress,
  proofText,
  pubkeyFrom,
  verifyFromAddress,
  verifyFromNostr,
  type NostrIO,
} from "./identity";
import type { Utxo } from "./tx";

const keyA = hexToBin("41".repeat(32));
const keyB = hexToBin("42".repeat(32));
const lockOf = (k: Uint8Array) => publicKeyToP2pkhLockingBytecode({ publicKey: secp256k1.derivePublicKeyCompressed(k) as Uint8Array });
const lockA = lockOf(keyA);
const lockB = lockOf(keyB);
const qAddr = (l: Uint8Array) => (lockingBytecodeToCashAddress({ bytecode: l, prefix: "bitcoincash" }) as { address: string }).address;
const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
const vm = createVirtualMachineBCH();

const nsec1 = hexToBin("51".repeat(32));
const nsec2 = hexToBin("52".repeat(32));
const npk1 = getPublicKey(nsec1);
const npk2 = getPublicKey(nsec2);

const sign = (transaction: Transaction, sourceOutputs: Output[], k: Uint8Array) => {
  const signed = { ...transaction, inputs: transaction.inputs.map((i) => ({ ...i })) };
  signed.inputs.forEach((input, inputIndex) => {
    const r = compiler.generateBytecode({ data: { keys: { privateKeys: { key: k } }, compilationContext: { inputIndex, sourceOutputs, transaction: signed } }, scriptId: "unlock" });
    if (!r.success) throw new Error(JSON.stringify(r.errors));
    input.unlockingBytecode = r.bytecode;
  });
  const ok = vm.verify({ transaction: signed, sourceOutputs });
  if (ok !== true) throw new Error(String(ok));
  return signed;
};

// A fake Fulcrum: transactions by id, history by address.
const chain = () => {
  const store = new Map<string, string>();
  const hist = new Map<string, { tx_hash: string; height: number }[]>();
  const put = (tx: Transaction, height: number, locks: Uint8Array[]) => {
    const raw = encodeTransaction(tx);
    const txid = binToHex(hashTransactionUiOrder(raw));
    store.set(txid, binToHex(raw));
    for (const l of locks) hist.set(qAddr(l), [...(hist.get(qAddr(l)) ?? []), { tx_hash: txid, height }]);
    return txid;
  };
  const rpc: Rpc = {
    request: async (method, ...params) => {
      if (method === "blockchain.transaction.get") return store.get(params[0] as string);
      if (method === "blockchain.address.get_history") return hist.get(params[0] as string) ?? [];
      throw new Error(method);
    },
  };
  // a coin of `lock`, in a parent transaction the fake chain knows
  let n = 0;
  const coin = (lock: Uint8Array, satoshis: bigint, height = 900_000): Utxo => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin((++n).toString(16).padStart(64, "0")), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: satoshis }],
    };
    return { txid: put(parent, height, [lock]), vout: 0, satoshis, lock, path: ["receive", n] };
  };
  // signs and stores a link (or revoke) made from `coins`, all on one address with key k
  const link = (pubkey: string, coins: Utxo[], k: Uint8Array, height: number, revoke = false) => {
    const u = buildLinkTx({ pubkey, funding: coins, revoke });
    return put(sign(u.transaction, u.sourceOutputs, k), height, [u.lock]);
  };
  return { rpc, put, coin, link };
};

// A fake relay set holding signed events.
const relay = (events: Event[] = []): NostrIO & { events: Event[] } => ({
  events,
  query: async (f) => events.filter((e) => f.kinds.includes(e.kind) && f.authors.includes(e.pubkey)),
  publish: async (e) => {
    events.push(e);
    return ["wss://fake"];
  },
});

const claimEvent = (nsec: Uint8Array, address: string, txid: string, previous?: Event, at = 1_800_000_000) =>
  finalizeEvent(identitiesTemplate(previous, { address, txid }, at), nsec);

describe("link record", () => {
  it("carries NIP-39's verification text for the npub, and reads back", () => {
    const script = encodeLink(npk1);
    expect(proofText(npk1)).toBe(`Verifying that I control the following Nostr public key: ${nip19.npubEncode(npk1)}`);
    expect(new TextDecoder().decode(script)).toContain(proofText(npk1));
    expect(script.length).toBeLessThanOrEqual(223);
    expect(decodeLink(script)).toEqual({ pubkey: npk1, revoke: false });
    expect(decodeLink(encodeLink(npk1, true))).toEqual({ pubkey: npk1, revoke: true });
  });

  it("ignores other OP_RETURN data", () => {
    const other = Uint8Array.from([0x6a, 5, ...new TextEncoder().encode("nip39"), 3, 1, 2, 3]);
    expect(decodeLink(other)).toBeUndefined();
    expect(decodeLink(Uint8Array.from([0x6a, 5, ...new TextEncoder().encode("RSEAL")]))).toBeUndefined();
    expect(decodeLink(lockA)).toBeUndefined();
  });

  it("reads a key pasted as hex, npub, nprofile or nostr: link", () => {
    expect(pubkeyFrom(npk1.toUpperCase())).toBe(npk1);
    expect(pubkeyFrom(nip19.npubEncode(npk1))).toBe(npk1);
    expect(pubkeyFrom(`nostr:${nip19.nprofileEncode({ pubkey: npk1, relays: ["wss://nos.lol"] })}`)).toBe(npk1);
    expect(pubkeyFrom("npub1notakey")).toBeUndefined();
    expect(pubkeyFrom(nip19.noteEncode(npk1))).toBeUndefined();
  });

  it("takes q or z addresses, with or without the prefix", () => {
    const z = (lockingBytecodeToCashAddress({ bytecode: lockA, prefix: "bitcoincash", tokenSupport: true }) as { address: string }).address;
    expect(binToHex(lockFromAddress(z))).toBe(binToHex(lockA));
    expect(binToHex(lockFromAddress(addressName(lockA)))).toBe(binToHex(lockA));
    expect(() => lockFromAddress(qAddr(lockA).replace("bitcoincash:", "bchtest:"))).toThrow(/mainnet/);
  });
});

describe("buildLinkTx", () => {
  it("proves from the largest coin's address, spends only that address and returns the change to it", () => {
    const c = chain();
    const coins = [c.coin(lockB, 3_000n), c.coin(lockA, 9_000n), c.coin(lockA, 700n), c.coin(lockB, 8_000n)];
    const u = buildLinkTx({ pubkey: npk1, funding: coins });
    expect(binToHex(u.lock)).toBe(binToHex(lockA));
    expect(u.sourceOutputs.every((o) => binToHex(o.lockingBytecode) === binToHex(lockA))).toBe(true);
    const big = buildLinkTx({ pubkey: npk1, funding: [...coins, c.coin(lockB, 20_000n)] });
    expect(binToHex(big.lock)).toBe(binToHex(lockB));
    expect(big.transaction.inputs).toHaveLength(1);
    expect(binToHex(big.transaction.outputs[1].lockingBytecode)).toBe(binToHex(lockB));
    expect(big.transaction.outputs[1].valueSatoshis).toBe(20_000n - big.fee);
    // signed by the B key alone, it passes the VM; the fee covers the real size at 1 sat/byte
    const signed = sign(big.transaction, big.sourceOutputs, keyB);
    expect(BigInt(encodeTransaction(signed).length)).toBeLessThanOrEqual(big.fee);
  });

  it("refuses a wallet with no plain BCH", () => {
    expect(() => buildLinkTx({ pubkey: npk1, funding: [] })).toThrow(/No BCH/);
    const c = chain();
    expect(() => buildLinkTx({ pubkey: npk1, funding: [c.coin(lockA, 150n)] })).toThrow(/Not enough/);
  });
});

describe("verification", () => {
  it("verifies a fresh link from the npub and from the address, keeping the user's other NIP-39 identities", async () => {
    const c = chain();
    const txid = c.link(npk1, [c.coin(lockA, 10_000n)], keyA, 950_000);
    const earlier = finalizeEvent({ kind: 10011, created_at: 1_700_000_000, content: "", tags: [["i", "github:someone", "gistid"]] }, nsec1);
    const r = relay([earlier]);
    const prev = await latestIdentities(r, npk1);
    const ev = claimEvent(nsec1, addressName(lockA), txid, prev);
    expect(ev.tags).toEqual([["i", "github:someone", "gistid"], ["i", `bch:${addressName(lockA)}`, txid]]);
    await r.publish(ev);

    const v = await verifyFromNostr(c.rpc, r, npk1);
    expect(v.checks.filter((k) => !k.ok)).toEqual([]);
    expect(v).toMatchObject({ verified: true, address: addressName(lockA), txid, height: 950_000 });
    const back = await verifyFromAddress(c.rpc, r, qAddr(lockA));
    expect(back?.verified).toBe(true);
    expect(back?.pubkey).toBe(npk1);
  });

  it("rejects a claim whose proof was made from another address or names another key", async () => {
    const c = chain();
    const fromB = c.link(npk1, [c.coin(lockB, 10_000n)], keyB, 950_000);
    const r = relay([claimEvent(nsec1, addressName(lockA), fromB)]);
    const v = await verifyFromNostr(c.rpc, r, npk1);
    expect(v.verified).toBe(false);
    expect(v.checks.find((k) => /spends a coin/.test(k.label))?.ok).toBe(false);

    const forOther = c.link(npk2, [c.coin(lockA, 10_000n)], keyA, 950_001);
    const r2 = relay([claimEvent(nsec1, addressName(lockA), forOther)]);
    const v2 = await verifyFromNostr(c.rpc, r2, npk1);
    expect(v2.verified).toBe(false);
    expect(v2.checks.find((k) => /verification text/.test(k.label))?.ok).toBe(false);
  });

  it("drops an event changed after signing", async () => {
    const c = chain();
    const txid = c.link(npk1, [c.coin(lockA, 10_000n)], keyA, 950_000);
    const ev = claimEvent(nsec1, addressName(lockA), txid);
    const forged = { ...ev, tags: [["i", `bch:${addressName(lockB)}`, txid]] };
    const r = relay([forged]);
    expect(await latestIdentities(r, npk1)).toBeUndefined();
    expect((await verifyFromNostr(c.rpc, r, npk1)).verified).toBe(false);
  });

  it("follows a key rotation and a revoke on the address", async () => {
    const c = chain();
    const first = c.link(npk1, [c.coin(lockA, 10_000n)], keyA, 950_000);
    const r = relay([claimEvent(nsec1, addressName(lockA), first)]);
    expect((await verifyFromNostr(c.rpc, r, npk1)).verified).toBe(true);

    // the address moves to a new Nostr key: the old key's claim stops verifying, the new one verifies both ways
    const second = c.link(npk2, [c.coin(lockA, 10_000n)], keyA, 950_100);
    await r.publish(claimEvent(nsec2, addressName(lockA), second));
    const old = await verifyFromNostr(c.rpc, r, npk1);
    expect(old.verified).toBe(false);
    expect(old.checks.find((k) => /not linked another key/.test(k.label))?.ok).toBe(false);
    expect((await verifyFromAddress(c.rpc, r, addressName(lockA)))?.pubkey).toBe(npk2);

    // a revoke clears it
    c.link(npk2, [c.coin(lockA, 10_000n)], keyA, 950_200, true);
    expect(await verifyFromAddress(c.rpc, r, addressName(lockA))).toBeUndefined();
    expect((await verifyFromNostr(c.rpc, r, npk2)).verified).toBe(false);
  });

  it("finds no identity for an address that never linked one", async () => {
    const c = chain();
    c.coin(lockB, 5_000n);
    expect(await verifyFromAddress(c.rpc, relay(), qAddr(lockB))).toBeUndefined();
    expect(bchClaims(undefined)).toEqual([]);
  });
});

describe("sign-in", () => {
  const origin = "https://emilhuseyn.github.io";
  it("accepts a fresh signature over this app's challenge only", () => {
    const now = 1_800_000_000;
    const ok = finalizeEvent(authTemplate("ab".repeat(32), origin, now), nsec1);
    expect(checkAuth(ok, "ab".repeat(32), origin, now + 30)).toBeUndefined();
    expect(checkAuth(ok, "cd".repeat(32), origin, now)).toMatch(/challenge/);
    expect(checkAuth(ok, "ab".repeat(32), "https://evil.example", now)).toMatch(/another app/);
    expect(checkAuth(ok, "ab".repeat(32), origin, now + 3600)).toMatch(/too old/);
    expect(checkAuth({ ...ok, pubkey: npk2 }, "ab".repeat(32), origin, now)).toMatch(/does not verify/);
  });
});

describe("buildPayTx", () => {
  it("pays the identity's address and returns change, or refuses when the wallet is short", () => {
    const c = chain();
    const u = buildPayTx({ to: lockA, amount: 2_000n, funding: [c.coin(lockB, 600n), c.coin(lockB, 5_000n)], changeLock: lockB });
    expect(u.transaction.inputs).toHaveLength(1);
    expect(u.transaction.outputs[0].valueSatoshis).toBe(2_000n);
    expect(u.transaction.outputs[1].valueSatoshis).toBe(5_000n - 2_000n - u.fee);
    sign(u.transaction, u.sourceOutputs, keyB);
    expect(() => buildPayTx({ to: lockA, amount: 9_000n, funding: [c.coin(lockB, 5_000n)], changeLock: lockB })).toThrow(/Not enough/);
  });
});
