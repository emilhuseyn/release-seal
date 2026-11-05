// Walk test on a fake Fulcrum: real signed transactions (throwaway key, dummy coins), served from memory.
import {
  binToHex,
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
import { describe, expect, it } from "vitest";
import { broadcast, heldProjects, walkProject, walletCoins, type Rpc } from "./chain";
import { entryFor, merkleRoot, type SealRecord } from "./seal";
import { buildSealTx, NFT_SATS, type Utxo } from "./tx";

const key = hexToBin("22".repeat(32));
const pub = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;
const lock = publicKeyToP2pkhLockingBytecode({ publicKey: pub });
const addr = (lockingBytecode: Uint8Array) =>
  (lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: "bitcoincash", tokenSupport: true }) as { address: string }).address;
const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
// A second maintainer, for hand-overs.
const key2 = hexToBin("33".repeat(32));
const lock2 = publicKeyToP2pkhLockingBytecode({ publicKey: secp256k1.derivePublicKeyCompressed(key2) as Uint8Array });

const sign = (transaction: Transaction, sourceOutputs: Output[], k = key) => {
  const signed = { ...transaction, inputs: transaction.inputs.map((i) => ({ ...i })) };
  signed.inputs.forEach((input, inputIndex) => {
    const r = compiler.generateBytecode({
      data: { keys: { privateKeys: { key: k } }, compilationContext: { inputIndex, sourceOutputs, transaction: signed } },
      scriptId: "unlock",
    });
    if (!r.success) throw new Error(JSON.stringify(r.errors));
    input.unlockingBytecode = r.bytecode;
  });
  return signed;
};

const store = new Map<string, string>();
const hist: { tx_hash: string; height: number }[] = [];
const hist2: { tx_hash: string; height: number }[] = [];
const put = (tx: Transaction, height: number, into = [hist]) => {
  const raw = encodeTransaction(tx);
  const txid = binToHex(hashTransactionUiOrder(raw));
  store.set(txid, binToHex(raw));
  for (const h of into) h.push({ tx_hash: txid, height });
  return txid;
};
const rpc: Rpc = {
  request: async (method, ...params) => {
    if (method === "blockchain.transaction.get") return store.get(params[0] as string);
    if (method === "blockchain.address.get_history") return params[0] === addr(lock) ? hist : params[0] === addr(lock2) ? hist2 : [];
    throw new Error(method);
  },
};

const step = (record: SealRecord, commitment: Uint8Array, funding: Utxo[], nft?: Utxo, height = 0) => {
  const u = buildSealTx({ record, commitment, publisherLock: lock, funding, nft });
  const signed = sign(u.transaction, u.sourceOutputs);
  const txid = put(signed, height);
  return {
    txid,
    nft: { txid, vout: 0, satoshis: NFT_SATS, token: signed.outputs[0].token } as Utxo,
    change: { txid, vout: 2, satoshis: signed.outputs[2].valueSatoshis } as Utxo,
  };
};

describe("walkProject", () => {
  it("follows genesis, two releases and a revoke", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("ab".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 900000);
    const r = (n: number) => merkleRoot([entryFor(`app-${n}.tgz`, new Uint8Array([n]))]);
    const g = step({ kind: "genesis", version: "demo", manifestUrl: "https://x.org" }, r(0), [{ txid: category, vout: 0, satoshis: 50000n }], undefined, 900001);
    const r1 = step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, r(1), [g.change], g.nft, 900002);
    const r2 = step({ kind: "release", version: "v2", manifestUrl: "https://x.org/v2" }, r(2), [r1.change], r1.nft, 900003);
    step({ kind: "revoke", version: "v1", manifestUrl: "https://x.org/v1" }, r(2), [r2.change], r2.nft, 900004);

    const events = await walkProject(rpc, category);
    expect(events.map((e) => e.kind)).toEqual(["genesis", "release", "release", "revoke"]);
    expect(events[1].revoked).toBe(true);
    expect(events[2].revoked).toBeUndefined();
    expect(events[2].commitment).toBe(binToHex(r(2)));
    expect(events.every((e) => e.publisher === addr(lock))).toBe(true);
    expect(events.map((e) => e.height)).toEqual([900001, 900002, 900003, 900004]);
  });

  it("reads Fulcrum's mempool height -1 (unconfirmed parent) as unconfirmed", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("ac".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 0);
    const root = merkleRoot([entryFor("fresh.tgz", new Uint8Array([7]))]);
    const g = step({ kind: "genesis", version: "fresh", manifestUrl: "https://x.org" }, root, [{ txid: category, vout: 0, satoshis: 50000n }], undefined, -1);
    step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, root, [g.change], g.nft, -1);

    const events = await walkProject(rpc, category);
    expect(events.map((e) => e.kind)).toEqual(["genesis", "release"]);
    expect(events.map((e) => e.height)).toEqual([0, 0]);
  });

  it("on a busy wallet reads nothing older than the project and reads many at once", async () => {
    const filler = (n: number, height: number) => {
      const raw = encodeTransaction({
        version: 2,
        locktime: 0,
        inputs: [{ outpointTransactionHash: hexToBin(n.toString(16).padStart(64, "f")), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
        outputs: [{ lockingBytecode: lock, valueSatoshis: 1000n }],
      });
      const txid = binToHex(hashTransactionUiOrder(raw));
      store.set(txid, binToHex(raw));
      return { tx_hash: txid, height };
    };
    const old = Array.from({ length: 60 }, (_, n) => filler(n, 800000 + n));
    const mark = hist.length;
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("ba".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 910000);
    const root = merkleRoot([entryFor("busy.tgz", new Uint8Array([5]))]);
    const g = step({ kind: "genesis", version: "busy", manifestUrl: "https://x.org" }, root, [{ txid: category, vout: 0, satoshis: 50000n }], undefined, 910030);
    step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, root, [g.change], g.nft, 910031);
    const [p, ...chain] = hist.slice(mark);
    const between = Array.from({ length: 30 }, (_, n) => filler(100 + n, 910000 + n));
    const busy = [...old, p, ...between, ...chain];

    const read: string[] = [];
    let inFlight = 0;
    let most = 0;
    const slow: Rpc = {
      request: async (method, ...params) => {
        if (method === "blockchain.address.get_history") return busy;
        read.push(params[0] as string);
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return store.get(params[0] as string);
      },
    };
    const events = await walkProject(slow, category);
    expect(events.map((e) => e.kind)).toEqual(["genesis", "release"]);
    expect(read.filter((t) => old.some((o) => o.tx_hash === t))).toEqual([]);
    expect(most).toBeGreaterThan(1);
  });
});

// A plain wallet send of the project NFT to the next maintainer (no seal record), with the NFT at output 1 behind a BCH
// output, as a wallet may lay it out; signed by the old holder.
const handOver = (nft: Utxo, funding: Utxo, height: number) => {
  const sourceOutputs: Output[] = [
    { lockingBytecode: lock, valueSatoshis: nft.satoshis, token: nft.token },
    { lockingBytecode: lock, valueSatoshis: funding.satoshis },
  ];
  const tx: Transaction = {
    version: 2,
    locktime: 0,
    inputs: [nft, funding].map((u) => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })),
    outputs: [
      { lockingBytecode: lock2, valueSatoshis: 3000n },
      { lockingBytecode: lock2, valueSatoshis: nft.satoshis, token: nft.token },
    ],
  };
  const txid = put(sign(tx, sourceOutputs), height, [hist, hist2]);
  return { txid, funding: { txid, vout: 0, satoshis: 3000n } as Utxo, nft: { txid, vout: 1, satoshis: nft.satoshis, token: nft.token } as Utxo };
};

describe("walkProject after a hand-over", () => {
  it("follows the NFT through a record-less wallet send to the new maintainer's seals", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("c1".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 920000);
    const r = (n: number) => merkleRoot([entryFor(`tool-${n}.tgz`, new Uint8Array([n]))]);
    const g = step({ kind: "genesis", version: "tool", manifestUrl: "https://x.org" }, r(0), [{ txid: category, vout: 0, satoshis: 50000n }], undefined, 920001);
    const r1 = step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, r(1), [g.change], g.nft, 920002);
    const h = handOver(r1.nft, r1.change, 920003);
    const u = buildSealTx({ record: { kind: "release", version: "v2", manifestUrl: "https://x.org/v2" }, commitment: r(2), publisherLock: lock2, funding: [h.funding], nft: h.nft });
    const v2 = put(sign(u.transaction, u.sourceOutputs, key2), 920004, [hist2]);

    const events = await walkProject(rpc, category);
    expect(events.map((e) => e.kind)).toEqual(["genesis", "release", "moved", "release"]);
    expect(events[2]).toMatchObject({ txid: h.txid, vout: 1, publisher: addr(lock2), commitment: binToHex(r(1)), height: 920003 });
    expect(events[3]).toMatchObject({ txid: v2, vout: 0, version: "v2", publisher: addr(lock2), commitment: binToHex(r(2)) });
    expect(events[1].publisher).toBe(addr(lock));

    expect(await heldProjects(rpc, [h.nft])).toEqual([]);
    expect(await heldProjects(rpc, [{ txid: v2, vout: 0, token: u.transaction.outputs[0].token }])).toEqual([
      { category, kind: "release", version: "v2", txid: v2 },
    ]);
  });

  it("reads a hand-over record as the step to the new maintainer, with its reason, and lists the project for them", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("c4".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 950000);
    const r = (n: number) => merkleRoot([entryFor(`lib-${n}.tgz`, new Uint8Array([n]))]);
    const g = step({ kind: "genesis", version: "lib", manifestUrl: "https://x.org" }, r(0), [{ txid: category, vout: 0, satoshis: 50000n }], undefined, 950001);
    const r1 = step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, r(1), [g.change], g.nft, 950002);
    const m = buildSealTx({
      record: { kind: "move", version: "key rotation", manifestUrl: "" },
      commitment: r(1),
      publisherLock: lock,
      funding: [r1.change],
      nft: r1.nft,
      holderLock: lock2,
    });
    const moved = put(sign(m.transaction, m.sourceOutputs), 950003, [hist, hist2]);
    const nft2 = { txid: moved, vout: 0, satoshis: NFT_SATS, token: m.transaction.outputs[0].token } as Utxo;

    const before = await walkProject(rpc, category);
    expect(before.map((e) => e.kind)).toEqual(["genesis", "release", "move"]);
    expect(before[2]).toMatchObject({ txid: moved, vout: 0, version: "key rotation", publisher: addr(lock2), commitment: binToHex(r(1)) });
    expect(await heldProjects(rpc, [nft2])).toEqual([{ category, kind: "moved", version: "lib", txid: moved }]);

    const v2 = buildSealTx({
      record: { kind: "release", version: "v2", manifestUrl: "https://x.org/v2" },
      commitment: r(2),
      publisherLock: lock2,
      funding: [{ txid: "c5".repeat(32), vout: 1, satoshis: 9000n, lock: lock2 }],
      nft: { ...nft2, lock: lock2 },
    });
    const v2id = put(sign(v2.transaction, v2.sourceOutputs, key2), 950004, [hist2]);
    const after = await walkProject(rpc, category);
    expect(after.map((e) => e.kind)).toEqual(["genesis", "release", "move", "release"]);
    expect(after[3]).toMatchObject({ txid: v2id, version: "v2", publisher: addr(lock2), commitment: binToHex(r(2)) });
  });

  it("reads an NFT that never carried a seal record as no project, however it moved", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("c3".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 940000);
    const token = { amount: 0n, category: hexToBin(category), nft: { capability: "mutable" as const, commitment: new Uint8Array(32) } };
    const mint: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin(category), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: NFT_SATS, token }, { lockingBytecode: lock, valueSatoshis: 48000n }],
    };
    const m = put(sign(mint, [{ lockingBytecode: lock, valueSatoshis: 50000n }]), 940001);
    handOver({ txid: m, vout: 0, satoshis: NFT_SATS, token }, { txid: m, vout: 1, satoshis: 48000n }, 940002);

    expect(await walkProject(rpc, category)).toEqual([]);
  });

  it("lists a project received by a wallet send under its name, and only the coin the walk ends at", async () => {
    const parent: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin("c2".repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
    };
    const category = put(sign(parent, [{ lockingBytecode: lock, valueSatoshis: 51000n }]), 930000);
    const root = merkleRoot([entryFor("given.tgz", new Uint8Array([3]))]);
    const g = step({ kind: "genesis", version: "given", manifestUrl: "https://x.org" }, root, [{ txid: category, vout: 0, satoshis: 50000n }], undefined, 930001);
    const h = handOver(g.nft, g.change, 930002);
    const stray = { category: hexToBin(category), amount: 0n, nft: { capability: "mutable" as const, commitment: root } };

    expect(await heldProjects(rpc, [h.nft, { txid: h.txid, vout: 0, token: stray }])).toEqual([
      { category, kind: "moved", version: "given", txid: h.txid },
    ]);
  });
});

describe("heldProjects", () => {
  const parentOf = (seed: string) =>
    put(
      sign(
        {
          version: 2,
          locktime: 0,
          inputs: [{ outpointTransactionHash: hexToBin(seed.repeat(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
          outputs: [{ lockingBytecode: lock, valueSatoshis: 50000n }],
        },
        [{ lockingBytecode: lock, valueSatoshis: 51000n }],
      ),
      900010,
    );

  it("lists the publisher's projects with their last step and skips every other coin", async () => {
    const root = merkleRoot([entryFor("held.tgz", new Uint8Array([9]))]);
    const a = parentOf("ad");
    const ga = step({ kind: "genesis", version: "alpha", manifestUrl: "https://x.org" }, root, [{ txid: a, vout: 0, satoshis: 50000n }]);
    const ra = step({ kind: "release", version: "v1", manifestUrl: "https://x.org/v1" }, root, [ga.change], ga.nft);
    const b = parentOf("ae");
    const gb = step({ kind: "genesis", version: "beta", manifestUrl: "https://y.org" }, root, [{ txid: b, vout: 0, satoshis: 50000n }]);
    const mutable = { category: hexToBin(a), amount: 0n, nft: { capability: "mutable" as const, commitment: root } };
    const coins = [
      ra.nft,
      gb.nft,
      ra.change,
      { txid: a, vout: 0, satoshis: 1000n, token: mutable },
      { txid: ra.txid, vout: 2, satoshis: 1000n, token: mutable },
    ];

    expect(await heldProjects(rpc, coins)).toEqual([
      { category: a, kind: "release", version: "v1", txid: ra.txid },
      { category: b, kind: "genesis", version: "beta", txid: gb.txid },
    ]);
  });
});

describe("walletCoins", () => {
  // A P2PKH address per (chain, index); the hash only has to be distinct.
  const lockAt = (child: number, index: number) => Uint8Array.from([0x76, 0xa9, 0x14, child, index, ...new Array(18).fill(7), 0x88, 0xac]);
  const used = new Map<string, number>([
    ["0/0", 1000],
    ["0/19", 0],
    ["0/30", 2500],
    ["0/60", 9000],
    ["1/2", 700],
  ]);
  const at = new Map<string, string>();
  for (const child of [0, 1]) for (let i = 0; i < 100; i++) at.set(addr(lockAt(child, i)), `${child}/${i}`);
  const fake = () => {
    const asked: string[] = [];
    const rpc: Rpc = {
      request: async (method, address) => {
        const k = at.get(address as string)!;
        if (method === "blockchain.address.get_history") {
          asked.push(k);
          return used.has(k) ? [{ tx_hash: "ee".repeat(32), height: 900000 }] : [];
        }
        if (method === "blockchain.address.listunspent") {
          const v = used.get(k);
          return v ? [{ tx_hash: k.replace("/", "f").padStart(64, "0"), tx_pos: 1, height: 900000, value: v }] : [];
        }
        throw new Error(method);
      },
    };
    return { rpc, asked };
  };

  it("finds coins past the first 20 addresses and on the change chain, and stops 20 unused addresses after the last used", async () => {
    const f = fake();
    const coins = await walletCoins(f.rpc, lockAt);
    expect(coins.map((c) => [c.path, c.satoshis])).toEqual([
      [["receive", 0], 1000n],
      [["receive", 30], 2500n],
      [["change", 2], 700n],
    ]);
    expect(coins.every((c) => binToHex(c.lock!) === binToHex(lockAt(c.path![0] === "receive" ? 0 : 1, c.path![1])))).toBe(true);
    expect(f.asked.filter((k) => k.startsWith("0/")).length).toBe(51);
    expect(f.asked.filter((k) => k.startsWith("1/")).length).toBe(23);
  });

  it("reads only the chains the wallet shared", async () => {
    const f = fake();
    const coins = await walletCoins(f.rpc, (child, index) => (child === 0 ? lockAt(child, index) : undefined));
    expect(coins.map((c) => c.path![0])).toEqual(["receive", "receive"]);
    expect(f.asked.some((k) => k.startsWith("1/"))).toBe(false);
  });
});

describe("broadcast", () => {
  const tx: Transaction = {
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin("cd".repeat(32)), outpointIndex: 1, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: lock, valueSatoshis: 9000n }],
  };
  const signed = encodeTransaction(sign(tx, [{ lockingBytecode: lock, valueSatoshis: 10000n }]));
  const raw = binToHex(signed);
  const txid = binToHex(hashTransactionUiOrder(signed));
  const answering = (answer: () => unknown): Rpc => ({ request: async () => answer() });

  it("returns the txid the node echoes", async () => {
    expect(await broadcast(answering(() => txid), raw)).toBe(txid);
  });
  it("treats a transaction the wallet already sent as sent", async () => {
    const known = answering(() => {
      throw new Error("the transaction was rejected by network rules.\n\ntxn-already-known");
    });
    expect(await broadcast(known, raw)).toBe(txid);
  });
  it("passes a real rejection on", async () => {
    const bad = answering(() => {
      throw new Error("the transaction was rejected by network rules.\n\nbad-txns-inputs-missingorspent");
    });
    await expect(broadcast(bad, raw)).rejects.toThrow("missingorspent");
  });
  it("rejects an answer that is not the txid", async () => {
    await expect(broadcast(answering(() => "00".repeat(32)), raw)).rejects.toThrow("instead of txid");
  });
});
