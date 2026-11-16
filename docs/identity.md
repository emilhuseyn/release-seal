# BCH Nostr ID: linking a Bitcoin Cash address and a Nostr key

Live: https://emilhuseyn.github.io/release-seal/identity/
Code: [`src/identity.ts`](../src/identity.ts) (protocol and verification, no browser APIs),
[`src/nostr.ts`](../src/nostr.ts) (relays and signers), [`src/IdentityApp.tsx`](../src/IdentityApp.tsx) (the page),
tests in [`src/identity.test.ts`](../src/identity.test.ts).

Built for the BCH BLAZE 2026 bounty "Decentralized Identity" (Paytaca).

## The idea in one paragraph

NIP-39 already lets a Nostr key claim identities on other platforms: a kind 10011 event lists `["i", "<platform>:<name>",
"<proof>"]` tags, and the proof is a post on that platform, made by that account, containing the text "Verifying that I control
the following Nostr public key: <npub>". This project adds Bitcoin Cash as a platform. The account is an address, and the
post is a transaction: its input 0 spends a coin of the address, so only the address's key can sign it, and its OP_RETURN
carries the same verification text. Each key signs only for itself. Nothing new has to be trusted, and any NIP-39 client can
learn the `bch` platform from the rules below.

## Records

BCH side, the proof (or revoke) transaction:

| | |
|---|---|
| input 0 | spends a coin locked to the identity address (P2PKH in this implementation) |
| one output | `OP_RETURN <"nip39"> <"Verifying that I control the following Nostr public key: npub1...">` |
| revoke | same, text `"Revoking my link to the following Nostr public key: npub1..."` |
| other outputs | free; the page sends the change back to the identity address |

The script is 130 bytes, under the 223-byte relay limit.

Nostr side, the claim (NIP-39, kind 10011, replaceable):

```json
{ "kind": 10011, "tags": [["i", "bch:qzrq9aav...", "<txid of the proof>"], ["i", "github:someone", "<gist>"]], ... }
```

The name is the CashAddress in its plain `q` form without `bitcoincash:`, lower case, as NIP-39 asks names to be normalised.
Verifiers accept any mainnet form (q or z, with or without the prefix) and compare locking bytecode. The page keeps the
user's other `i` tags when it publishes and replaces only `bch:` ones.

## Verification

From a Nostr key (`verifyFromNostr`):

1. Fetch kind 10011 events by the key from several relays. Keep only events whose NIP-01 signature verifies (checked on a
   fresh copy of the seven fields, see Security). Take the newest.
2. Read its `bch:` claim: address and txid.
3. Fetch the txid from any Fulcrum/Electrum server. Its OP_RETURN must carry the verification text for this npub, and the
   output spent by input 0 (read from its parent transaction) must be locked to the claimed address. The network has already
   checked the signature on that input, so this proves the address's key made the statement.
4. Read the address's history: its newest link record must still name this key. A later link to another key or a revoke of
   this one ends the claim.

From a BCH address (`verifyFromAddress`): read the address's history for link records (input 0 from the address, OP_RETURN as
above). The newest one names the current key; then run the steps above for that key and also require that its claim names the
address back. A single directory is never needed: relays answer for keys, any BCH server answers for addresses.

Every step reads public data and checks signatures locally; no identity authority is contacted.

## Signing in

An app sends a random 32-byte challenge. The user signs a NIP-42 shaped auth event (kind 22242) with tags
`["relay", <app origin>]` and `["challenge", <challenge>]` with their Nostr key (extension or local key). The app checks
`checkAuth`: kind, challenge, origin, age under 10 minutes, signature. It then runs `verifyFromNostr` on the event's key and
knows the user's verified BCH address. Challenges are single use.

## Paying by identity

Type an npub, get its verified address, pay it. The page refuses to offer payment unless every check passed.

## Key rotation and recovery

- New Nostr key: the address publishes a new link record for the new key and the new key publishes its claim. Verifiers take
  the address's newest record, so the old key's claim stops verifying the moment the new proof is mined or in the mempool.
  Continuity is anchored on the BCH key.
- Lost or leaked Nostr key: the BCH key revokes (or relinks), so a thief holding the Nostr key cannot keep the link alive.
- New BCH address: the Nostr key publishes a claim naming the new address and its proof; the old address can revoke.
- Ordering is by block height (mempool last), which off-chain signatures alone would not give.

## Why a transaction and not a signed message

- WizardConnect wallets (Cashonize, Paytaca, Selene) sign transactions, not free-form messages, so a transaction works with
  the wallets people already have.
- Discovery from the BCH side comes for free: an address's own history holds its records, on any server.
- Revocation and rotation get an order (block height) that nobody can backdate.
- The cost is one small transaction, a few hundred satoshis, and the change returns to the same address.

## Security notes

- No private key is exposed or shared: the wallet signs the BCH proof, the extension or local key signs Nostr events.
- A claim is only as fresh as the relays and the server answering. The page asks five relays and reads the chain from one
  of seven public Fulcrum servers, moving to the next if one fails.
- nostr-tools caches a verification verdict on the event object under a symbol, and a spread copy keeps it. Verification here
  rebuilds the event from its seven NIP-01 fields first, so an event edited after verifying fails (tested).
- Only input 0 counts as the proof. Other inputs may come from anywhere and do not make claims.
- Revoke comes from the wallet's current largest coin's address; it must be the identity address to take effect.

## Run it

```
npm install
npm test        # identity tests: signed transactions in libauth's BCH VM, signed Nostr events, fake relay and server
npm run dev     # then open /identity/index.html
npm run build
```

## Reuse

`src/identity.ts` has no browser dependencies: `encodeLink`, `decodeLink`, `buildLinkTx`, `verifyFromNostr`,
`verifyFromAddress`, `identitiesTemplate`, `authTemplate`, `checkAuth`. A wallet can add a "Link Nostr" button with
`buildLinkTx` and its own signer; a Nostr client can show a verified BCH badge with `verifyFromNostr` and any Electrum server.
