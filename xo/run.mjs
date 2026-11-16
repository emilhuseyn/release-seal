// Runs the XO actions of both templates on chipnet and saves every invitation under invitations/.
//   node run.mjs coins                                   list the account's coins per template
//   node run.mjs create <name> <url>                     Release Seal: create a project (genesis)
//   node run.mjs seal <category> <currentRoot> <releaseRoot> <version> <url>
//   node run.mjs revoke <category> <currentRoot> <version> <url>
//   node run.mjs link <npub>                             BCH Nostr ID: link the identity address to a Nostr key
//   node run.mjs unlink <npub>                           BCH Nostr ID: revoke that link
import { mkdirSync, writeFileSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { getTemplateLockingScriptOrThrow } from '@xo-cash/engine';
import { serializeInvitation } from '@xo-cash/utils';
import { nip39LinkTemplate } from './templates/nip39-link.mjs';
import { releaseSealTemplate } from './templates/release-seal.mjs';
import { address, closeEngine, here, json, openEngine } from './lib.mjs';

const [cmd, ...args] = process.argv.slice(2);
const engine = await openEngine();

const use = async (template) => {
  const { templateIdentifier } = await engine.importTemplate(template);
  await engine.setDefaultPolicies({ change: { templateIdentifier }, receive: { templateIdentifier }, address: { templateIdentifier } });
  return templateIdentifier;
};

// the account's coins on a locking script of this name, under any version of the template: the template identifier is a hash
// of its content, so every edit gives coins received earlier a different identifier
const coinsOf = async (lockingScriptIdentifier) => {
  const out = [];
  for (const u of await engine.listSpendableUnspentOutputs()) {
    const [script] = await engine.listScriptHashData({ scriptHash: u.scriptHash });
    if (script?.lockingScriptIdentifier === lockingScriptIdentifier) out.push({ ...u, script });
  }
  return out;
};

// the follow-up intent for `action` on the coin's own locking script (it reuses the key that coin's script holds)
const followUp = async (template, coin, action) => {
  const ls = getTemplateLockingScriptOrThrow(template, coin.script.lockingScriptIdentifier);
  const intents = [...(ls.actions ?? []), ...(coin.script.roleIdentifier ? ls.roles?.[coin.script.roleIdentifier]?.actions ?? [] : [])];
  const intent = intents.find((i) => i.action === action);
  if (!intent) throw new Error(`no ${action} intent on ${coin.script.lockingScriptIdentifier}`);
  return intent;
};

const missing = async (id, step) => {
  const m = await engine.listMissingRequirements(id);
  console.log(`[${step}] missing:`, json(m));
  return m;
};

const run = async ({ name, templateIdentifier, actionIdentifier, intent, variables, input, outputs, feeScript = 'maintainerLockingScript', keepChange = false }) => {
  const role = intent.role;
  const created = await engine.createInvitation({
    templateIdentifier,
    actionIdentifier,
    intent,
    variables: Object.entries(variables).map(([variableIdentifier, value]) => ({ variableIdentifier, roleIdentifier: role, value })),
    inputs: [{ outpointTransactionHash: hexToBin(input.outpointTransactionHash), outpointIndex: input.outpointIndex, inputIdentifier: input.inputIdentifier }],
  });
  const id = created.invitation.invitationIdentifier;
  console.log('invitation', id);
  try {
    return await finish(id, { name, templateIdentifier, actionIdentifier, role, outputs, input, feeScript, keepChange });
  } catch (e) {
    // a failed invitation keeps its input reserved until it is archived
    await engine.archiveInvitation(id);
    throw e;
  }
};

const finish = async (id, { name, templateIdentifier, actionIdentifier, role, outputs, input, feeScript, keepChange }) => {
  await missing(id, 'after create');
  // only outputs whose locking script has the role get it (the OP_RETURN record scripts have none)
  const template = await engine.getTemplate(templateIdentifier);
  const withRole = (o) => !!template.lockingScripts[template.outputs[o].lockingScript]?.roles?.[role];
  await engine.appendInvitation(id, {
    templateIdentifier,
    actionIdentifier,
    outputs: outputs.map((outputIdentifier) => (withRole(outputIdentifier) ? { outputIdentifier, roleIdentifier: role } : { outputIdentifier })),
  });
  await missing(id, 'after outputs');
  let leftover = await engine.calculateChange(id);
  let fee = await engine.estimateTransactionFee(id);
  console.log('leftover', json(leftover), 'fee', fee);
  // the engine adds no fee input by itself: when the template's own inputs do not cover the fee, add the largest plain coin
  if (leftover.valueSatoshis < BigInt(fee)) {
    const used = new Set([`${input.outpointTransactionHash}:${input.outpointIndex}`]);
    const fund = (await coinsOf(feeScript)).filter((c) => !c.tokenCategory && !used.has(`${c.outpointTransactionHash}:${c.outpointIndex}`)).sort((a, b) => (a.templateIdentifier === templateIdentifier) - (b.templateIdentifier === templateIdentifier) || (BigInt(b.valueSatoshis) > BigInt(a.valueSatoshis) ? 1 : -1)).reverse()[0];
    if (!fund) throw new Error('no plain coin to pay the fee');
    console.log('fee input', `${fund.outpointTransactionHash}:${fund.outpointIndex}`, fund.valueSatoshis);
    await engine.appendInvitation(id, { templateIdentifier, actionIdentifier, inputs: [{ outpointTransactionHash: hexToBin(fund.outpointTransactionHash), outpointIndex: fund.outpointIndex }] });
    leftover = await engine.calculateChange(id);
    fee = await engine.estimateTransactionFee(id);
    console.log('leftover', json(leftover), 'fee', fee);
  }
  // keepChange: change back to the input's own address (an identity address must keep its coins to revoke later);
  // otherwise the template's change policy, which derives a new key per change output
  if (leftover.valueSatoshis - BigInt(fee) >= 546n || leftover.tokens.length > 0) await engine.addChangeToInvitation(id, keepChange ? input.script.lockingBytecode : undefined);
  for (const i of await engine.listOwnInputIndexes(id)) await engine.signInvitation(id, i);
  await missing(id, 'after sign');
  const { builtTransaction, storedInvitation } = await engine.executeAction(id, { broadcastTransaction: true });
  console.log('broadcast', builtTransaction.transactionHash, builtTransaction.transactionByteLength, 'bytes');
  mkdirSync(`${here}invitations`, { recursive: true });
  writeFileSync(`${here}invitations/${name}.invitation.txt`, serializeInvitation(storedInvitation.invitation));
  writeFileSync(`${here}invitations/${name}.invitation.json`, json(storedInvitation.invitation));
  writeFileSync(`${here}invitations/${name}.tx.hex`, builtTransaction.serializedTransaction);
  return builtTransaction.transactionHash;
};

try {
  if (cmd === 'archive') {
    for (const s of await engine.listInvitations()) {
      if (!s.invitation.result) {
        await engine.archiveInvitation(s.invitation.invitationIdentifier);
        console.log('archived', s.invitation.invitationIdentifier, s.invitation.actionIdentifier);
      }
    }
  } else if (cmd === 'coins') {
    for (const [t, ls] of [[releaseSealTemplate, 'maintainerLockingScript'], [nip39LinkTemplate, 'identityLockingScript']]) {
      await use(t);
      for (const c of await coinsOf(ls))
        console.log(t.name, c.script.lockingScriptIdentifier, address(c.script.lockingBytecode, true), `${c.outpointTransactionHash}:${c.outpointIndex}`, c.valueSatoshis, c.tokenCategory ? `token ${c.tokenCategory} ${c.tokenNftCapability ?? ''} ${c.tokenNftCommitment ?? ''}` : '');
    }
  } else if (cmd === 'prepare') {
    // any plain coin of the account (also one tracked under an earlier version of the template) to output 0
    const tid = await use(releaseSealTemplate);
    const all = [];
    for (const u of await engine.listSpendableUnspentOutputs()) {
      const [script] = await engine.listScriptHashData({ scriptHash: u.scriptHash });
      if (script?.lockingScriptIdentifier === 'maintainerLockingScript' && !u.tokenCategory) all.push({ ...u, script });
    }
    const coin = all.sort((a, b) => (BigInt(b.valueSatoshis) > BigInt(a.valueSatoshis) ? 1 : -1))[0];
    if (!coin) throw new Error('no plain maintainer coin');
    console.log('spending', `${coin.outpointTransactionHash}:${coin.outpointIndex}`, coin.valueSatoshis, 'template', coin.templateIdentifier);
    // a fresh maintainer key for the output: the coin may sit under an earlier template version whose secret this invitation cannot use
    const intent = { action: 'prepareGenesisCoin', role: 'maintainer', generate: ['maintainerKey'] };
    await run({
      name: 'prepare',
      templateIdentifier: tid,
      actionIdentifier: 'prepareGenesisCoin',
      intent,
      variables: { genesisSatoshis: BigInt(args[0] ?? 20000) },
      input: { ...coin, inputIdentifier: 'feeInput' },
      outputs: ['genesisCoinOutput'],
    });
  } else if (cmd === 'create') {
    const tid = await use(releaseSealTemplate);
    const coin = (await coinsOf('maintainerLockingScript')).find((c) => c.outpointIndex === 0 && !c.tokenCategory);
    if (!coin) throw new Error('no plain coin at output 0 of its transaction; genesis needs one');
    const intent = coin.templateIdentifier === tid ? await followUp(releaseSealTemplate, coin, 'createProject') : { action: 'createProject', role: 'maintainer', generate: ['maintainerKey'] };
    const txid = await run({
      name: `create-${args[0]}`,
      templateIdentifier: tid,
      actionIdentifier: 'createProject',
      intent,
      variables: { projectCategory: coin.outpointTransactionHash, recordVersion: args[0], recordUrl: args[1] },
      input: { ...coin, inputIdentifier: 'genesisInput' },
      outputs: ['projectGenesisOutput', 'createdRecordOutput'],
    });
    console.log('project id (category):', coin.outpointTransactionHash, 'genesis tx', txid);
  } else if (cmd === 'seal' || cmd === 'revoke') {
    const tid = await use(releaseSealTemplate);
    const [category, currentRoot] = args;
    const nft = (await coinsOf('maintainerLockingScript')).find((c) => c.tokenCategory === category);
    if (!nft) throw new Error(`no NFT of category ${category} in the account`);
    const action = cmd === 'seal' ? 'sealRelease' : 'revokeRelease';
    const vars = cmd === 'seal' ? { projectCategory: category, currentRoot, releaseRoot: args[2], recordVersion: args[3], recordUrl: args[4] } : { projectCategory: category, currentRoot, recordVersion: args[2], recordUrl: args[3] };
    await run({
      name: `${cmd}-${vars.recordVersion}`,
      templateIdentifier: tid,
      actionIdentifier: action,
      intent: await followUp(releaseSealTemplate, nft, action),
      variables: vars,
      input: { ...nft, inputIdentifier: 'projectNftInput' },
      outputs: cmd === 'seal' ? ['projectReleaseOutput', 'sealedRecordOutput'] : ['projectKeptOutput', 'revokedRecordOutput'],
    });
  } else if (cmd === 'link' || cmd === 'unlink') {
    const tid = await use(nip39LinkTemplate);
    const coin = (await coinsOf('identityLockingScript')).filter((c) => !c.tokenCategory).sort((a, b) => (BigInt(b.valueSatoshis) > BigInt(a.valueSatoshis) ? 1 : -1))[0];
    if (!coin) throw new Error('no coin at an identity address');
    const action = cmd === 'link' ? 'linkNostrKey' : 'revokeNostrLink';
    await run({
      name: `${cmd}-${address(coin.script.lockingBytecode).slice(-8)}`,
      templateIdentifier: tid,
      actionIdentifier: action,
      intent: await followUp(nip39LinkTemplate, coin, action),
      variables: { nostrNpub: args[0] },
      input: { ...coin, inputIdentifier: 'identityInput' },
      outputs: [cmd === 'link' ? 'linkRecordOutput' : 'revokeRecordOutput'],
      feeScript: 'identityLockingScript',
      keepChange: true,
    });
    console.log('identity address', address(coin.script.lockingBytecode));
  } else {
    console.log('commands: coins | create | seal | revoke | link | unlink');
  }
} catch (e) {
  console.error('FAILED:', e?.constructor?.name, e?.message);
  if (e?.cause) console.error('cause:', e.cause);
  process.exitCode = 1;
} finally {
  await closeEngine(engine);
}
