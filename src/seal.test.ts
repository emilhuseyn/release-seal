import { binToHex, hexToBin, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { checkFiles, decodeRecord, encodeRecord, entryFor, findDuplicates, merkleRoot, type Manifest } from "./seal";

const files = ["a.tar.gz", "b.zip", "c.txt", "d.sig", "e.json"].map((n) => entryFor(n, utf8ToBin(`content of ${n}`)));

describe("merkleRoot", () => {
  it("does not depend on file order", () => {
    expect(binToHex(merkleRoot(files))).toBe(binToHex(merkleRoot([...files].reverse())));
  });

  it("is a 32-byte commitment and changes when one byte changes", () => {
    const root = merkleRoot(files);
    expect(root.length).toBe(32);
    const tampered = files.map((f, i) => (i === 2 ? entryFor(f.name, utf8ToBin("content of c.txu")) : f));
    expect(binToHex(merkleRoot(tampered))).not.toBe(binToHex(root));
  });

  it("matches RFC 6962 for one and three leaves", () => {
    const leaf = (f: (typeof files)[number]) => {
      const name = utf8ToBin(f.name);
      const out = new Uint8Array(1 + 8 + name.length + 8 + 32);
      const dv = new DataView(out.buffer);
      out[0] = 0;
      dv.setBigUint64(1, BigInt(name.length), true);
      out.set(name, 9);
      dv.setBigUint64(9 + name.length, BigInt(f.size), true);
      out.set(hexToBin(f.sha256), 17 + name.length);
      return sha256.hash(out);
    };
    const node = (l: Uint8Array, r: Uint8Array) => sha256.hash(Uint8Array.from([1, ...l, ...r]));
    const [a, b, c] = files;
    expect(binToHex(merkleRoot([a]))).toBe(binToHex(leaf(a)));
    expect(binToHex(merkleRoot([a, b, c]))).toBe(binToHex(node(node(leaf(a), leaf(b)), leaf(c))));
  });

  it("separates name and size so moved bytes do not collide", () => {
    const x = [entryFor("ab", utf8ToBin("c"))];
    const y = [{ ...x[0], name: "a" }];
    expect(binToHex(merkleRoot(x))).not.toBe(binToHex(merkleRoot(y)));
  });
});

describe("records", () => {
  it("round-trips a release record", () => {
    const r = { kind: "release" as const, version: "v1.2.0", manifestUrl: "https://example.org/releases/v1.2.0/seal.json" };
    expect(decodeRecord(encodeRecord(r))).toEqual(r);
  });

  it("rejects other OP_RETURN data", () => {
    expect(decodeRecord(Uint8Array.from([0x6a, 0x04, ...utf8ToBin("MEMO")]))).toBeUndefined();
    expect(decodeRecord(Uint8Array.from([0x76, 0xa9]))).toBeUndefined();
  });

  it("refuses a record over the 223-byte relay limit", () => {
    expect(() => encodeRecord({ kind: "release", version: "v1", manifestUrl: "https://x.org/" + "a".repeat(220) })).toThrow();
  });
});

describe("checkFiles", () => {
  const manifest: Manifest = { protocol: 1, project: "demo", version: "v1", files };
  const root = merkleRoot(files);

  it("marks matching, changed and unknown files", () => {
    const dropped = [files[0], entryFor("b.zip", utf8ToBin("evil")), entryFor("z.bin", utf8ToBin("z"))];
    const { rootOk, checks } = checkFiles(manifest, root, dropped);
    expect(rootOk).toBe(true);
    expect(checks.map((c) => c.status)).toEqual(["match", "changed", "unknown"]);
  });

  it("finds a renamed file by its hash", () => {
    const { checks } = checkFiles(manifest, root, [{ ...files[1], name: "download (1).zip" }]);
    expect(checks[0].status).toBe("match");
  });

  it("flags a manifest that does not match the on-chain commitment", () => {
    const forged = { ...manifest, files: files.map((f, i) => (i ? f : entryFor(f.name, utf8ToBin("evil")))) };
    expect(checkFiles(forged, root, []).rootOk).toBe(false);
  });

  it("finds duplicate names", () => {
    expect(findDuplicates([...files, files[0]])).toEqual(["a.tar.gz"]);
  });
});
