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

The check does not depend on the website either. If `seal.json` is gone, cannot be fetched or was swapped, drop a copy from anywhere (a mirror,
a release asset) with the files: it counts only if its root is the one sealed on chain. With no list at all, dropping every file
of a release still works, because the files' own root is compared with the seal.

## Using it

Verify: open the page with `?project=<token category>` or paste the id, then drop the files you downloaded.

Seal: connect a wallet that speaks WizardConnect (Paytaca or Cashonize), create a project, drop the release files, enter the version
and the URL where `seal.json` will live, download `seal.json`, host it at that URL, then seal. A seal costs a few hundred satoshis
in fees, and 1,000 satoshis stay on the NFT.

Seal it now: to try it, connect the wallet, drop any file and press "Seal it now". The page creates a project named after the
file and seals it as v1, with the project page as its link. That takes two wallet confirmations (three if your coins first have
to move to output 0) and about 2,300 satoshis, 1,000 of which stay in your wallet on the NFT. Then open the project page and drop
the same file (green), then an edited copy (red).

From a release job: big installers do not need to pass through the browser. `seal-manifest.mjs` (served next to the page, no
dependencies, Node 18 or later) writes `seal.json` and prints the root:

```
node seal-manifest.mjs --project <id> --version v1.2.0 dist/app.zip dist/app.tar.gz
```

Publish `seal.json` with the release, then drop just that file on the Seal tab and confirm in the wallet. The page seals the list
it reads, and any release files dropped with it must be on that list. Copy the script into your own repo rather than fetching it
at build time, so a change on this site cannot reach your releases. No wallet key goes near the job.

Badge: an open project's page has a "Badge for your download page" box with HTML and Markdown to copy. The badge links to
`?project=<id>`, so a user who clicks it lands on the verify page with the project loaded and only has to drop the file.

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
