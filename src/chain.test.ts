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
import { broadcast, heldProjects, walkProject, type Rpc } from "./chain";
import { entryFor, merkleRoot, type SealRecord } from "./seal";
import { buildSealTx, NFT_SATS, type Utxo } from "./tx";

const key = hexToBin("22".repeat(32));
const pub = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;
const lock = publicKeyToP2pkhLockingBytecode({ publicKey: pub });
const addr = (lockingBytecode: Uint8Array) =>
  (lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: "bitcoincash", tokenSupport: true }) as { address: string }).address;
const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);

const sign = (transaction: Transaction, sourceOutputs: Output[]) => {
  const signed = { ...transaction, inputs: transaction.inputs.map((i) => ({ ...i })) };
  signed.inputs.forEach((input, inputIndex) => {
    const r = compiler.generateBytecode({
      data: { keys: { privateKeys: { key } }, compilationContext: { inputIndex, sourceOutputs, transaction: signed } },
      scriptId: "unlock",
    });
    if (!r.success) throw new Error(JSON.stringify(r.errors));
    input.unlockingBytecode = r.bytecode;
  });
  return signed;
};

const store = new Map<string, string>();
const hist: { tx_hash: string; height: number }[] = [];
const put = (tx: Transaction, height: number) => {
  const raw = encodeTransaction(tx);
  const txid = binToHex(hashTransactionUiOrder(raw));
  store.set(txid, binToHex(raw));
  hist.push({ tx_hash: txid, height });
  return txid;
};
const rpc: Rpc = {
  request: async (method, ...params) => {
    if (method === "blockchain.transaction.get") return store.get(params[0] as string);
    if (method === "blockchain.address.get_history") return params[0] === addr(lock) ? hist : [];
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
