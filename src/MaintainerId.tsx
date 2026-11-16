import { useEffect, useState } from "react";
import { npubOf, verifyFromAddress, type Verdict } from "./identity";
import { relays } from "./nostr";
import { rpc } from "./rpc";
import { short } from "./ui";

// Who holds this project: if the holder's address linked a Nostr key (BCH Nostr ID, /identity/), the card names it, verified
// both ways. Relays are asked only when the address's own history holds a link record, so most projects cost nothing extra.
export default function MaintainerId({ address }: { address: string }) {
  const [v, setV] = useState<Verdict>();
  useEffect(() => {
    let live = true;
    setV(undefined);
    (async () => {
      const r = await verifyFromAddress(await rpc(), relays, address, 60);
      if (live && r?.verified) setV(r);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address]);
  if (!v) return null;
  return (
    <p className="good">
      Maintainer's Nostr identity: <a href={`https://njump.me/${npubOf(v.pubkey)}`}>{short(npubOf(v.pubkey), 10)}</a>, linked to this address
      by both keys (<a href={`./identity/?id=${npubOf(v.pubkey)}`}>check the proof</a>).
    </p>
  );
}
