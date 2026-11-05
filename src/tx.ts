// Builds unsigned seal transactions. The wallet (WizardConnect) signs every P2PKH input; this module never sees a key.
// Genesis: input 0 must spend output 0 of some transaction, whose txid becomes the project's token category.
// Release and revoke: input 0 spends the current mutable NFT, output 0 recreates it with the new commitment.
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hexToBin, type Output, type Transaction } from "@bitauth/libauth";
import { sourceOutputToRelay } from "@wizardconnect/core/hdwalletv1-serialize";
import { encodeRecord, merkleRoot, type FileEntry, type SealRecord } from "./seal";

// A wallet path as WizardConnect names it in inputPaths: the chain ("receive", "change") and the address index.
export type WalletPath = [name: string, index: number];
const PUBLISHER: WalletPath = ["receive", 0];

export interface Utxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: Output["token"];
  // Set for a coin on another address of the wallet (HD wallets keep change on change/n); absent means receive/0.
  lock?: Uint8Array;
  path?: WalletPath;
}

export interface SealTxInput {
  record: SealRecord;
  commitment: Uint8Array;
  publisherLock: Uint8Array;
  funding: Utxo[];
  nft?: Utxo;
  // Where the NFT goes: the publisher, or on a hand-over (kind move) the next maintainer. Change always stays with the publisher.
  holderLock?: Uint8Array;
  feeRate?: bigint;
}

export interface UnsignedSealTx {
  transaction: Transaction;
  sourceOutputs: Output[];
  category: Uint8Array;
  fee: bigint;
  change: bigint;
  paths: WalletPath[];
}

export const NFT_SATS = 1000n;
export const DUST = 546n;
// A seal spends only the coins it needs, largest first, until at least KEEP comes back as change (enough for the next seals).
// A judge's everyday wallet holds many coins on many addresses; spending them all would sweep it into receive/0, ask for a
// signature per coin and pay a fee far over the 2,300 sats the page states.
export const KEEP = 5000n;
// Worst case over both signature types the wallet may pick: ECDSA (push + 72-byte DER + sighash byte) and the pubkey push.
// Schnorr needs 100, so 108 costs 8 sats per input and keeps an ECDSA-signing wallet above the 1 sat/byte relay floor.
const P2PKH_UNLOCK_SIZE = 108;

const sizeWith = (tx: Transaction, unlockSize: number) =>
  encodeTransaction({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array(unlockSize) })) }).length;

const largestFirst = (coins: Utxo[]) => [...coins].sort((a, b) => (a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1));

const inputsOf = (coins: Utxo[]) =>
  coins.map((u) => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }));

// WizardConnect (hdwalletv1) request. Cashonize, Paytaca and Selene pick each input's key from inputPaths, so every input names
// the address its coin sits on (receive/0, where the publisher NFT lives, unless the coin says otherwise).
// The relay sends it with plain JSON.stringify, so it goes in the reference wire format: the transaction as hex, the source
// outputs through the library's own serializer (hex bytes, "<bigint: Xn>" amounts). libauth objects would throw on the bigints.
export const wizardRequest = (u: Pick<UnsignedSealTx, "transaction" | "sourceOutputs"> & { paths?: WalletPath[] }, userPrompt: string) => ({
  transaction: {
    transaction: binToHex(encodeTransaction(u.transaction)),
    sourceOutputs: u.transaction.inputs.map((input, i) => sourceOutputToRelay({ ...input, ...u.sourceOutputs[i] })),
    broadcast: true,
    userPrompt,
  },
  inputPaths: u.transaction.inputs.map((_, i): [number, string, number] => [i, ...(u.paths?.[i] ?? PUBLISHER)]),
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

// Exchange withdrawals rarely land at output 0, so genesis may first need this: plain coins, largest first, back to the
// publisher as one output at index 0, enough for the NFT and KEEP. Its txid becomes the project's category.
export const buildPrepTx = ({ publisherLock, funding, feeRate = 1n }: Pick<SealTxInput, "publisherLock" | "funding" | "feeRate">) => {
  const all = largestFirst(funding.filter((u) => !u.token));
  const plan = (coins: Utxo[]) => {
    const tx: Transaction = { version: 2, locktime: 0, inputs: inputsOf(coins), outputs: [{ lockingBytecode: publisherLock, valueSatoshis: 0n }] };
    const fee = BigInt(sizeWith(tx, P2PKH_UNLOCK_SIZE)) * feeRate;
    return { coins, tx, fee, value: coins.reduce((s, u) => s + u.satoshis, 0n) - fee };
  };
  let p = plan(all.slice(0, 1));
  for (let n = 2; p.value < NFT_SATS + KEEP && n <= all.length; n++) p = plan(all.slice(0, n));
  if (p.value < NFT_SATS + DUST) throw new Error("Not enough BCH in the wallet to create a project");
  p.tx.outputs[0].valueSatoshis = p.value;
  const sourceOutputs: Output[] = p.coins.map((u) => ({ lockingBytecode: u.lock ?? publisherLock, valueSatoshis: u.satoshis }));
  return { transaction: p.tx, sourceOutputs, fee: p.fee, value: p.value, paths: p.coins.map((u) => u.path ?? PUBLISHER) };
};

export const buildSealTx = ({ record, commitment, publisherLock, funding, nft, holderLock, feeRate = 1n }: SealTxInput): UnsignedSealTx => {
  if (commitment.length > 40) throw new Error("NFT commitment is limited to 40 bytes");
  if ((record.kind === "move") !== !!holderLock) throw new Error("A hand-over needs the next maintainer's address, and only a hand-over takes one");
  const coins = largestFirst(funding.filter((u) => !u.token));
  let lead: Utxo;
  let category: Uint8Array;
  if (record.kind === "genesis") {
    const first = coins.find((u) => u.vout === 0);
    if (!first) throw new Error("Genesis needs a coin sitting at output 0. Send any small amount to yourself, then retry.");
    lead = first;
    category = hexToBin(first.txid);
  } else {
    if (!nft?.token?.nft || nft.token.nft.capability !== "mutable") throw new Error("Release, revoke and hand-over need the project's NFT in this wallet");
    lead = nft;
    category = nft.token.category;
  }
  const rest = coins.filter((u) => u !== lead);

  const outputs: Output[] = [
    { lockingBytecode: holderLock ?? publisherLock, valueSatoshis: NFT_SATS, token: { amount: 0n, category, nft: { capability: "mutable", commitment } } },
    { lockingBytecode: encodeRecord(record), valueSatoshis: 0n },
  ];
  const plan = (ordered: Utxo[]) => {
    const tx: Transaction = { version: 2, locktime: 0, inputs: inputsOf(ordered), outputs };
    const changeOut = { lockingBytecode: publisherLock, valueSatoshis: 0n };
    const withChange = { ...tx, outputs: [...outputs, changeOut] };
    const feeWithChange = BigInt(sizeWith(withChange, P2PKH_UNLOCK_SIZE)) * feeRate;
    const inputTotal = ordered.reduce((s, u) => s + u.satoshis, 0n);
    return { ordered, tx, changeOut, withChange, feeWithChange, inputTotal, change: inputTotal - NFT_SATS - feeWithChange };
  };
  let p = plan([lead]);
  for (let n = 1; p.change < KEEP && n <= rest.length; n++) p = plan([lead, ...rest.slice(0, n)]);

  const sourceOutputs: Output[] = p.ordered.map((u) => ({ lockingBytecode: u.lock ?? publisherLock, valueSatoshis: u.satoshis, token: u.token }));
  const paths = p.ordered.map((u) => u.path ?? PUBLISHER);
  if (p.change >= DUST) {
    p.changeOut.valueSatoshis = p.change;
    return { transaction: p.withChange, sourceOutputs, category, fee: p.feeWithChange, change: p.change, paths };
  }
  const fee = p.inputTotal - NFT_SATS;
  if (fee < BigInt(sizeWith(p.tx, P2PKH_UNLOCK_SIZE)) * feeRate) throw new Error("Not enough BCH in the wallet for the fee");
  return { transaction: p.tx, sourceOutputs, category, fee, change: 0n, paths };
};

// The next maintainer's address for a hand-over. Only a mainnet token address (z...): a wallet that hands one out can hold the
// NFT, while a plain q address may belong to a wallet that cannot see tokens and would spend the NFT away as fee money.
export const holderLockOf = (address: string, publisherLock: Uint8Array) => {
  const a = address.trim();
  const r = cashAddressToLockingBytecode(a.includes(":") ? a : `bitcoincash:${a}`);
  if (typeof r === "string" || r.prefix !== "bitcoincash") throw new Error("Not a Bitcoin Cash mainnet address");
  if (!r.tokenSupport) throw new Error("Use the new maintainer's token address (it starts with z), so the NFT lands in a wallet that can hold it");
  if (binToHex(r.bytecode) === binToHex(publisherLock)) throw new Error("That is this wallet's own address");
  return r.bytecode;
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

export type Send = (u: { transaction: Transaction; sourceOutputs: Output[]; fee: bigint; paths: WalletPath[] }, step: string) => Promise<string>;

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
