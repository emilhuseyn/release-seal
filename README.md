# Release Seal

Check that the file you downloaded is the file the maintainer shipped. The proof lives on Bitcoin Cash, not on the download page.

Live demo: https://emilhuseyn.github.io/release-seal/
Built for BCH BLAZE 2026, Mainnet track.

## Why

If someone takes over a project's website, they can swap the installer and the checksum printed next to it in one go. A checksum
only helps if it lives somewhere the attacker cannot edit. Release Seal puts it on Bitcoin Cash, in a transaction that only the
holder of the project's token can make.

## How it works

- A project is a CashTokens category. Its mutable NFT is the right to publish.
- Sealing a release spends that NFT and recreates it with a new 32-byte commitment: the Merkle root (RFC 6962 tree hash, SHA-256)
  of the release's file list, with the name, size and SHA-256 of each file.
- That transaction also carries an OP_RETURN record: `RSEAL`, protocol 1, the kind (create, release or revoke), the version, and a
  link to the file list (`seal.json`).
- Checking needs no wallet. The page reads the chain from public Fulcrum servers, follows the NFT from release to release, hashes
  the dropped files in the browser and compares them with the sealed list. Nothing is uploaded.

Sending the NFT to another address hands the project over. A revoke record marks a bad release, and the page then shows it in red.

The check does not depend on the website either. If `seal.json` is gone or cannot be fetched, drop a copy from anywhere (a mirror,
a release asset) with the files: it counts only if its root is the one sealed on chain. With no list at all, dropping every file
of a release still works, because the files' own root is compared with the seal.

## Using it

Verify: open the page with `?project=<token category>` or paste the id, then drop the files you downloaded.

Seal: connect a wallet that speaks WizardConnect (Paytaca or Cashonize), create a project, drop the release files, enter the version
and the URL where `seal.json` will live, download `seal.json`, host it at that URL, then seal. A seal costs a few hundred satoshis
in fees, and 1,000 satoshis stay on the NFT.

## Status

Transactions are built in the browser with libauth. Tests sign them with throwaway keys on dummy coins and run them through
libauth's Bitcoin Cash virtual machine, token rules included. A first mainnet project will be linked here once it is sealed.

## Development

```
npm install
npm test
npm run dev
npm run build
```

## Licence

MIT, see LICENSE. The WizardConnect packages are LGPL-3.0 and are used as unmodified libraries.
