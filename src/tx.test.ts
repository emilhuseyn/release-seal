// Offline check: a throwaway key signs the unsigned transactions on dummy coins and libauth's BCH VM verifies them,
// token rules included. No network, no real coins.
import {
  binToHex,
  createVirtualMachineBCH,
  encodeTransaction,
  hashTransactionUiOrder,
  hexToBin,
  publicKeyToP2pkhLockingBytecode,
  secp256k1,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { decodeRecord, entryFor, merkleRoot } from "./seal";
import { buildSealTx, NFT_SATS, type Utxo } from "./tx";

const key = hexToBin("11".repeat(32));
const pub = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;
const lock = publicKeyToP2pkhLockingBytecode({ publicKey: pub });
const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
const vm = createVirtualMachineBCH();

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

const coin = (txid: string, vout: number, satoshis: bigint): Utxo => ({ txid, vout, satoshis });
const root1 = merkleRoot([entryFor("app-1.0.0.tar.gz", new Uint8Array([1, 2, 3]))]);
const root2 = merkleRoot([entryFor("app-1.1.0.tar.gz", new Uint8Array([4, 5, 6]))]);

describe("buildSealTx", () => {
  it("genesis then release verify in the BCH VM, and the change and fee add up", () => {
    const g = buildSealTx({
      record: { kind: "genesis", version: "demo-project", manifestUrl: "https://example.org/seal" },
      commitment: root1,
      publisherLock: lock,
      funding: [coin("aa".repeat(32), 1, 5000n), coin("bb".repeat(32), 0, 20000n)],
    });
    expect(binToHex(g.category)).toBe("bb".repeat(32));
    const gs = sign(g.transaction, g.sourceOutputs);
    expect(vm.verify({ sourceOutputs: g.sourceOutputs, transaction: gs })).toBe(true);
    const outSum = gs.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
    expect(25000n - outSum).toBe(g.fee);
    expect(g.fee).toBeGreaterThanOrEqual(BigInt(encodeTransaction(gs).length));
    expect(decodeRecord(gs.outputs[1].lockingBytecode)?.kind).toBe("genesis");

    const gTxid = binToHex(hashTransactionUiOrder(encodeTransaction(gs)));
    const nft: Utxo = { txid: gTxid, vout: 0, satoshis: NFT_SATS, token: gs.outputs[0].token };
    const change: Utxo = { txid: gTxid, vout: 2, satoshis: gs.outputs[2].valueSatoshis };
    const r = buildSealTx({
      record: { kind: "release", version: "v1.1.0", manifestUrl: "https://example.org/v1.1.0/seal.json" },
      commitment: root2,
      publisherLock: lock,
      funding: [change],
      nft,
    });
    const rs = sign(r.transaction, r.sourceOutputs);
    expect(vm.verify({ sourceOutputs: r.sourceOutputs, transaction: rs })).toBe(true);
    expect(binToHex(rs.outputs[0].token!.nft!.commitment)).toBe(binToHex(root2));
    expect(binToHex(rs.outputs[0].token!.category)).toBe("bb".repeat(32));
  });

  it("a release that tries to mint a second category fails the VM", () => {
    const nft: Utxo = {
      txid: "cc".repeat(32),
      vout: 0,
      satoshis: NFT_SATS,
      token: { amount: 0n, category: hexToBin("dd".repeat(32)), nft: { capability: "mutable", commitment: root1 } },
    };
    const r = buildSealTx({
      record: { kind: "release", version: "v2", manifestUrl: "https://example.org/v2" },
      commitment: root2,
      publisherLock: lock,
      funding: [coin("ee".repeat(32), 3, 10000n)],
      nft,
    });
    const forged = { ...r.transaction, outputs: r.transaction.outputs.map((o, i) => (i ? o : { ...o, token: { ...o.token!, category: hexToBin("ff".repeat(32)) } })) };
    expect(vm.verify({ sourceOutputs: r.sourceOutputs, transaction: sign(forged, r.sourceOutputs) })).not.toBe(true);
  });

  it("refuses genesis without a coin at output 0", () => {
    expect(() =>
      buildSealTx({
        record: { kind: "genesis", version: "p", manifestUrl: "https://x.org" },
        commitment: root1,
        publisherLock: lock,
        funding: [coin("aa".repeat(32), 1, 5000n)],
      }),
    ).toThrow(/output 0/);
  });
});
