import { encodeKeyExchangeURI, generateKeyExchangeCredentials } from "@wizardconnect/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PairBar } from "./Publish";
import { pairLinks } from "./tx";

describe("PairBar", () => {
  it("links the exact pairing code to a wallet app and to Cashonize's web wallet in a new tab", () => {
    const c = generateKeyExchangeCredentials();
    const { uri } = encodeKeyExchangeURI(c.publicKey, c.secret);
    const html = renderToStaticMarkup(<PairBar uri={uri} />);
    const anchors = [...html.matchAll(/<a ([^>]*)>/g)].map((m) =>
      Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v.replaceAll("&amp;", "&")])),
    );
    expect(anchors).toEqual([{ href: uri }, { href: pairLinks(uri).web, target: "_blank", rel: "noopener noreferrer" }]);
  });
});
