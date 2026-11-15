import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ByName, DEMO_RELEASE, DemoFiles } from "./App";
import { parseRef } from "./registry";
import { checkLine } from "./seal";

const pub = new URL("../public/", import.meta.url);
const sealed = JSON.parse(readFileSync(new URL("demo/v1.0.0/seal.json", pub), "utf8"));

describe("DemoFiles", () => {
  it("links the sealed and the tampered zip under the project that sealed public/demo", () => {
    const hrefs = [...renderToStaticMarkup(<DemoFiles project={sealed.project} />).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["./demo/v1.0.0/hello-seal-1.0.0.zip", "./demo/tampered/hello-seal-1.0.0.zip"]);
    for (const h of hrefs) expect(existsSync(new URL(h, pub))).toBe(true);
  });

  it("names the GitHub release that carries the same files, in a form the by-name box reads", () => {
    expect(renderToStaticMarkup(<DemoFiles project={sealed.project} />)).toContain(`<code>${DEMO_RELEASE}</code>`);
    expect(parseRef(DEMO_RELEASE)).toEqual({ source: "github", name: "emilhuseyn/release-seal", version: "hello-seal-v1.0.0" });
  });

  it("shows nothing under any other project", () => {
    expect(renderToStaticMarkup(<DemoFiles project={"ab".repeat(32)} />)).toBe("");
  });
});

describe("ByName", () => {
  it("renders a labelled box for a release name next to the drop zone", () => {
    const html = renderToStaticMarkup(<ByName onFetched={() => {}} />);
    expect(html).toMatch(/<label for="byname">Or check a published release by name, no download<\/label>/);
    expect(html).toMatch(/<input id="byname"/);
  });
});

describe("checkLine", () => {
  const zip = { name: "hello-seal-1.0.0.zip", size: 192, sha256: "e2".repeat(32) };
  it("names a file once when the download kept the sealed name", () => {
    expect(checkLine({ name: zip.name, status: "match", expected: zip })).toBe("Matches hello-seal-1.0.0.zip");
    expect(checkLine({ name: zip.name, status: "changed", expected: zip })).toBe("DIFFERENT from hello-seal-1.0.0.zip");
  });
  it("adds the downloaded name when it differs, and for files outside the release", () => {
    expect(checkLine({ name: "hello-seal-1.0.0 (1).zip", status: "match", expected: zip })).toBe("Matches hello-seal-1.0.0.zip: hello-seal-1.0.0 (1).zip");
    expect(checkLine({ name: "setup.exe", status: "unknown" })).toBe("Not part of this release: setup.exe");
    expect(checkLine({ name: "setup.exe", status: "unknown" }, true)).toBe("Not checked yet: setup.exe");
  });
});
