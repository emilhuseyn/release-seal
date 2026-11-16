// Prints the fee address of the Release Seal template account on chipnet (q form and token-aware z form).
import { nip39LinkTemplate } from './templates/nip39-link.mjs';
import { releaseSealTemplate } from './templates/release-seal.mjs';
import { address, closeEngine, openEngine } from './lib.mjs';

const engine = await openEngine();
try {
  const which = process.argv[2] === 'nip39' ? nip39LinkTemplate : releaseSealTemplate;
  const { templateIdentifier } = await engine.importTemplate(which);
  await engine.setDefaultPolicies({ change: { templateIdentifier }, receive: { templateIdentifier }, address: { templateIdentifier } });
  const lock = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
  console.log(which.name, 'q', address(lock));
  console.log(which.name, 'z', address(lock, true));
  const coins = await engine.listUnspentOutputs();
  console.log('coins', coins.length, coins.map((c) => `${c.outpointTransactionHash}:${c.outpointIndex} ${c.valueSatoshis}`).join(' '));
} finally {
  await closeEngine(engine);
}
