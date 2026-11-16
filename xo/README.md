# Release Seal and BCH Nostr ID on XO

Two XO templates, run on chipnet with the XO engine, for the BCH BLAZE 2026 XO bounties.

| Template | Bounty | File | Identifier |
|---|---|---|---|
| Release Seal | Migrate to XO | [templates/release-seal.xo.json](templates/release-seal.xo.json) (source: [release-seal.mjs](templates/release-seal.mjs)) | `6e356655218d66e071597f951b4fe679d11ce9be62e81c4b1b0be8a02cd43d43` |
| BCH Nostr ID | Build with XO | [templates/nip39-link.xo.json](templates/nip39-link.xo.json) (source: [nip39-link.mjs](templates/nip39-link.mjs)) | `899a957f5a1a6812690855115822bb0ea7ec8397c368632602800a73dec8d7a4` |

`templates/used/` holds the exact template behind every saved invitation, named by identifier.

## Release Seal (migrated)

Original project: https://emilhuseyn.github.io/release-seal/ (source: the web app in this repo, transactions built by
hand in [`src/tx.ts`](../src/tx.ts)). XO actions now do the app's on-chain part, the project NFT and its seal records:

- `prepareGenesisCoin`: moves coins to output 0 of a new transaction, because a new token category must spend an output 0.
- `createProject`: spends that coin at input 0, mints the project's mutable NFT (empty release root) at output 0 and writes
  `OP_RETURN <"RSEAL"> <1> <0> <name> <url>` at output 1. The category is the txid of the coin it spent.
- `sealRelease` (follow-up on the maintainer script): spends the NFT at input 0, recreates it at output 0 with the Merkle
  root of the release files as its commitment, record `<1> <version> <file list URL>` at output 1.
- `revokeRelease` (follow-up): same NFT, commitment unchanged, record kind 2.

Transactions are byte-compatible with the web app: [`src/xo.test.ts`](../src/xo.test.ts) reads the chipnet transactions below
with the app's own `decodeRecord` and checks the NFT, its commitment (the Merkle root of `public/demo/v1.0.0`) and each record.

| Step | Invitation | Chipnet transaction |
|---|---|---|
| prepareGenesisCoin | [prepare](invitations/prepare.invitation.txt) | [748ad148…](https://chipnet.imaginary.cash/tx/748ad1488993c9c6ea4c353a30fbbdd54c986d072828c17f32fc5dc023366c38) |
| createProject | [create-xo-seal-demo](invitations/create-xo-seal-demo.invitation.txt) | [dd8eedcf…](https://chipnet.imaginary.cash/tx/dd8eedcfa5056a9c806054e41ab6dc68a8d575ce108c86066b04f4fd38a73453) |
| sealRelease v1.0.0 | [seal-v1.0.0](invitations/seal-v1.0.0.invitation.txt) | [dc7cb36f…](https://chipnet.imaginary.cash/tx/dc7cb36fe5b83f901afe6a59554ad098e9308646879ef88c84fc2ef801546455) |
| revokeRelease v1.0.0 | [revoke-v1.0.0](invitations/revoke-v1.0.0.invitation.txt) | [67a494b8…](https://chipnet.imaginary.cash/tx/67a494b8f3e4c76b3553ebe377987016aff4f4b745c8239e4aac9b247b4174a7) |

Project (token category): `748ad1488993c9c6ea4c353a30fbbdd54c986d072828c17f32fc5dc023366c38` on chipnet.

## BCH Nostr ID (new template)

The proof transaction of [BCH Nostr ID](https://emilhuseyn.github.io/release-seal/identity/) ([spec](../docs/identity.md)) as
XO actions on an identity address:

- `linkNostrKey` (follow-up on the identity script): spends a coin of the address at input 0 and writes
  `OP_RETURN <"nip39"> <"Verifying that I control the following Nostr public key: " + npub>`. The template builds the text
  from the npub with OP_CAT, so the wallet signs this statement and nothing else.
- `revokeNostrLink` (follow-up): the same with "Revoking my link to the following Nostr public key: ".

Change goes back to the identity address itself (`addChangeToInvitation` with that locking bytecode), so the address can
revoke later from the same coins. [`src/xo.test.ts`](../src/xo.test.ts) reads both records with the web page's
`decodeLink`.

| Step | Invitation | Chipnet transaction |
|---|---|---|
| linkNostrKey (first address, change went to a new key) | [link](invitations/link.invitation.txt) | [73168dc7…](https://chipnet.imaginary.cash/tx/73168dc7623070515a445397c3f82a67b96fcfcadda2bb27dfa37a8c2ffac03e) |
| linkNostrKey (identity address kept) | [link-ryjd4rep](invitations/link-ryjd4rep.invitation.txt) | [772dee7c…](https://chipnet.imaginary.cash/tx/772dee7cbb6513441a7deb7f1a352ebe98935d1f2a41a1348afbe11f42b1a910) |
| revokeNostrLink (same address) | [unlink-ryjd4rep](invitations/unlink-ryjd4rep.invitation.txt) | [09b64b9e…](https://chipnet.imaginary.cash/tx/09b64b9e2ca0ab47c2390c0521c0997fa64111324783a9c68da0ac5e1bd369f6) |

Demo npub: [invitations/demo-npub.txt](invitations/demo-npub.txt) (a throwaway key; only its public half was ever written).

## Reproduce

```
cd xo
npm install
node run.mjs coins                       # opens a chipnet account from .xo-mnemonic (created on first run, never committed)
node address.mjs                         # a Release Seal fee address; fund it from https://chipnet.bch.ninja/
node address.mjs nip39                   # a BCH Nostr ID identity address; fund it the same way
node run.mjs prepare 20000               # coins to output 0
node run.mjs create my-project https://example.org/
node run.mjs seal <category> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 <release root> v1.0.0 <file list URL>
node run.mjs revoke <category> <release root> v1.0.0 <file list URL>
node run.mjs link npub1...
node run.mjs unlink npub1...
node validate.mjs                        # every saved invitation checked against its template with the engine's validator
```

A release root is what the web app's Seal tab or `public/seal-manifest.mjs` prints for the release files. Each run writes
`invitations/<step>.invitation.txt` (the shareable form from `serializeInvitation`), `.invitation.json` and `.tx.hex`.

Engine and packages: `@xo-cash/engine 0.1.1-next.18029697917` and the versions pinned in [package.json](package.json).
