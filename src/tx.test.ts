// Offline check: a throwaway key signs the unsigned transactions on dummy coins and libauth's BCH VM verifies them,
// token rules included. No network, no real coins.
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeDataPush,
  encodeHdPublicKey,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash256,
  hashTransactionUiOrder,
  hexToBin,
  publicKeyToP2pkhLockingBytecode,
  secp256k1,
  SigningSerializationFlag,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import { DappConnectionManager } from "@wizardconnect/dapp";
import { describe, expect, it } from "vitest";
import { decodeRecord, entryFor, merkleRoot } from "./seal";
import { buildPrepTx, buildSealTx, firstSeal, FIRST_VERSION, NFT_SATS, receiveKey, wizardRequest, type Send, type Utxo } from "./tx";

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

  it("coins off output 0 are moved to output 0 first, and genesis from that coin verifies", () => {
    const p = buildPrepTx({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 5000n), coin("ab".repeat(32), 7, 3000n)] });
    const ps = sign(p.transaction, p.sourceOutputs);
    expect(vm.verify({ sourceOutputs: p.sourceOutputs, transaction: ps })).toBe(true);
    expect(ps.outputs.length).toBe(1);
    expect(p.value + p.fee).toBe(8000n);
    expect(p.fee).toBeGreaterThanOrEqual(BigInt(encodeTransaction(ps).length));

    const prepTxid = binToHex(hashTransactionUiOrder(encodeTransaction(ps)));
    const g = buildSealTx({
      record: { kind: "genesis", version: "demo-project", manifestUrl: "https://example.org/seal" },
      commitment: root1,
      publisherLock: lock,
      funding: [coin(prepTxid, 0, p.value)],
    });
    expect(binToHex(g.category)).toBe(prepTxid);
    expect(vm.verify({ sourceOutputs: g.sourceOutputs, transaction: sign(g.transaction, g.sourceOutputs) })).toBe(true);
  });

  it("the fee still covers 1 sat/byte when the wallet signs with ECDSA instead of Schnorr", () => {
    const ecdsa = walletTemplateToCompilerBCH({
      ...walletTemplateP2pkhNonHd,
      scripts: {
        ...walletTemplateP2pkhNonHd.scripts,
        unlock: { ...walletTemplateP2pkhNonHd.scripts.unlock, script: "<key.ecdsa_signature.all_outputs>\n<key.public_key>" },
      },
    } as typeof walletTemplateP2pkhNonHd);
    const signEcdsa = (transaction: Transaction, sourceOutputs: Output[]) => {
      const signed = { ...transaction, inputs: transaction.inputs.map((i) => ({ ...i })) };
      signed.inputs.forEach((input, inputIndex) => {
        const r = ecdsa.generateBytecode({
          data: { keys: { privateKeys: { key } }, compilationContext: { inputIndex, sourceOutputs, transaction: signed } },
          scriptId: "unlock",
        });
        if (!r.success) throw new Error(JSON.stringify(r.errors));
        input.unlockingBytecode = r.bytecode;
      });
      return signed;
    };
    const check = (u: { transaction: Transaction; sourceOutputs: Output[]; fee: bigint }) => {
      const s = signEcdsa(u.transaction, u.sourceOutputs);
      expect(s.inputs[0].unlockingBytecode.length).toBeGreaterThan(100);
      expect(vm.verify({ sourceOutputs: u.sourceOutputs, transaction: s })).toBe(true);
      expect(u.fee).toBeGreaterThanOrEqual(BigInt(encodeTransaction(s).length));
      return s;
    };

    const p = buildPrepTx({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 5000n), coin("ab".repeat(32), 7, 3000n)] });
    const prepTxid = binToHex(hashTransactionUiOrder(encodeTransaction(check(p))));
    const g = buildSealTx({
      record: { kind: "genesis", version: "demo-project", manifestUrl: "https://example.org/seal" },
      commitment: root1,
      publisherLock: lock,
      funding: [coin(prepTxid, 0, p.value), coin("ac".repeat(32), 2, 4000n)],
    });
    const gs = check(g);
    const gTxid = binToHex(hashTransactionUiOrder(encodeTransaction(gs)));
    const r = buildSealTx({
      record: { kind: "revoke", version: "demo-project", manifestUrl: "https://example.org/seal" },
      commitment: root2,
      publisherLock: lock,
      funding: [{ txid: gTxid, vout: 2, satoshis: gs.outputs[2].valueSatoshis }],
      nft: { txid: gTxid, vout: 0, satoshis: NFT_SATS, token: gs.outputs[0].token },
    });
    check(r);
  });

  it("a prep coin too small for genesis is refused before anything is signed", () => {
    expect(() => buildPrepTx({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 1700n)] })).toThrow(/Not enough/);
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

describe("firstSeal", () => {
  const files = [entryFor("photo.jpg", new Uint8Array([7, 8, 9]))];
  const link = (c: string) => `https://example.org/release-seal/?project=${c}`;
  // stands in for the wallet: signs, checks the VM and the fee, and returns the txid the page would broadcast
  const wallet = () => {
    const sent: { tx: Transaction; step: string; fee: bigint }[] = [];
    const send: Send = async (u, step) => {
      const s = sign(u.transaction, u.sourceOutputs);
      expect(vm.verify({ sourceOutputs: u.sourceOutputs, transaction: s })).toBe(true);
      expect(u.fee).toBeGreaterThanOrEqual(BigInt(encodeTransaction(s).length));
      sent.push({ tx: s, step, fee: u.fee });
      return binToHex(hashTransactionUiOrder(encodeTransaction(s)));
    };
    return { sent, send };
  };

  it("creates the project and seals the files as v1 in two transactions when a coin sits at output 0", async () => {
    const w = wallet();
    let created = "";
    const r = await firstSeal(
      { publisherLock: lock, funding: [coin("bb".repeat(32), 0, 6000n)], files, name: "photo.jpg", link, onCreated: (c) => (created = c) },
      w.send,
    );
    expect(w.sent.map((s) => s.step)).toEqual(["Step 1 of 2: create the project", "Step 2 of 2: seal the files as v1"]);
    expect(r.category).toBe("bb".repeat(32));
    expect(created).toBe(r.category);
    const [g, rel] = w.sent.map((s) => s.tx);
    expect(decodeRecord(g.outputs[1].lockingBytecode)).toMatchObject({ kind: "genesis", version: "photo.jpg", manifestUrl: link(r.category) });
    expect(decodeRecord(rel.outputs[1].lockingBytecode)).toMatchObject({ kind: "release", version: FIRST_VERSION, manifestUrl: link(r.category) });
    expect(binToHex(rel.inputs[0].outpointTransactionHash)).toBe(r.genesis);
    expect(rel.inputs[0].outpointIndex).toBe(0);
    expect(binToHex(rel.outputs[0].token!.nft!.commitment)).toBe(binToHex(merkleRoot(files)));
    expect(binToHex(rel.outputs[0].token!.category)).toBe(r.category);
  });

  it("moves coins to output 0 first when none sits there, then the project takes that txid", async () => {
    const w = wallet();
    const r = await firstSeal({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 3000n), coin("ab".repeat(32), 7, 2000n)], files, name: "p", link }, w.send);
    expect(w.sent.map((s) => s.step[0] + s.step.slice(5, 11))).toEqual(["S1 of 3", "S2 of 3", "S3 of 3"]);
    const prepTxid = binToHex(hashTransactionUiOrder(encodeTransaction(w.sent[0].tx)));
    expect(r.category).toBe(prepTxid);
    expect(binToHex(w.sent[2].tx.outputs[0].token!.category)).toBe(prepTxid);
  });

  it("a wallet that cannot pay for both steps is refused before anything is signed", async () => {
    const w = wallet();
    await expect(firstSeal({ publisherLock: lock, funding: [coin("bb".repeat(32), 0, 1700n)], files, name: "p", link }, w.send)).rejects.toThrow(/Not enough/);
    await expect(firstSeal({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 1900n)], files, name: "p", link }, w.send)).rejects.toThrow(/Not enough/);
    expect(w.sent.length).toBe(0);
  });
});

// Stands in for Cashonize's WizardConnect signer (cashonize-wallet src/utils/dapp/wizSigning.ts and signInput.ts, read 4 Nov):
// the request crosses the relay as JSON, the wallet decodes the hex transaction and the source outputs it was told about, and
// signs each input with Schnorr over SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID. UTXOS commits every signature to every
// claimed source output, so the VM check runs against the coins that really exist (the funding, or outputs of transactions
// already sent): a claimed value or token that differs from the chain fails here as it would on the network.
describe("signed the way Cashonize signs a WizardConnect request", () => {
  type WireToken = { category: string; amount: string; nft?: { capability?: "none" | "mutable" | "minting"; commitment?: string } };
  type Wire = {
    outpointTransactionHash: string;
    outpointIndex: number;
    sequenceNumber: number;
    unlockingBytecode: string;
    lockingBytecode: string;
    valueSatoshis: string;
    token?: WireToken;
  };
  const big = (s: string) => BigInt(/^<bigint: (\d+)n>$/.exec(s)![1]);
  const fromWire = (w: Wire) => ({
    outpointTransactionHash: hexToBin(w.outpointTransactionHash),
    outpointIndex: w.outpointIndex,
    sequenceNumber: w.sequenceNumber,
    unlockingBytecode: hexToBin(w.unlockingBytecode),
    lockingBytecode: hexToBin(w.lockingBytecode),
    valueSatoshis: big(w.valueSatoshis),
    ...(w.token && {
      token: {
        category: hexToBin(w.token.category),
        amount: big(w.token.amount),
        ...(w.token.nft && { nft: { capability: w.token.nft.capability ?? "none", commitment: hexToBin(w.token.nft.commitment ?? "") } }),
      },
    }),
  });
  const hashType = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;
  const files = [entryFor("photo.jpg", new Uint8Array([7, 8, 9]))];
  const link = (c: string) => `https://example.org/release-seal/?project=${c}`;

  const cashonize = (funding: Utxo[]) => {
    const utxos = new Map<string, Output>(funding.map((c) => [`${c.txid}:${c.vout}`, { lockingBytecode: lock, valueSatoshis: c.satoshis }]));
    const steps: string[] = [];
    const send: Send = async (u, step) => {
      const wire = JSON.parse(JSON.stringify(wizardRequest(u, step)));
      expect(wire.inputPaths).toEqual(u.transaction.inputs.map((_, i) => [i, "receive", 0]));
      expect(wire.transaction.broadcast).toBe(true);
      const tx = decodeTransaction(hexToBin(wire.transaction.transaction));
      if (typeof tx === "string") throw new Error(tx);
      const claimed = (wire.transaction.sourceOutputs as Wire[]).map(fromWire);
      tx.inputs.forEach((input, inputIndex) => {
        const preimage = generateSigningSerializationBCH(
          { inputIndex, sourceOutputs: claimed, transaction: tx },
          { coveredBytecode: claimed[inputIndex].lockingBytecode, signingSerializationType: new Uint8Array([hashType]) },
        );
        const sig = secp256k1.signMessageHashSchnorr(key, hash256(preimage));
        if (typeof sig === "string") throw new Error(sig);
        input.unlockingBytecode = Uint8Array.from([...encodeDataPush(Uint8Array.from([...sig, hashType])), ...encodeDataPush(pub)]);
      });
      const real = tx.inputs.map((i) => utxos.get(`${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`));
      expect(real.every(Boolean)).toBe(true);
      expect(vm.verify({ sourceOutputs: real as Output[], transaction: tx })).toBe(true);
      const bytes = encodeTransaction(tx);
      expect(u.fee).toBeGreaterThanOrEqual(BigInt(bytes.length));
      const txid = binToHex(hashTransactionUiOrder(bytes));
      tx.inputs.forEach((i) => utxos.delete(`${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`));
      tx.outputs.forEach((o, vout) => utxos.set(`${txid}:${vout}`, o));
      steps.push(step);
      return txid;
    };
    return { utxos, steps, send };
  };

  it("the request survives the relay's JSON.stringify and every step of Seal it now verifies against the real coins", async () => {
    const w = cashonize([coin("aa".repeat(32), 1, 3000n), coin("ab".repeat(32), 7, 2000n)]);
    const r = await firstSeal({ publisherLock: lock, funding: [coin("aa".repeat(32), 1, 3000n), coin("ab".repeat(32), 7, 2000n)], files, name: "p", link }, w.send);
    expect(w.steps.length).toBe(3);
    expect(binToHex(w.utxos.get(`${r.release}:0`)!.token!.nft!.commitment)).toBe(binToHex(merkleRoot(files)));
  });

  it("a later release and a revoke spend the unconfirmed NFT and change the page knows about", async () => {
    const w = cashonize([coin("bb".repeat(32), 0, 8000n)]);
    const r = await firstSeal({ publisherLock: lock, funding: [coin("bb".repeat(32), 0, 8000n)], files, name: "p", link }, w.send);
    const held = (txid: string) => ({
      nft: { txid, vout: 0, satoshis: NFT_SATS, token: w.utxos.get(`${txid}:0`)!.token },
      funding: [{ txid, vout: 2, satoshis: w.utxos.get(`${txid}:2`)!.valueSatoshis }],
    });
    const v2 = buildSealTx({ record: { kind: "release", version: "v2", manifestUrl: link(r.category) }, commitment: root2, publisherLock: lock, ...held(r.release) });
    const v2id = await w.send(v2, "v2");
    const rv = buildSealTx({ record: { kind: "revoke", version: "v1", manifestUrl: link(r.category) }, commitment: root2, publisherLock: lock, ...held(v2id) });
    await w.send(rv, "revoke v1");
    expect(w.steps).toEqual(["Step 1 of 2: create the project", "Step 2 of 2: seal the files as v1", "v2", "revoke v1"]);
  });
});

describe("receiveKey", () => {
  it("a wallet_ready with no xpubs (Selene before its user approves) gives no key, the next one gives receive/0", () => {
    const seed = deriveHdPrivateNodeFromSeed(hexToBin("22".repeat(32)));
    const chain = deriveHdPublicNode(deriveHdPath(seed, "m/44'/145'/0'/0"));
    const xpub = encodeHdPublicKey({ network: "mainnet", node: chain }).hdPublicKey;
    const child = deriveHdPathRelative(chain, "0");
    const m = new DappConnectionManager("Release Seal", undefined, { session: false });
    const keys: string[] = [];
    m.on("walletready", () => keys.push(receiveKey(m)));
    const ready = (paths: { name: string; xpub: string }[]) => ({
      action: "wallet_ready",
      wallet_name: "Selene",
      wallet_icon: "",
      supported_protocols: ["hdwalletv1"],
      session: { hdwalletv1: { paths } },
      dapp_discovered: true,
      time: 0,
    });
    const deliver = (msg: object) => (m as unknown as { handleMessage(msg: object): void }).handleMessage(msg);
    deliver(ready([]));
    deliver(ready([{ name: "receive", xpub }]));
    expect(keys).toEqual(["", binToHex(child.publicKey)]);
  });
});
