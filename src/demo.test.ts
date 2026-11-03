// The judges' sample files in public/demo: the good copies match their manifest, the tampered zip does not.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, entryFor, merkleRoot, undupName, type Manifest } from "./seal";

const dir = fileURLToPath(new URL("../public/demo", import.meta.url));
const read = (sub: string) => readdirSync(join(dir, sub)).filter((n) => n !== "seal.json").map((n) => entryFor(n, readFileSync(join(dir, sub, n))));

describe("demo release", () => {
  const good = read("v1.0.0");
  const manifest: Manifest = { protocol: 1, project: "", version: "v1.0.0", files: good };
  const root = merkleRoot(good);

  it("matches every good file", () => {
    const r = checkFiles(manifest, root, good);
    expect(r.rootOk).toBe(true);
    expect(r.checks.map((c) => c.status)).toEqual(good.map(() => "match"));
  });

  it("flags the tampered zip as changed", () => {
    const r = checkFiles(manifest, root, read("tampered"));
    expect(r.checks).toEqual([expect.objectContaining({ name: "hello-seal-1.0.0.zip", status: "changed" })]);
  });

  // A judge who downloads both copies gets the second one renamed by the browser.
  it("still pairs a browser-renamed second download", () => {
    const [t] = read("tampered");
    const r = checkFiles(manifest, root, [{ ...t, name: "hello-seal-1.0.0 (1).zip" }, { ...good[0], name: "hello-seal-1.0.0(2).zip" }]);
    expect(r.checks.map((c) => c.status)).toEqual(["changed", "match"]);
    expect(undupName("README (3).txt")).toBe("README.txt");
    expect(undupName("notes (draft).txt")).toBe("notes (draft).txt");
  });

  // seal.json is written by the Seal tab after the mainnet genesis; it must describe exactly the files served next to it.
  it("published seal.json, if present, seals these files", () => {
    const p = join(dir, "v1.0.0/seal.json");
    if (!existsSync(p)) return;
    const m: Manifest = JSON.parse(readFileSync(p, "utf8"));
    expect(m.version).toBe("v1.0.0");
    expect(m.project).toMatch(/^[0-9a-f]{64}$/);
    expect(checkFiles(m, root, good).rootOk).toBe(true);
  });
});
