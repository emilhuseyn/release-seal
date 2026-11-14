import { binToHex, lockingBytecodeToCashAddress, publicKeyToP2pkhLockingBytecode, secp256k1, hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { holderLockFrom } from "./Tip";

describe("holderLockFrom", () => {
  const lock = publicKeyToP2pkhLockingBytecode({ publicKey: secp256k1.derivePublicKeyCompressed(hexToBin("55".repeat(32))) as Uint8Array });
  const at = (tokenSupport: boolean, prefix: "bitcoincash" | "bchtest") =>
    (lockingBytecodeToCashAddress({ bytecode: lock, prefix, tokenSupport }) as { address: string }).address;
  it("pays the same script for the z address the walk reports and its q form", () => {
    expect(binToHex(holderLockFrom(at(true, "bitcoincash")))).toBe(binToHex(lock));
    expect(binToHex(holderLockFrom(at(false, "bitcoincash")))).toBe(binToHex(lock));
  });
  it("refuses a testnet address", () => {
    expect(() => holderLockFrom(at(true, "bchtest"))).toThrow(/mainnet/);
  });
});
