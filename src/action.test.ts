// action.yml hands its inputs to seal-action.sh as env; this runs the script the way Actions does, with fresh output files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binToHex } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { entryFor, merkleRoot, parseManifest } from "./seal";

const web = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/");
const demo = join(web, "public/demo/v1.0.0");
const demoRoot = binToHex(
  merkleRoot(["README.txt", "hello-seal-1.0.0.zip"].map((n) => entryFor(n, readFileSync(join(demo, n))))),
);

const run = (env: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "rseal-action-")).replace(/\\/g, "/");
  const output = `${dir}/output`;
  const summary = `${dir}/summary`;
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const r = spawnSync("bash", [`${web}/seal-action.sh`], {
    cwd: web,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: web,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
      FILES: "",
      VERSION: "",
      PROJECT: "",
      OUT: `${dir}/seal.json`,
      ...env,
    },
  });
  return { r, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), list: `${dir}/seal.json` };
};

describe("seal-action.sh", () => {
  it("seals the demo release from a glob and a path and hands the root to the job", () => {
    const { r, output, summary, list } = run({
      VERSION: "v1.0.0",
      FILES: "  public/demo/v1.0.0/*.zip\n\npublic/demo/v1.0.0/README.txt  \n",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(output).toBe(`root=${demoRoot}\npath=${list}\n`);
    expect(summary).toContain(demoRoot);
    expect(summary).toContain("Release Seal: v1.0.0");
    const m = parseManifest(readFileSync(list, "utf8"));
    expect(m?.files.map((f) => f.name).sort()).toEqual(["README.txt", "hello-seal-1.0.0.zip"]);
    expect(binToHex(merkleRoot(m!.files))).toBe(demoRoot);
  });

  it("takes the tag name as the version on a tag push and refuses a branch push without one", () => {
    const files = "public/demo/v1.0.0/*";
    const tag = run({ FILES: files, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v2.0.0" });
    expect(tag.r.status, tag.r.stderr).toBe(0);
    expect(parseManifest(readFileSync(tag.list, "utf8"))?.version).toBe("v2.0.0");
    const branch = run({ FILES: files });
    expect(branch.r.status).not.toBe(0);
    expect(branch.r.stderr).toContain("Set the version input");
    expect(branch.output).toBe("");
  });

  it("stops on a line that matches no file, an empty list or a bad project id, and writes no output", () => {
    for (const [env, msg] of [
      [{ FILES: "public/demo/v1.0.0/*.zip\ndist/*.dmg" }, "No file matches dist/*.dmg"],
      [{ FILES: "public/demo/v1.0.0/missing.zip" }, "No file matches public/demo/v1.0.0/missing.zip"],
      [{ FILES: " \n" }, "The files input is empty."],
      [{ FILES: "public/demo/v1.0.0/*", PROJECT: "abc" }, "--project is the 64-hex project id"],
    ] as const) {
      const { r, output } = run({ VERSION: "v1", ...env });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(msg);
      expect(output).toBe("");
    }
  });

  it("is what action.yml runs, with the env names the script reads", () => {
    const yml = readFileSync(join(web, "action.yml"), "utf8");
    expect(yml).toContain('run: bash "$GITHUB_ACTION_PATH/seal-action.sh"');
    for (const [name, input] of [["FILES", "files"], ["VERSION", "version"], ["PROJECT", "project"], ["OUT", "out"]]) {
      expect(yml).toContain(`${name}: \${{ inputs.${input} }}`);
    }
  });
});
