// Builds unsigned seal transactions. The wallet (WizardConnect) signs every P2PKH input; this module never sees a key.
// Genesis: input 0 must spend output 0 of some transaction, whose txid becomes the project's token category.
// Release and revoke: input 0 spends the current mutable NFT, output 0 recreates it with the new commitment.
import { encodeTransaction, hexToBin, type Output, type Transaction } from "@bitauth/libauth";
import { encodeRecord, type SealRecord } from "./seal";

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
const P2PKH_UNLOCK_SIZE = 100;

const sizeWith = (tx: Transaction, unlockSize: number) =>
  encodeTransaction({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, unlockingBytecode: new Uint8Array(unlockSize) })) }).length;

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
