// Release seal protocol, version 1.
// A release is a manifest of files. Its Merkle root (RFC 6962 tree hash, SHA-256) is the 32-byte commitment of the project's
// mutable NFT. The same transaction carries an OP_RETURN: <"RSEAL"> <0x01> <kind> <release version> <manifest URL>.
import { binToHex, encodeDataPush, hexToBin, Opcodes, sha256, utf8ToBin, binToUtf8 } from "@bitauth/libauth";

export const PREFIX = utf8ToBin("RSEAL");
export const PROTOCOL = 1;
export const KIND = { genesis: 0, release: 1, revoke: 2 } as const;
export type Kind = keyof typeof KIND;

export interface FileEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  protocol: number;
  project: string;
  version: string;
  files: FileEntry[];
}

export interface SealRecord {
  kind: Kind;
  version: string;
  manifestUrl: string;
}

const u64le = (n: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const hashBytes = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));

export const entryFor = (name: string, bytes: Uint8Array): FileEntry => ({ name, size: bytes.length, sha256: hashBytes(bytes) });

// Files are sorted by name so the root does not depend on the order they were dropped in.
export const sortFiles = (files: FileEntry[]) => [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const leafData = (f: FileEntry) => {
  const name = utf8ToBin(f.name);
  return concat(u64le(name.length), name, u64le(f.size), hexToBin(f.sha256));
};

const leafHash = (d: Uint8Array) => sha256.hash(concat(Uint8Array.of(0), d));
const nodeHash = (l: Uint8Array, r: Uint8Array) => sha256.hash(concat(Uint8Array.of(1), l, r));

// RFC 6962 section 2.1: split at the largest power of two below n.
const mth = (leaves: Uint8Array[]): Uint8Array => {
  if (leaves.length === 0) return sha256.hash(new Uint8Array());
  if (leaves.length === 1) return leafHash(leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
};

export const merkleRoot = (files: FileEntry[]) => mth(sortFiles(files).map(leafData));

export const findDuplicates = (files: FileEntry[]) => {
  const seen = new Set<string>();
  return files.filter((f) => (seen.has(f.name) ? true : (seen.add(f.name), false))).map((f) => f.name);
};

export const encodeRecord = (r: SealRecord) => {
  const body = [PREFIX, Uint8Array.of(PROTOCOL), Uint8Array.of(KIND[r.kind]), utf8ToBin(r.version), utf8ToBin(r.manifestUrl)];
  const script = concat(Uint8Array.of(Opcodes.OP_RETURN), ...body.map((b) => encodeDataPush(b)));
  if (script.length > 223) throw new Error(`OP_RETURN is ${script.length} bytes, the relay limit is 223`);
  return script;
};

// Reads the pushes after OP_RETURN. Returns undefined for anything that is not a version 1 seal record.
export const decodeRecord = (script: Uint8Array): SealRecord | undefined => {
  if (script[0] !== Opcodes.OP_RETURN) return undefined;
  const pushes: Uint8Array[] = [];
  let i = 1;
  while (i < script.length) {
    const op = script[i++];
    let len: number;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === Opcodes.OP_PUSHDATA_1) len = script[i++];
    else if (op === Opcodes.OP_PUSHDATA_2) {
      len = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === Opcodes.OP_0) len = 0;
    else if (op >= Opcodes.OP_1 && op <= Opcodes.OP_16) {
      pushes.push(Uint8Array.of(op - Opcodes.OP_1 + 1));
      continue;
    } else return undefined;
    if (i + len > script.length) return undefined;
    pushes.push(script.slice(i, i + len));
    i += len;
  }
  if (pushes.length !== 5 || binToHex(pushes[0]) !== binToHex(PREFIX)) return undefined;
  const proto = pushes[1].length ? pushes[1][0] : 0;
  const kindNum = pushes[2].length ? pushes[2][0] : 0;
  const kind = (Object.keys(KIND) as Kind[]).find((k) => KIND[k] === kindNum);
  if (proto !== PROTOCOL || !kind) return undefined;
  return { kind, version: binToUtf8(pushes[3]), manifestUrl: binToUtf8(pushes[4]) };
};

export interface Check {
  name: string;
  status: "match" | "changed" | "unknown";
  expected?: FileEntry;
}

// A second download of the same file is saved as "name (1).ext" (Chrome) or "name(1).ext" (Firefox); match it to "name.ext".
export const undupName = (name: string) => name.replace(/ ?\(\d+\)(?=\.|$)/, "");

// Reads a seal.json from anywhere (a mirror, a release asset, the user's disk). Only its root against the chain makes it trusted.
export const parseManifest = (text: string): Manifest | undefined => {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (m?.protocol !== PROTOCOL || !Array.isArray(m.files)) return undefined;
  const ok = (f: FileEntry) => typeof f?.name === "string" && Number.isSafeInteger(f.size) && /^[0-9a-f]{64}$/i.test(f.sha256);
  if (!m.files.every(ok)) return undefined;
  const files = m.files.map((f: FileEntry) => ({ name: f.name, size: f.size, sha256: f.sha256.toLowerCase() }));
  return { protocol: PROTOCOL, project: String(m.project ?? ""), version: String(m.version ?? ""), files };
};

// With no file list at all: the dropped files are exactly the release when their own root is the commitment.
export const isWholeRelease = (dropped: FileEntry[], commitment: Uint8Array) => {
  const want = binToHex(commitment);
  return [dropped, dropped.map((d) => ({ ...d, name: undupName(d.name) }))].some(
    (set) => set.length > 0 && !findDuplicates(set).length && binToHex(merkleRoot(set)) === want,
  );
};

// Compares dropped files with a manifest whose root matches the on-chain commitment.
export const checkFiles = (manifest: Manifest, commitment: Uint8Array, dropped: FileEntry[]) => {
  const rootOk = binToHex(merkleRoot(manifest.files)) === binToHex(commitment);
  const byName = new Map(manifest.files.map((f) => [f.name, f]));
  const byHash = new Map(manifest.files.map((f) => [f.sha256, f]));
  const checks: Check[] = dropped.map((d) => {
    const exp = byName.get(d.name) ?? byHash.get(d.sha256) ?? byName.get(undupName(d.name));
    if (!exp) return { name: d.name, status: "unknown" };
    return { name: d.name, status: exp.sha256 === d.sha256 && exp.size === d.size ? "match" : "changed", expected: exp };
  });
  return { rootOk, checks };
};
