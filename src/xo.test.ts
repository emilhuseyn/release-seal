// The XO templates in xo/ build the same transactions as the web app. These are the ones broadcast on chipnet (xo/invitations/),
// read back with the app's own decoders: a project made and sealed through XO shows in Release Seal, and a link made through XO
// passes BCH Nostr ID's record check.
import { binToHex, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLink, pubkeyFrom } from "./identity";
import { decodeRecord, merkleRoot, type FileEntry } from "./seal";

const dir = new URL("../xo/invitations/", import.meta.url);
const tx = (name: string) => {
  const t = decodeTransaction(hexToBin(readFileSync(new URL(`${name}.tx.hex`, dir), "utf8").trim()));
  if (typeof t === "string") throw new Error(t);
  return t;
};
const PROJECT = "748ad1488993c9c6ea4c353a30fbbdd54c986d072828c17f32fc5dc023366c38";
const demoFiles = (JSON.parse(readFileSync(new URL("../public/demo/v1.0.0/seal.json", import.meta.url), "utf8")) as { files: FileEntry[] }).files;

describe("XO-built Release Seal transactions", () => {
  it("create, seal and revoke carry the project NFT at output 0 and a seal record at output 1", () => {
    const create = tx("create-xo-seal-demo");
    expect(binToHex(create.inputs[0].outpointTransactionHash)).toBe(PROJECT);
    expect(create.inputs[0].outpointIndex).toBe(0);
    expect(decodeRecord(create.outputs[1].lockingBytecode)).toEqual({ kind: "genesis", version: "xo-seal-demo", manifestUrl: "https://emilhuseyn.github.io/release-seal/" });

    const seal = tx("seal-v1.0.0");
    const revoke = tx("revoke-v1.0.0");
    for (const [t, kind, root] of [
      [create, "genesis", binToHex(merkleRoot([]))],
      [seal, "release", binToHex(merkleRoot(demoFiles))],
      [revoke, "revoke", binToHex(merkleRoot(demoFiles))],
    ] as const) {
      const nft = t.outputs[0].token;
      expect(binToHex(nft!.category)).toBe(PROJECT);
      expect(nft!.nft).toMatchObject({ capability: "mutable" });
      expect(binToHex(nft!.nft!.commitment)).toBe(root);
      expect(decodeRecord(t.outputs[1].lockingBytecode)?.kind).toBe(kind);
    }
    expect(decodeRecord(seal.outputs[1].lockingBytecode)).toEqual({ kind: "release", version: "v1.0.0", manifestUrl: "https://emilhuseyn.github.io/release-seal/demo/v1.0.0/seal.json" });
  });
});

describe("XO-built BCH Nostr ID transactions", () => {
  it("link and revoke records name the demo npub", () => {
    const pubkey = pubkeyFrom(readFileSync(new URL("demo-npub.txt", dir), "utf8"));
    expect(decodeLink(tx("link-ryjd4rep").outputs[0].lockingBytecode)).toEqual({ pubkey, revoke: false });
    expect(decodeLink(tx("unlink-ryjd4rep").outputs[0].lockingBytecode)).toEqual({ pubkey, revoke: true });
    // the revoke spends the link's change, so both come from the same identity address
    const link = tx("link-ryjd4rep");
    const unlink = tx("unlink-ryjd4rep");
    expect(binToHex(unlink.inputs[0].outpointTransactionHash)).not.toBe(binToHex(link.inputs[0].outpointTransactionHash));
    expect(binToHex(link.outputs[1].lockingBytecode)).toBe(binToHex(unlink.outputs.at(-1)!.lockingBytecode));
  });
});
