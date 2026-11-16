// Imports the templates into a chipnet account and prints each one's identifier and a receive address.
import { writeFileSync } from 'node:fs';
import { nip39LinkTemplate } from './templates/nip39-link.mjs';
import { releaseSealTemplate } from './templates/release-seal.mjs';
import { address, closeEngine, here, json, openEngine } from './lib.mjs';

const engine = await openEngine();
try {
  for (const [file, t] of [['release-seal', releaseSealTemplate], ['nip39-link', nip39LinkTemplate]]) {
    writeFileSync(`${here}templates/${file}.xo.json`, json(t));
    try {
      const { templateIdentifier } = await engine.importTemplate(t);
      console.log(file, 'imported', templateIdentifier);
    } catch (e) {
      console.log(file, 'IMPORT FAILED:', e?.constructor?.name, e?.message);
      if (e?.issues || e?.errors) console.log(json(e.issues ?? e.errors).slice(0, 3000));
    }
  }
} finally {
  await closeEngine(engine);
}
