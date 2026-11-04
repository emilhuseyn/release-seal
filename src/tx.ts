// Builds unsigned seal transactions. The wallet (WizardConnect) signs every P2PKH input; this module never sees a key.
// Genesis: input 0 must spend output 0 of some transaction, whose txid becomes the project's token category.
// Release and revoke: input 0 spends the current mutable NFT, output 0 recreates it with the new commitment.
import { binToHex, encodeTransaction, hexToBin, type Output, type Transaction } from "@bitauth/libauth";
import { sourceOutputToRelay } from "@wizardconnect/core/hdwalletv1-serialize";
import { encodeRecord, merkleRoot, type FileEntry, type SealRecord } from "./seal";

export interface Utxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: Output["token"];
}

export interface SealTxInput {
  record: SealRecord;
  commitment: Uint8Array;
  publisherLock: Uint8Array;
  funding: Utxo[];
  nft?: Utxo;
  feeRate?: bigint;
}

export interface UnsignedSealTx {
  transaction: Transaction;
  sourceOutputs: Output[];
  category: Uint8Array;
  fee: bigint;
  change: bigint;
}

export const NFT_SATS = 1000n;
export const DUST = 546n;
// Worst case over both signature types the wallet may pick: ECDSA (push + 72-byte DER + sighash byte) and the pubkey push.
// Schnorr needs 100, so 108 costs 8 sats per input and keeps an ECDSA-signing wallet above the 1 sat/byte relay floor.
const P2PKH_UNLOCK_SIZE = 108;

const sizeWith = (tx: Transaction, unlockSize: number) =>
  encodeTransaction({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array(unlockSize) })) }).length;

// WizardConnect (hdwalletv1) request: every input sits at the wallet's receive/0 address, the one the publisher NFT lives on.
// The relay sends it with plain JSON.stringify, so it goes in the reference wire format: the transaction as hex, the source
// outputs through the library's own serializer (hex bytes, "<bigint: Xn>" amounts). libauth objects would throw on the bigints.
export const wizardRequest = (u: Pick<UnsignedSealTx, "transaction" | "sourceOutputs">, userPrompt: string) => ({
  transaction: {
    transaction: binToHex(encodeTransaction(u.transaction)),
    sourceOutputs: u.transaction.inputs.map((input, i) => sourceOutputToRelay({ ...input, ...u.sourceOutputs[i] })),
    broadcast: true,
    userPrompt,
  },
  inputPaths: u.transaction.inputs.map((_, i): [number, string, number] => [i, "receive", 0]),
});

// Pairing without a second device to scan with: Cashonize for Android opens wiz: links, and its web wallet takes the code as
// ?uri= (history router, read 4 Nov from cashonize-wallet main and the live bundle). The code holds & and =, so it is escaped.
export const pairLinks = (uri: string) => ({ app: uri, web: `https://cashonize.com/?uri=${encodeURIComponent(uri)}` });

// The key the page spends from (receive/0), or "" while the wallet has shared no xpubs. Selene 2026.10 sends a wallet_ready
// with no paths as soon as it pairs and a second one with them once its user approves the dapp.
export const receiveKey = (m: { getPubkey(childIndex: number, index: bigint): Uint8Array | undefined }) => {
  const p = m.getPubkey(0, 0n);
  return p ? binToHex(p) : "";
};

// Exchange withdrawals rarely land at output 0, so genesis may first need this: every plain coin back to the publisher
// as one output at index 0. Its txid becomes the project's category.
export const buildPrepTx = ({ publisherLock, funding, feeRate = 1n }: Pick<SealTxInput, "publisherLock" | "funding" | "feeRate">) => {
  const coins = funding.filter((u) => !u.token);
  const sourceOutputs: Output[] = coins.map((u) => ({ lockingBytecode: publisherLock, valueSatoshis: u.satoshis }));
  const tx: Transaction = {
    version: 2,
    locktime: 0,
    inputs: coins.map((u) => ({
      outpointTransactionHash: hexToBin(u.txid),
      outpointIndex: u.vout,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    })),
    outputs: [{ lockingBytecode: publisherLock, valueSatoshis: 0n }],
  };
  const fee = BigInt(sizeWith(tx, P2PKH_UNLOCK_SIZE)) * feeRate;
  const value = coins.reduce((s, u) => s + u.satoshis, 0n) - fee;
  if (value < NFT_SATS + DUST) throw new Error("Not enough BCH in the wallet to create a project");
  tx.outputs[0].valueSatoshis = value;
  return { transaction: tx, sourceOutputs, fee, value };
};

export const buildSealTx = ({ record, commitment, publisherLock, funding, nft, feeRate = 1n }: SealTxInput): UnsignedSealTx => {
  if (commitment.length > 40) throw new Error("NFT commitment is limited to 40 bytes");
  const coins = funding.filter((u) => !u.token);
  let ordered: Utxo[];
  let category: Uint8Array;
  if (record.kind === "genesis") {
    const first = coins.find((u) => u.vout === 0);
    if (!first) throw new Error("Genesis needs a coin sitting at output 0. Send any small amount to yourself, then retry.");
    ordered = [first, ...coins.filter((u) => u !== first)];
    category = hexToBin(first.txid);
  } else {
    if (!nft?.token?.nft || nft.token.nft.capability !== "mutable") throw new Error("Release and revoke need the project's mutable NFT");
    ordered = [nft, ...coins];
    category = nft.token.category;
  }

  const sourceOutputs: Output[] = ordered.map((u) => ({ lockingBytecode: publisherLock, valueSatoshis: u.satoshis, token: u.token }));
  const inputTotal = ordered.reduce((s, u) => s + u.satoshis, 0n);
  const outputs: Output[] = [
    { lockingBytecode: publisherLock, valueSatoshis: NFT_SATS, token: { amount: 0n, category, nft: { capability: "mutable", commitment } } },
    { lockingBytecode: encodeRecord(record), valueSatoshis: 0n },
  ];
  const tx: Transaction = {
    version: 2,
    locktime: 0,
    inputs: ordered.map((u) => ({
      outpointTransactionHash: hexToBin(u.txid),
      outpointIndex: u.vout,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    })),
    outputs,
  };

  const changeOut = { lockingBytecode: publisherLock, valueSatoshis: 0n };
  const withChange = { ...tx, outputs: [...outputs, changeOut] };
  const feeWithChange = BigInt(sizeWith(withChange, P2PKH_UNLOCK_SIZE)) * feeRate;
  const change = inputTotal - NFT_SATS - feeWithChange;
  if (change >= DUST) {
    changeOut.valueSatoshis = change;
    return { transaction: withChange, sourceOutputs, category, fee: feeWithChange, change };
  }
  const fee = inputTotal - NFT_SATS;
  if (fee < BigInt(sizeWith(tx, P2PKH_UNLOCK_SIZE)) * feeRate) throw new Error("Not enough BCH in the wallet for the fee");
  return { transaction: tx, sourceOutputs, category, fee, change: 0n };
};

// What a sent seal transaction leaves the publisher: the project NFT at output 0 and the change, if any. The next seal
// spends them at once, before any server has seen the transaction.
export const sealOutputs = (u: UnsignedSealTx, txid: string) => ({
  nft: { txid, vout: 0, satoshis: NFT_SATS, token: u.transaction.outputs[0].token } as Utxo,
  funding: u.change ? [{ txid, vout: 2, satoshis: u.change }] : [],
});

export const FIRST_VERSION = "v1";

export interface FirstSealInput {
  publisherLock: Uint8Array;
  funding: Utxo[];
  files: FileEntry[];
  name: string;
  link: (category: string) => string;
  onCreated?: (category: string) => void;
}

export type Send = (u: { transaction: Transaction; sourceOutputs: Output[]; fee: bigint }, step: string) => Promise<string>;

// A judge's first try in one press: a new project is created and the dropped files are sealed as v1 (two wallet
// confirmations, three when the coins first move to output 0). Every transaction is built and its fee checked on
// placeholder txids before the first one is signed, so a wallet that is too small pays nothing.
export const firstSeal = async ({ publisherLock, funding, files, name, link, onCreated }: FirstSealInput, send: Send) => {
  const coins = funding.filter((u) => !u.token);
  const prep = coins.some((u) => u.vout === 0) ? undefined : buildPrepTx({ publisherLock, funding: coins });
  const steps = prep ? 3 : 2;
  const genesisOn = (start: Utxo[]) =>
    buildSealTx({
      record: { kind: "genesis", version: name, manifestUrl: link(start.find((u) => u.vout === 0)?.txid ?? "") },
      commitment: merkleRoot([]),
      publisherLock,
      funding: start,
    });
  const releaseAfter = (g: UnsignedSealTx, txid: string) =>
    buildSealTx({
      record: { kind: "release", version: FIRST_VERSION, manifestUrl: link(binToHex(g.category)) },
      commitment: merkleRoot(files),
      publisherLock,
      ...sealOutputs(g, txid),
    });
  const placeholder = "00".repeat(32);
  releaseAfter(genesisOn(prep ? [{ txid: placeholder, vout: 0, satoshis: prep.value }] : coins), placeholder);

  const start = prep ? [{ txid: await send(prep, `Step 1 of 3: move your coins to output 0, where a project starts`), vout: 0, satoshis: prep.value }] : coins;
  const g = genesisOn(start);
  const genesis = await send(g, `Step ${steps - 1} of ${steps}: create the project`);
  const category = binToHex(g.category);
  onCreated?.(category);
  const release = await send(releaseAfter(g, genesis), `Step ${steps} of ${steps}: seal the files as ${FIRST_VERSION}`);
  return { category, genesis, release };
};
