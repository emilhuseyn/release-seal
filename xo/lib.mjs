// Shared setup: a chipnet XO account from the test mnemonic in .xo-mnemonic (created on first run, never committed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateBip39Mnemonic, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';

export const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

export const openEngine = async () => {
  const mnemonicFile = `${here}.xo-mnemonic`;
  if (!existsSync(mnemonicFile)) writeFileSync(mnemonicFile, generateBip39Mnemonic());
  mkdirSync(`${here}.xo-data`, { recursive: true });
  return Engine.create(readFileSync(mnemonicFile, 'utf8').trim(), { network: XO_SUPPORTED_NETWORKS.chipnet, databasePath: `${here}.xo-data` });
};

// engine.stop() leaves an unhandled rejection behind some time after it returns (an empty AggregateError, logged in
// XO-FEEDBACK-NOTES.md), which crashes Node after the work is done. That one rejection is ignored for the life of the process.
process.on('unhandledRejection', (e) => {
  if (!(e instanceof AggregateError && e.errors.length === 0)) {
    console.error(e);
    process.exitCode = 1;
  }
});

export const closeEngine = async (engine) => {
  try {
    await engine.stop();
  } catch {
    // the same empty AggregateError, when it is the awaited one
  }
};

export const address = (lockHex, token = false) => {
  const a = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockHex), prefix: 'bchtest', tokenSupport: token });
  return typeof a === 'string' ? a : a.address;
};

export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x), 2);
