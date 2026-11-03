// public/seal-manifest.mjs is the release-job twin of the Seal tab: it must give the root src/seal.ts gives, for any file count.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binToHex } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { entryFor, merkleRoot, parseManifest } from "./seal";

const cli = fileURLToPath(new URL("../public/seal-manifest.mjs", import.meta.url));
const demo = fileURLToPath(new URL("../public/demo/v1.0.0", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const names = ["README", "a.zip", "Z.tar.gz", "é-notes.txt", "app-1.2.0.dmg", "b", "sums.txt", "x86_64.AppImage", "0.sig"];

describe("seal-manifest.mjs", () => {
  it("gives the seal.ts root for 1 to 9 files and writes a seal.json Verify accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "rseal-"));
    for (let n = 1; n <= names.length; n++) {
      const paths = names.slice(0, n).map((name, i) => {
        const p = join(dir, name);
        writeFileSync(p, `file ${i} `.repeat(i * 37));
        return p;
      });
      const out = join(dir, `seal-${n}.json`);
      const r = run("--version", `v${n}`, "--out", out, ...paths);
      expect(r.status).toBe(0);
      const want = binToHex(merkleRoot(names.slice(0, n).map((name, i) => entryFor(name, readFileSync(paths[i])))));
      expect(r.stdout.trim()).toBe(want);
      const m = parseManifest(readFileSync(out, "utf8"));
      expect(m?.version).toBe(`v${n}`);
      expect(binToHex(merkleRoot(m!.files))).toBe(want);
    }
  });

  it("matches the judges' demo release and skips a seal.json passed with it", () => {
    const files = ["README.txt", "hello-seal-1.0.0.zip"];
    const want = binToHex(merkleRoot(files.map((n) => entryFor(n, readFileSync(join(demo, n))))));
    const dir = mkdtempSync(join(tmpdir(), "rseal-"));
    writeFileSync(join(dir, "seal.json"), "{}");
    const r = run("--out", join(dir, "out.json"), ...files.map((n) => join(demo, n)), join(dir, "seal.json"));
    expect(r.stdout.trim()).toBe(want);
  });

  it("refuses duplicate names, a bad project id and no files", () => {
    const dir = mkdtempSync(join(tmpdir(), "rseal-"));
    const sub = mkdtempSync(join(dir, "sub-"));
    writeFileSync(join(dir, "a.zip"), "one");
    writeFileSync(join(sub, "a.zip"), "two");
    expect(run("--out", join(dir, "o.json"), join(dir, "a.zip"), join(sub, "a.zip")).status).toBe(1);
    expect(run("--project", "abc", join(dir, "a.zip")).status).toBe(1);
    expect(run().status).toBe(2);
  });
});
