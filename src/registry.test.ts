import { readFileSync } from "node:fs";
import { binToHex } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import type { SealEvent } from "./chain";
import { fetchRelease, githubFiles, label, parseRef, pypiFiles, RegistryError } from "./registry";
import { entryFor, merkleRoot, verdicts, type FileEntry } from "./seal";

const pub = new URL("../public/", import.meta.url);
const sealed = JSON.parse(readFileSync(new URL("demo/v1.0.0/seal.json", pub), "utf8"));
const tamperedZip = new Uint8Array(readFileSync(new URL("demo/tampered/hello-seal-1.0.0.zip", pub)));

const event = (files: FileEntry[]): SealEvent => ({
  kind: "release",
  version: "v1.0.0",
  manifestUrl: "https://example.org/seal.json",
  txid: "76".repeat(32),
  vout: 0,
  height: 976212,
  commitment: binToHex(merkleRoot(files)),
  publisher: "bitcoincash:qq",
});

const respond = (routes: Record<string, unknown>) => {
  const seen: string[] = [];
  const get = async (url: string) => {
    seen.push(url);
    if (!(url in routes)) return new Response("not found", { status: 404 });
    const body = routes[url];
    if (body instanceof Response) return body;
    if (body instanceof Uint8Array) return new Response(body);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { get, seen };
};

describe("parseRef", () => {
  it.each([
    ["emilhuseyn/release-seal@v1.1.0", { source: "github", name: "emilhuseyn/release-seal", version: "v1.1.0" }],
    ["https://github.com/cli/cli/releases/tag/v2.103.3", { source: "github", name: "cli/cli", version: "v2.103.3" }],
    ["gh: cli/cli@v2.103.3", { source: "github", name: "cli/cli", version: "v2.103.3" }],
    ["requests==2.32.3", { source: "pypi", name: "requests", version: "2.32.3" }],
    ["https://pypi.org/project/requests/2.32.3/", { source: "pypi", name: "requests", version: "2.32.3" }],
    ["left-pad@1.3.0", { source: "npm", name: "left-pad", version: "1.3.0" }],
    ["@types/node@22.10.1", { source: "npm", name: "@types/node", version: "22.10.1" }],
    ["https://www.npmjs.com/package/@types/node/v/22.10.1", { source: "npm", name: "@types/node", version: "22.10.1" }],
    ["npm:left-pad@1.3.0", { source: "npm", name: "left-pad", version: "1.3.0" }],
  ])("reads %s", (text, ref) => {
    expect(parseRef(text)).toEqual(ref);
  });

  it.each(["", "left-pad", "cli/cli", "left-pad@", "a b@1", "pypi:cli/cli@v1", "github:left-pad@1.0", "x/y/z@1"])("refuses %j", (text) => {
    expect(parseRef(text)).toBeUndefined();
  });

  it("writes a ref back in the registry's own form", () => {
    expect(label(parseRef("requests==2.32.3")!)).toBe("requests==2.32.3");
    expect(label(parseRef("cli/cli@v1")!)).toBe("cli/cli@v1");
  });
});

describe("digests", () => {
  it("takes GitHub sha256 digests and names assets without one", () => {
    const r = githubFiles([
      { name: "a.zip", size: 10, digest: "sha256:" + "AB".repeat(32) },
      { name: "old.zip", size: 5, digest: null },
      { name: "md5.zip", size: 5, digest: "md5:" + "ab".repeat(16) },
    ]);
    expect(r.files).toEqual([{ name: "a.zip", size: 10, sha256: "ab".repeat(32) }]);
    expect(r.skipped).toEqual(["old.zip", "md5.zip"]);
  });

  it("takes PyPI sha256 digests", () => {
    const r = pypiFiles([{ filename: "p.whl", size: 3, digests: { sha256: "cd".repeat(32) } }, { filename: "q.tar.gz", size: 4 }]);
    expect(r.files).toEqual([{ name: "p.whl", size: 3, sha256: "cd".repeat(32) }]);
    expect(r.skipped).toEqual(["q.tar.gz"]);
  });
});

describe("fetchRelease against the sealed demo release", () => {
  const ghAssets = (files: FileEntry[]) => files.map((f) => ({ name: f.name, size: f.size, digest: `sha256:${f.sha256}` }));
  const api = "https://api.github.com/repos/emilhuseyn/hello-seal/releases/tags/v1.0.0";

  it("a GitHub release whose assets are the sealed files reads green with no file list and no download", async () => {
    const { get, seen } = respond({ [api]: { html_url: "https://github.com/emilhuseyn/hello-seal/releases/tag/v1.0.0", assets: ghAssets(sealed.files) } });
    const got = await fetchRelease(parseRef("emilhuseyn/hello-seal@v1.0.0")!, get);
    expect(seen).toEqual([api]);
    const [r] = verdicts([event(sealed.files)], {}, {}, got.files, got.files.map(() => undefined));
    expect(r.rootOk).toBe(true);
    expect(r.checks.map((c) => c.status)).toEqual(["match", "match"]);
  });

  it("an asset swapped after publishing (same name, new bytes) reads changed", async () => {
    const swapped = entryFor("hello-seal-1.0.0.zip", tamperedZip);
    const assets = ghAssets([swapped, sealed.files[1]]);
    const { get } = respond({ [api]: { assets } });
    const got = await fetchRelease(parseRef("emilhuseyn/hello-seal@v1.0.0")!, get);
    const [r] = verdicts([event(sealed.files)], { ["76".repeat(32)]: sealed }, {}, got.files, got.files.map(() => undefined));
    expect(r.checks.find((c) => c.name === "hello-seal-1.0.0.zip")?.status).toBe("changed");
    expect(r.checks.find((c) => c.name === "README.txt")?.status).toBe("match");
  });

  it("another package checked against the project reads red, not grey", async () => {
    const { get } = respond({ [api]: { assets: ghAssets([entryFor("other.tar.gz", tamperedZip)]) } });
    const got = await fetchRelease(parseRef("emilhuseyn/hello-seal@v1.0.0")!, get);
    const [r] = verdicts([event(sealed.files)], { ["76".repeat(32)]: sealed }, {}, got.files, got.files.map(() => undefined));
    expect(r.checks.map((c) => c.status)).toEqual(["unknown"]);
    expect(r.mismatch).toBe("This file is not part of any sealed release of this project.");
  });

  it("PyPI files go through the same leaves", async () => {
    const url = "https://pypi.org/pypi/hello-seal/1.0.0/json";
    const { get } = respond({ [url]: { urls: sealed.files.map((f: FileEntry) => ({ filename: f.name, size: f.size, digests: { sha256: f.sha256 } })) } });
    const got = await fetchRelease(parseRef("hello-seal==1.0.0")!, get);
    expect(binToHex(merkleRoot(got.files))).toBe(binToHex(merkleRoot(sealed.files)));
  });

  it("npm: hashes the tarball itself, named after its URL", async () => {
    const tgz = "https://registry.npmjs.org/@demo/hello/-/hello-1.0.0.tgz";
    const bytes = new Uint8Array(readFileSync(new URL("demo/v1.0.0/hello-seal-1.0.0.zip", pub)));
    const { get, seen } = respond({ "https://registry.npmjs.org/@demo%2Fhello/1.0.0": { dist: { tarball: tgz } }, [tgz]: bytes });
    const got = await fetchRelease(parseRef("@demo/hello@1.0.0")!, get);
    expect(seen).toEqual(["https://registry.npmjs.org/@demo%2Fhello/1.0.0", tgz]);
    expect(got.files).toEqual([{ name: "hello-1.0.0.tgz", size: 192, sha256: sealed.files[0].sha256 }]);
  });

  it("npm: a tarball off the registry is refused", async () => {
    const { get } = respond({ "https://registry.npmjs.org/x/1.0.0": { dist: { tarball: "https://evil.example/x.tgz" } } });
    await expect(fetchRelease(parseRef("x@1.0.0")!, get)).rejects.toThrow(RegistryError);
  });

  it("names a missing release and GitHub's rate limit in plain words", async () => {
    await expect(fetchRelease(parseRef("a/b@v9")!, respond({}).get)).rejects.toThrow("GitHub release a/b@v9 was not found.");
    const limited = respond({ "https://api.github.com/repos/a/b/releases/tags/v9": new Response("", { status: 403 }) });
    await expect(fetchRelease(parseRef("a/b@v9")!, limited.get)).rejects.toThrow(/rate limit/);
  });
});
