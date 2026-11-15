import { DEFAULT_SESSION_KEY } from "@wizardconnect/dapp";
import { describe, expect, it } from "vitest";
import { dropOldSession, SESSION_MAX_AGE } from "./wallet";

const memory = (items: Record<string, string>) => {
  const m = new Map(Object.entries(items));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()].sort(),
  };
};

const pairing = JSON.stringify({ privateKey: "11".repeat(32), secret: "ab".repeat(16), walletPublicKey: "22".repeat(32), walletName: "Paytaca" });
const now = Date.UTC(2026, 10, 23, 12);

describe("dropOldSession", () => {
  it("keeps a pairing the wallet confirmed within six hours", () => {
    const s = memory({ [DEFAULT_SESSION_KEY]: pairing, "release-seal-wallet-seen": String(now - SESSION_MAX_AGE + 60_000), other: "x" });
    expect(dropOldSession(s, now)).toBe(false);
    expect(s.keys()).toEqual(["other", "release-seal-wallet-seen", DEFAULT_SESSION_KEY]);
  });

  it("drops an older pairing, and one stored before the page recorded when the wallet last answered", () => {
    const old = memory({ [DEFAULT_SESSION_KEY]: pairing, "release-seal-wallet-seen": String(now - SESSION_MAX_AGE - 1), other: "x" });
    expect(dropOldSession(old, now)).toBe(true);
    expect(old.keys()).toEqual(["other"]);
    const unstamped = memory({ [DEFAULT_SESSION_KEY]: pairing });
    expect(dropOldSession(unstamped, now)).toBe(true);
    expect(unstamped.keys()).toEqual([]);
    const future = memory({ [DEFAULT_SESSION_KEY]: pairing, "release-seal-wallet-seen": String(now + 3600_000) });
    expect(dropOldSession(future, now)).toBe(true);
  });

  it("does nothing without a pairing or without storage", () => {
    const s = memory({ "release-seal-wallet-seen": "1", other: "x" });
    expect(dropOldSession(s, now)).toBe(false);
    expect(s.keys()).toEqual(["other", "release-seal-wallet-seen"]);
    expect(dropOldSession(undefined, now)).toBe(false);
    const refusing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {}, removeItem: () => {} };
    expect(dropOldSession(refusing, now)).toBe(false);
  });
});
