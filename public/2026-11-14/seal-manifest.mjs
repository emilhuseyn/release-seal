#!/usr/bin/env node
// Writes the seal.json of a release and prints the Merkle root that the Seal tab puts on chain (Release Seal protocol 1).
// No dependencies, Node 18 or later, so a release job can run it next to its build. Same root as src/seal.ts (src/cli.test.ts).
//   node seal-manifest.mjs --project <id> --version v1.2.0 [--out seal.json] dist/app.zip dist/app.tar.gz
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

const leafData = (f) => {
  const name = Buffer.from(f.name, "utf8");
  return Buffer.concat([u64le(name.length), name, u64le(f.size), Buffer.from(f.sha256, "hex")]);
};

// RFC 6962 tree hash with 0x00 leaf and 0x01 node prefixes, split at the largest power of two below n.
const mth = (leaves) => {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return sha256(Buffer.of(0), leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(Buffer.of(1), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const merkleRoot = (files) => mth([...files].sort(byName).map(leafData)).toString("hex");

const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const args = process.argv.slice(2);
const opts = { project: "", version: "", out: "seal.json" };
const paths = [];
for (let i = 0; i < args.length; i++) {
  const flag = args[i].replace(/^--/, "");
  if (args[i].startsWith("--") && flag in opts) opts[flag] = args[++i] ?? fail(`${args[i - 1]} needs a value`, 2);
  else paths.push(args[i]);
}
if (!paths.length) fail("usage: node seal-manifest.mjs --project <id> --version <v> [--out seal.json] FILE...", 2);
if (opts.project && !/^[0-9a-f]{64}$/.test(opts.project)) fail("--project is the 64-hex project id the Seal tab printed");

const files = [];
for (const p of paths) {
  if (!statSync(p).isFile()) fail(`${p} is not a file; pass the release files themselves`);
  // A seal.json is the list, never a file of the release: Verify reads a dropped seal.json as a list.
  if (basename(p) === "seal.json") continue;
  const bytes = readFileSync(p);
  files.push({ name: basename(p), size: bytes.length, sha256: sha256(bytes).toString("hex") });
}
const seen = new Set();
for (const f of files) {
  if (seen.has(f.name)) fail(`two files are named ${f.name}; names must be unique within a release`);
  seen.add(f.name);
}

writeFileSync(opts.out, JSON.stringify({ protocol: 1, project: opts.project, version: opts.version, files }, null, 2));
console.error(`${files.length} files written to ${opts.out}`);
console.log(merkleRoot(files));
