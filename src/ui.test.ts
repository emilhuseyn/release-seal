import { utf8ToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { entryFor } from "./seal";
import { readFiles } from "./ui";

describe("readFiles", () => {
  it("skips a dropped folder and names it, keeping the readable files in step with their entries", async () => {
    const a = new File(["first"], "a.txt");
    const b = new File(["second"], "seal.json");
    // what a browser hands over for a dropped folder: a File whose read rejects
    const folder = { name: "release-1.0", size: 0, arrayBuffer: () => Promise.reject(new DOMException("A requested file or directory could not be found", "NotFoundError")) } as unknown as File;
    const r = await readFiles([a, folder, b]);
    expect(r.entries).toEqual([entryFor("a.txt", utf8ToBin("first")), entryFor("seal.json", utf8ToBin("second"))]);
    expect(r.files).toEqual([a, b]);
    expect(r.failed).toEqual(["release-1.0"]);
  });

  it("gives nothing for an empty drop", async () => {
    expect(await readFiles([])).toEqual({ entries: [], files: [], failed: [] });
  });
});
