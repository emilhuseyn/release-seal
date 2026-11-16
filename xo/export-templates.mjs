// Writes, for every saved invitation, the exact template it was made with (by identifier) to templates/used/<id>.json,
// and prints the identifier of the current template files.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serializeTemplate } from '@xo-cash/utils';
import { deserializeInvitation } from '@xo-cash/utils';
import { closeEngine, here, openEngine } from './lib.mjs';
import { nip39LinkTemplate } from './templates/nip39-link.mjs';
import { releaseSealTemplate } from './templates/release-seal.mjs';

const engine = await openEngine();
try {
  for (const t of [releaseSealTemplate, nip39LinkTemplate]) {
    const { templateIdentifier } = await engine.importTemplate(t);
    console.log('current', t.name, templateIdentifier);
    writeFileSync(`${here}templates/${t.name === 'Release Seal' ? 'release-seal' : 'nip39-link'}.xo.json`, serializeTemplate(t));
  }
  mkdirSync(`${here}templates/used`, { recursive: true });
  for (const f of readdirSync(`${here}invitations`).filter((n) => n.endsWith('.invitation.txt'))) {
    const inv = deserializeInvitation(readFileSync(`${here}invitations/${f}`, 'utf8'));
    const t = await engine.getTemplate(inv.templateIdentifier);
    writeFileSync(`${here}templates/used/${inv.templateIdentifier}.json`, serializeTemplate(t));
    console.log(f, '->', inv.templateIdentifier);
  }
} finally {
  await closeEngine(engine);
}
