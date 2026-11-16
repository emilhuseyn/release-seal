// Re-reads every saved invitation from its shareable text form and checks it against its template with the engine's own
// validator, the same check a participant runs before accepting one.
import { readdirSync, readFileSync } from 'node:fs';
import { listInvitationValidationIssues } from '@xo-cash/engine';
import { deserializeInvitation } from '@xo-cash/utils';
import { closeEngine, here, json, openEngine } from './lib.mjs';
import { nip39LinkTemplate } from './templates/nip39-link.mjs';
import { releaseSealTemplate } from './templates/release-seal.mjs';

const engine = await openEngine();
try {
  await engine.importTemplate(releaseSealTemplate);
  await engine.importTemplate(nip39LinkTemplate);
  for (const f of readdirSync(`${here}invitations`).filter((n) => n.endsWith('.invitation.txt'))) {
    const inv = deserializeInvitation(readFileSync(`${here}invitations/${f}`, 'utf8'));
    const template = await engine.getTemplate(inv.templateIdentifier);
    if (!template) {
      console.log(f, 'template', inv.templateIdentifier, 'not stored (made with an earlier template version)');
      continue;
    }
    const issues = await listInvitationValidationIssues(inv, template, 'chipnet');
    console.log(f, inv.actionIdentifier, 'tx', inv.result?.transactions ? Object.keys(inv.result.transactions).join(',') : '-', 'issues:', issues.length ? json(issues) : 'none');
  }
} finally {
  await closeEngine(engine);
}
