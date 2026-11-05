import { binToHex, hexToBin, sha256, utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { badgeSnippets, checkFiles, decodeRecord, encodeRecord, entryFor, findDuplicates, isWholeRelease, loadManifests, merkleRoot, parseManifest, pickList, projectId, readManifest, verdicts, type Manifest } from "./seal";
import type { SealEvent } from "./chain";

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

  it("round-trips a hand-over record with a reason and no URL", () => {
    const r = { kind: "move" as const, version: "key rotation", manifestUrl: "" };
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

describe("without a fetched file list", () => {
  const root = merkleRoot(files);

  it("reads a dropped seal.json and normalises the hashes", () => {
    const text = JSON.stringify({ protocol: 1, project: "p", version: "v1", files: files.map((f) => ({ ...f, sha256: f.sha256.toUpperCase() })) });
    const m = parseManifest(text)!;
    expect(binToHex(merkleRoot(m.files))).toBe(binToHex(root));
    expect(checkFiles(m, root, [files[3]]).checks[0].status).toBe("match");
  });

  it("refuses JSON that is not a version 1 file list", () => {
    expect(parseManifest("not json")).toBeUndefined();
    expect(parseManifest(JSON.stringify({ protocol: 2, files }))).toBeUndefined();
    expect(parseManifest(JSON.stringify({ protocol: 1, files: [{ name: "a", size: "1", sha256: files[0].sha256 }] }))).toBeUndefined();
    expect(parseManifest(JSON.stringify({ protocol: 1, files: [{ name: "a", size: 1, sha256: "00" }] }))).toBeUndefined();
  });

  it("trusts a hosted seal.json only when its root is the commitment", () => {
    const hex = binToHex(root);
    const good = JSON.stringify({ protocol: 1, files });
    const swapped = JSON.stringify({ protocol: 1, files: files.map((f, i) => (i ? f : entryFor(f.name, utf8ToBin("evil")))) });
    expect((readManifest(good, hex) as Manifest).files.length).toBe(5);
    expect(readManifest(swapped, hex)).toBe("wrong");
    expect(readManifest("{}", hex)).toBeUndefined();
    expect(readManifest("<!doctype html><title>404</title>", hex)).toBeUndefined();
  });

  it("fetches every hosted list at once and gives up on a site that hangs", async () => {
    const hex = binToHex(root);
    const good = JSON.stringify({ protocol: 1, files });
    const swapped = JSON.stringify({ protocol: 1, files: files.map((f, i) => (i ? f : entryFor(f.name, utf8ToBin("evil")))) });
    const ev = (kind: SealEvent["kind"], txid: string, url: string): SealEvent =>
      ({ kind, txid, vout: 0, commitment: hex, version: "v1", manifestUrl: url, height: 1, publisher: "q" });
    const asked: string[] = [];
    const aborted: string[] = [];
    const get = (url: string, signal: AbortSignal) => {
      asked.push(url);
      signal.addEventListener("abort", () => aborted.push(url));
      if (url === "hang") return new Promise<string>(() => {});
      if (url === "dead") return Promise.reject(new Error("offline"));
      return new Promise<string>((ok) => setTimeout(() => ok(url === "swapped" ? swapped : good), 80));
    };
    const events = [ev("genesis", "g", "site"), ev("release", "a", "hang"), ev("release", "b", "good"), ev("release", "c", "swapped"), ev("release", "d", "dead"), ev("release", "e", "good")];
    const t0 = Date.now();
    const { lists, wrong } = await loadManifests(events, get, 100);
    // one after another this takes 100 + 3 x 80 ms
    expect(Date.now() - t0).toBeLessThan(250);
    expect(asked).not.toContain("site");
    expect(Object.keys(lists).sort()).toEqual(["b", "e"]);
    expect(wrong).toEqual({ c: true });
    expect(aborted).toEqual(["hang"]);
  });

  it("accepts the full set of files as the release, renamed downloads included", () => {
    expect(isWholeRelease([...files].reverse(), root)).toBe(true);
    expect(isWholeRelease(files.map((f, i) => (i ? f : { ...f, name: "a (1).tar.gz" })), root)).toBe(true);
  });

  it("refuses a partial, extended or changed set", () => {
    expect(isWholeRelease(files.slice(1), root)).toBe(false);
    expect(isWholeRelease([...files, entryFor("x", utf8ToBin("x"))], root)).toBe(false);
    expect(isWholeRelease(files.map((f, i) => (i === 1 ? entryFor(f.name, utf8ToBin("evil")) : f)), root)).toBe(false);
    expect(isWholeRelease([], merkleRoot([]))).toBe(false);
  });
});

describe("verdicts", () => {
  const root = binToHex(merkleRoot(files));
  const ev = (kind: SealEvent["kind"], txid: string, commitment: string): SealEvent =>
    ({ kind, txid, vout: 0, commitment, version: kind === "genesis" ? "demo" : "v1", manifestUrl: "https://x/seal.json", height: 1, publisher: "q" });
  const events = [ev("genesis", "g", "00".repeat(32)), ev("release", "r1", root)];
  const honest = { protocol: 1, project: "", version: "v1", files };
  const evil = entryFor("a.tar.gz", utf8ToBin("evil"));

  it("still uses an honest dropped seal.json when the hosted one was replaced", () => {
    const [r] = verdicts(events, {}, { r1: true }, [evil, files[1], entryFor("seal.json", utf8ToBin("{}"))], [undefined, undefined, honest]);
    expect(r.rootOk).toBe(true);
    expect(r.checks.map((c) => c.status)).toEqual(["changed", "match"]);
    expect(r.note).toMatch(/does not match the chain and was ignored/);
  });

  it("warns and checks nothing when only a replaced list exists", () => {
    const [r] = verdicts(events, {}, { r1: true }, [evil], [undefined]);
    expect(r.rootOk).toBe(false);
    expect(r.unchecked).toBe(true);
    expect(r.checks[0].status).toBe("unknown");
  });

  it("with no list, a changed copy of a one-file release reads as not the sealed file", () => {
    const one = [entryFor("photo.jpg", utf8ToBin("photo"))];
    const solo = [ev("genesis", "g", "00".repeat(32)), ev("release", "r1", binToHex(merkleRoot(one)))];
    const [same] = verdicts(solo, {}, {}, one, [undefined]);
    expect(same.mismatch).toBeUndefined();
    expect(same.checks[0].status).toBe("match");
    const [changed] = verdicts(solo, {}, {}, [entryFor("photo.jpg", utf8ToBin("photo, edited"))], [undefined]);
    expect(changed.unchecked).toBe(true);
    expect(changed.mismatch).toMatch(/^This file is not the sealed v1\./);
    const [part] = verdicts(events, {}, {}, files.slice(1), files.slice(1).map(() => undefined));
    expect(part.mismatch).toMatch(/^These files are not exactly the sealed v1\./);
  });

  it("says a file is not part of the release only when the list was read", () => {
    const [r] = verdicts(events, { r1: honest }, {}, [entryFor("other.bin", utf8ToBin("x"))], [undefined]);
    expect(r.unchecked).toBe(false);
    expect(r.rootOk).toBe(true);
  });
});

// Seal tab: the seal.json a release job wrote stands in for the files.
describe("pickList", () => {
  const list: Manifest = { protocol: 1, project: "ab".repeat(32), version: "v2", files };
  const json = entryFor("seal.json", utf8ToBin("{}"));

  it("keeps plain drops as they are", () => {
    expect(pickList(files, files.map(() => undefined), "")).toEqual({ files });
  });

  it("takes the files from a dropped seal.json, with matching files beside it", () => {
    const r = pickList([json, files[0]], [list, undefined], "ab".repeat(32));
    expect(r.error).toBeUndefined();
    expect(binToHex(merkleRoot(r.files))).toBe(binToHex(merkleRoot(files)));
  });

  it("refuses a file that is not on the list, a second list, and another project's list", () => {
    const evil = entryFor("a.tar.gz", utf8ToBin("evil"));
    expect(pickList([json, evil], [list, undefined], "").error).toMatch(/Not on the dropped seal.json: a.tar.gz/);
    expect(pickList([json, json], [list, list], "").files).toEqual([]);
    const other = pickList([json], [list], "cd".repeat(32));
    expect(other.error).toMatch(/is for project abababababab/);
    expect(other.files).toEqual([]);
    expect(pickList([json], [{ ...list, project: "" }], "cd".repeat(32)).error).toBeUndefined();
  });
});

describe("badgeSnippets", () => {
  const id = "AB".repeat(32);
  it("links the badge to the project's verify page, with or without a trailing slash", () => {
    const s = badgeSnippets("https://emilhuseyn.github.io/release-seal/", id)!;
    expect(s.link).toBe(`https://emilhuseyn.github.io/release-seal/?project=${"ab".repeat(32)}`);
    expect(badgeSnippets("https://emilhuseyn.github.io/release-seal", id)).toEqual(s);
    expect(s.markdown).toBe(`[![Verify this download with Release Seal](https://emilhuseyn.github.io/release-seal/badge.svg)](${s.link})`);
    expect(s.html).toContain(`href="${s.link}"`);
    expect(s.html).toContain('src="https://emilhuseyn.github.io/release-seal/badge.svg"');
  });
  it("gives nothing for an id that is not a token category", () => {
    expect(badgeSnippets("https://x/", "ab".repeat(31))).toBeUndefined();
    expect(badgeSnippets("https://x/", `${"ab".repeat(31)}"><script>`)).toBeUndefined();
  });
});

describe("projectId", () => {
  const id = "ab".repeat(32);
  it("takes a bare id, or the id inside a pasted project or badge link", () => {
    expect(projectId(`  ${id.toUpperCase()} `)).toBe(id);
    expect(projectId(`https://emilhuseyn.github.io/release-seal/?project=${id}`)).toBe(id);
    expect(projectId(`https://emilhuseyn.github.io/release-seal/?x=1&project=${id.toUpperCase()}#top`)).toBe(id);
    expect(projectId(badgeSnippets("https://emilhuseyn.github.io/release-seal/", id)!.markdown)).toBe(id);
  });
  it("gives nothing for a short, long or missing id", () => {
    expect(projectId(id.slice(2))).toBeUndefined();
    expect(projectId(`${id}00`)).toBeUndefined();
    expect(projectId(`https://x/?project=${id}00`)).toBeUndefined();
    expect(projectId(`https://x/?project=${id}g`)).toBeUndefined();
    expect(projectId(`https://x/?notproject=${id}`)).toBeUndefined();
    expect(projectId("")).toBeUndefined();
  });
});
