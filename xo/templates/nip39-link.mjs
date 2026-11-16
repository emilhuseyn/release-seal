// BCH Nostr ID's proof transaction as an XO template (BCH BLAZE 2026, "Build with XO").
// Input 0 spends a coin of the identity address, so only that address's key can make the transaction; output 0 is
// OP_RETURN <"nip39"> <"Verifying that I control the following Nostr public key: " + npub>, NIP-39's own verification text.
// The text is built by the template from the npub, so a wallet using it cannot be made to sign an arbitrary statement.
// A transaction made here passes the same check as the web page's (src/identity.ts decodeLink and readLinkTx).

const holderOnly = (variables) => ({ holder: { requirements: { variables, secrets: ['holderKey'] } } });
const participants = { participants: [{ role: 'holder', slots: { min: 1, max: 1 } }] };

export const nip39LinkTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'BCH Nostr ID',
  description:
    'Link a Bitcoin Cash address to a Nostr key with NIP-39: the address proves itself by spending a coin into an OP_RETURN that carries the verification text for the npub.',
  icon: 'identity',
  version: '1',
  supported: ['BCH_2025_05', 'BCH_2026_05'],
  defaults: {
    change: { output: 'changeOutput', role: 'holder', generate: ['holderKey'] },
    address: { lockingScript: 'identityLockingScript', role: 'holder', generate: ['holderKey'] },
    receive: { output: 'fundingOutput', role: 'holder', generate: ['holderKey'] },
  },
  roles: {
    holder: { name: 'Identity holder', description: 'Holds the key of the identity address.', icon: 'identity' },
    funder: { name: 'Funder', description: 'Pays the identity address.', icon: 'send' },
  },
  start: [{ action: 'fund', role: 'holder', generate: ['holderKey'] }],
  actions: {
    fund: {
      name: 'Fund identity address',
      description: 'Receive coins at an identity address.',
      icon: 'receive',
      roles: {
        holder: { name: 'Receive', description: 'Receive coins at the identity address.', icon: 'receive', requirements: { secrets: ['holderKey'] } },
        funder: { name: 'Send', description: 'Send coins to the identity address.', icon: 'send', requirements: {} },
      },
      requirements: { participants: [{ role: 'holder', slots: { min: 1, max: 1 } }, { role: 'funder', slots: { min: 1 } }] },
      transaction: 'fundTransaction',
    },
    linkNostrKey: {
      name: 'Link Nostr key',
      description: 'Prove that this address links to the Nostr key $(<nostrNpub>).',
      icon: 'identity',
      roles: holderOnly(['nostrNpub']),
      requirements: participants,
      transaction: 'linkTransaction',
    },
    revokeNostrLink: {
      name: 'Revoke Nostr link',
      description: 'Revoke this address link to the Nostr key $(<nostrNpub>).',
      icon: 'burn',
      roles: holderOnly(['nostrNpub']),
      requirements: participants,
      transaction: 'revokeTransaction',
    },
  },
  transactions: {
    fundTransaction: {
      name: 'Funded',
      description: 'Coins received at an identity address.',
      icon: 'receive',
      inputs: [],
      outputs: [{ output: 'fundingOutput' }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    linkTransaction: {
      name: 'Nostr key linked',
      description: 'This address now links to $(<nostrNpub>).',
      icon: 'identity',
      inputs: [{ input: 'identityInput', inputIndex: 0 }],
      outputs: [{ output: 'linkRecordOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    revokeTransaction: {
      name: 'Nostr link revoked',
      description: 'This address no longer links to $(<nostrNpub>).',
      icon: 'burn',
      inputs: [{ input: 'identityInput', inputIndex: 0 }],
      outputs: [{ output: 'revokeRecordOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
      composable: true,
    },
  },
  inputs: {
    identityInput: {
      name: 'Identity coin',
      description: 'A coin of the identity address; spending it is the proof of control.',
      icon: 'identity',
      unlockingScript: 'unlockP2PKH',
      token: null,
    },
  },
  outputs: {
    changeOutput: { name: 'Change', description: 'Coins returned as change.', icon: 'receive', lockingScript: 'identityLockingScript' },
    fundingOutput: {
      name: 'Identity coins',
      description: 'Coins at an identity address.',
      icon: 'receive',
      lockingScript: 'identityLockingScript',
      valueSatoshis: '$(<transferredSatoshis>)',
      token: null,
    },
    linkRecordOutput: { name: 'NIP-39 proof', description: 'Verification text for $(<nostrNpub>).', icon: 'identity', lockingScript: 'linkRecordLockingScript', valueSatoshis: '0', token: null },
    revokeRecordOutput: { name: 'NIP-39 revoke', description: 'Revoke text for $(<nostrNpub>).', icon: 'burn', lockingScript: 'revokeRecordLockingScript', valueSatoshis: '0', token: null },
  },
  lockingScripts: {
    identityLockingScript: {
      name: 'Identity address',
      description: 'An address that can link itself to a Nostr key.',
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'lockP2PKH',
      unlockingBytecode: 'unlockP2PKH',
      actions: [],
      roles: {
        holder: {
          state: { variables: [], secrets: ['holderKey'] },
          actions: [
            { action: 'linkNostrKey', role: 'holder', secrets: [{ holderKey: null }] },
            { action: 'revokeNostrLink', role: 'holder', secrets: [{ holderKey: null }] },
          ],
          balance: { satoshis: true },
          selectable: true,
        },
      },
    },
    linkRecordLockingScript: { name: 'NIP-39 proof', description: 'OP_RETURN with the NIP-39 verification text.', icon: 'identity', lockingType: 'p2s', lockingBytecode: 'linkRecord', actions: [], selectable: false },
    revokeRecordLockingScript: { name: 'NIP-39 revoke', description: 'OP_RETURN with the revoke text.', icon: 'burn', lockingType: 'p2s', lockingBytecode: 'revokeRecord', actions: [], selectable: false },
  },
  scripts: {
    lockP2PKH: 'OP_DUP OP_HASH160 <$(<holderKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    unlockP2PKH: '<holderKey.schnorr_signature.all_outputs> <holderKey.public_key>',
    linkRecord: 'OP_RETURN <"nip39"> <$(<"Verifying that I control the following Nostr public key: "> <nostrNpub> OP_CAT)>',
    revokeRecord: 'OP_RETURN <"nip39"> <$(<"Revoking my link to the following Nostr public key: "> <nostrNpub> OP_CAT)>',
  },
  constants: {},
  variables: {
    holderKey: { name: 'Identity Key', description: 'The key of the identity address.', type: 'private_key' },
    transferredSatoshis: { name: 'Amount', description: 'Satoshis sent to the identity address.', type: 'satoshis' },
    nostrNpub: { name: 'Nostr key', description: 'The npub (bech32, npub1...) of the Nostr key to link.', type: 'string' },
  },
  icons: ['identity', 'send', 'receive', 'burn', 'address'].map((name) => ({ name, hash: '0000000000000000000000' })),
};
