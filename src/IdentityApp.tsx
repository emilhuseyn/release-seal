import { binToHex } from "@bitauth/libauth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { broadcast } from "./chain";
import {
  addressName,
  authTemplate,
  buildLinkTx,
  buildPayTx,
  checkAuth,
  identitiesTemplate,
  latestIdentities,
  lockFromAddress,
  newChallenge,
  npubOf,
  pubkeyFrom,
  verifyFromAddress,
  verifyFromNostr,
  type PlannedTx,
  type Verdict,
} from "./identity";
import { browserSigner, extension, extensionSigner, forgetBrowserKey, RELAYS, relays, type Signer } from "./nostr";
import { rpc } from "./rpc";
import { wizardRequest, type Utxo } from "./tx";
import { short } from "./ui";
import { ConnectCard, useWallet } from "./wallet";

const REPO = "https://github.com/emilhuseyn/release-seal";
const SPEC = `${REPO}/blob/main/docs/identity.md`;
const txLink = (txid: string) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
const addrLink = (a: string) => `https://blockchair.com/bitcoin-cash/address/${a}`;
const npubLink = (pubkey: string) => `https://njump.me/${npubOf(pubkey)}`;

function VerdictCard({ v, onPay }: { v: Verdict; onPay?: (address: string) => void }) {
  return (
    <div className="card">
      <h3 className={v.verified ? "good" : "bad"}>{v.verified ? "Verified: this Nostr key and this BCH address belong together" : "Not verified"}</h3>
      <p className="muted">
        Nostr <a href={npubLink(v.pubkey)}>{short(npubOf(v.pubkey), 10)}</a>
        {v.address && (
          <>
            {" "}
            · BCH <a href={addrLink(v.address)}>{short(v.address, 8)}</a>
          </>
        )}
        {v.txid && (
          <>
            {" "}
            · proof <a href={txLink(v.txid)}>{v.height ? `block ${v.height}` : "unconfirmed"}</a>
          </>
        )}
      </p>
      <ul className="checks">
        {v.checks.map((c) => (
          <li key={c.label} className={c.ok ? "good" : "bad"}>
            {c.ok ? "✓" : "✗"} {c.label}
          </li>
        ))}
      </ul>
      {v.verified && v.address && onPay && (
        <p>
          <button onClick={() => onPay(v.address!)}>Pay this identity</button>
        </p>
      )}
    </div>
  );
}

export default function IdentityApp() {
  const w = useWallet();
  const { wc, lock, coinsNow } = w;
  const [signer, setSigner] = useState<Signer | undefined>(() => browserSigner(false));
  const [showNsec, setShowNsec] = useState(false);
  const [coins, setCoins] = useState<Utxo[]>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<{ txid: string; event: string; relays: string[]; address: string; revoke: boolean }>();
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("id") ?? "");
  const [verdict, setVerdict] = useState<Verdict | null>();
  const [lookupError, setLookupError] = useState("");
  const [looking, setLooking] = useState(false);
  const [payTo, setPayTo] = useState("");
  const [challenge, setChallenge] = useState(newChallenge);
  const [signin, setSignin] = useState<{ error?: string; pubkey?: string; verdict?: Verdict }>();

  const reloadCoins = useCallback(async () => {
    try {
      setCoins(await coinsNow());
    } catch {
      setCoins(undefined);
    }
  }, [coinsNow]);
  useEffect(() => {
    if (lock) reloadCoins();
  }, [lock, reloadCoins]);

  const plan = useMemo(() => {
    if (!coins || !signer) return undefined;
    try {
      return buildLinkTx({ pubkey: signer.pubkey, funding: coins });
    } catch (e) {
      return (e as Error).message;
    }
  }, [coins, signer]);

  const send = async (u: PlannedTx, prompt: string) => {
    if (!wc.manager) throw new Error("Connect the wallet first");
    const res = await wc.manager.signTransaction(wizardRequest(u, prompt));
    setStatus("Signed. Sending to the network...");
    return broadcast(await rpc(), res.signedTransaction);
  };

  const link = async (revoke: boolean) => {
    if (!signer || typeof plan !== "object" || busy) return;
    setBusy(true);
    setLinked(undefined);
    try {
      const u = revoke ? buildLinkTx({ pubkey: signer.pubkey, funding: coins!, revoke: true }) : plan;
      const address = addressName(u.lock);
      setStatus(`Step 1 of 2: confirm in your wallet. The proof spends from ${short(address, 8)} back to itself, fee ${u.fee} sats.`);
      const txid = await send(u, revoke ? "BCH Nostr ID: revoke the link to your Nostr key" : "BCH Nostr ID: prove this address links to your Nostr key");
      setStatus(`Step 2 of 2: sign the Nostr identity list (NIP-39, kind 10011) ${signer.via === "extension" ? "in your extension" : "with the key in this browser"}.`);
      const previous = await latestIdentities(relays, signer.pubkey);
      const event = await signer.sign(identitiesTemplate(previous, revoke ? undefined : { address, txid }));
      const accepted = await relays.publish(event);
      setLinked({ txid, event: event.id, relays: accepted, address, revoke });
      setStatus(accepted.length ? "" : "The BCH proof is out, but no relay took the Nostr event. Press Link again later; the proof stays valid.");
      setQuery(npubOf(signer.pubkey));
      reloadCoins();
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async (text = query) => {
    setLookupError("");
    setVerdict(undefined);
    const pubkey = pubkeyFrom(text);
    let address: string | undefined;
    if (!pubkey) {
      try {
        address = addressName(lockFromAddress(text));
      } catch {
        return setLookupError("Paste an npub (or hex key) or a Bitcoin Cash address.");
      }
    }
    setLooking(true);
    try {
      const r = await rpc();
      setVerdict(pubkey ? await verifyFromNostr(r, relays, pubkey) : (await verifyFromAddress(r, relays, address!)) ?? null);
    } catch (e) {
      setLookupError(String((e as Error).message ?? e));
    } finally {
      setLooking(false);
    }
  };

  useEffect(() => {
    if (query) lookup(query);
    // look up once for an ?id= link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pay = async (amount: bigint) => {
    if (!lock || !coins || busy) return;
    setBusy(true);
    try {
      const u = buildPayTx({ to: lockFromAddress(payTo), amount, funding: coins, changeLock: lock });
      setStatus(`Confirm in your wallet: ${amount.toLocaleString("en-US")} sats to ${short(payTo, 8)}, fee ${u.fee} sats.`);
      const txid = await send(u, `BCH Nostr ID: pay ${amount} sats by identity`);
      setStatus(`Paid: ${txid}`);
      reloadCoins();
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (!signer) return;
    setSignin(undefined);
    try {
      const event = await signer.sign(authTemplate(challenge, location.origin));
      const error = checkAuth(event, challenge, location.origin);
      // a challenge is good for one sign-in only
      setChallenge(newChallenge());
      if (error) return setSignin({ error });
      setSignin({ pubkey: event.pubkey });
      setSignin({ pubkey: event.pubkey, verdict: await verifyFromNostr(await rpc(), relays, event.pubkey) });
    } catch (e) {
      setSignin({ error: String((e as Error).message ?? e) });
    }
  };

  const total = coins?.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);

  return (
    <main>
      <div className="banner">
        <a href="../">Release Seal</a>
        <a href={REPO}>Source</a>
        <a href={SPEC}>Protocol and verification</a>
        <span>BCH BLAZE 2026 · Paytaca Decentralized Identity bounty</span>
      </div>
      <header>
        <h1>BCH Nostr ID</h1>
        <p>
          Link a Bitcoin Cash wallet and a Nostr key, each proving itself with its own signature. Anyone can check the link from either
          side, apps can sign you in with it, and people can pay you by your npub.
        </p>
      </header>

      <div className="card">
        <h3>How it works</h3>
        <ol className="steps">
          <li>
            Your wallet signs a small transaction from your address whose OP_RETURN says, in NIP-39's own words, "Verifying that I control
            the following Nostr public key: npub1...". Only that address's key can make it.
          </li>
          <li>
            Your Nostr key signs a NIP-39 identity list (kind 10011) with <code>["i", "bch:&lt;address&gt;", "&lt;txid&gt;"]</code> and
            it goes to public relays.
          </li>
          <li>
            Anyone checks both signatures: the event on the relays, the transaction on any Bitcoin Cash server. No key is shared between
            the two, nothing is stored by us.
          </li>
        </ol>
      </div>

      <h2>1. Your keys</h2>
      <ConnectCard w={w} label="Connect BCH wallet" />
      {lock && (
        <p className="muted">
          {wc.walletName ?? "Wallet"} connected
          {total !== undefined ? `, ${total.toLocaleString("en-US")} sats on ${new Set(coins!.map((u) => u.lock && binToHex(u.lock))).size} address(es).` : "."}
        </p>
      )}
      <div className="card">
        {signer ? (
          <>
            <p>
              Nostr key <a href={npubLink(signer.pubkey)}>{short(npubOf(signer.pubkey), 12)}</a>{" "}
              <span className="muted">({signer.via === "extension" ? "your browser extension signs" : "kept in this browser"})</span>
            </p>
            {signer.via === "browser" && (
              <p className="muted">
                Save this key if you want to keep the identity:{" "}
                {showNsec ? <code className="secret">{(signer as Signer & { nsec: string }).nsec}</code> : <button onClick={() => setShowNsec(true)}>Show nsec</button>}{" "}
                <button
                  onClick={() => {
                    forgetBrowserKey();
                    setSigner(undefined);
                    setShowNsec(false);
                  }}
                >
                  Forget it
                </button>
              </p>
            )}
          </>
        ) : (
          <>
            <p>A Nostr key: your NIP-07 extension (Alby, nos2x and others), or a new key made here and kept in this browser.</p>
            <div className="row">
              {extension() && (
                <button
                  onClick={async () => {
                    try {
                      setSigner(await extensionSigner());
                    } catch (e) {
                      setStatus(String((e as Error).message ?? e));
                    }
                  }}
                >
                  Use my Nostr extension
                </button>
              )}
              <button onClick={() => setSigner(browserSigner(true))}>Make a Nostr key here</button>
            </div>
          </>
        )}
      </div>

      <h2>2. Link them</h2>
      <div className="card">
        {!lock || !signer ? (
          <p className="muted">Connect the wallet and pick a Nostr key above.</p>
        ) : typeof plan === "string" ? (
          <p className="bad">{plan}</p>
        ) : plan ? (
          <>
            <p>
              Identity address <a href={addrLink(addressName(plan.lock))}>{short(addressName(plan.lock), 8)}</a> (your largest coin's address).
              One wallet confirmation, fee about {plan.fee.toString()} sats; the rest returns to the same address.
            </p>
            <div className="row">
              <button disabled={busy} onClick={() => link(false)} className="on">
                Link wallet and Nostr key
              </button>
              <button disabled={busy} onClick={() => link(true)}>
                Revoke
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Reading the wallet's coins...</p>
        )}
        {status && <p className="muted">{status}</p>}
        {linked && (
          <p className="good">
            {linked.revoke ? "Revoked" : "Linked"}: proof <a href={txLink(linked.txid)}>{short(linked.txid, 8)}</a>, Nostr event {short(linked.event, 8)} on{" "}
            {linked.relays.length} of {RELAYS.length} relays.
          </p>
        )}
      </div>

      <h2>3. Look up anyone</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          history.replaceState(null, "", `?id=${encodeURIComponent(query.trim())}`);
          lookup();
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="npub1... or bitcoincash:q..." spellCheck={false} />
        <button type="submit" disabled={looking}>
          {looking ? "Checking..." : "Look up"}
        </button>
      </form>
      {lookupError && <p className="bad">{lookupError}</p>}
      {verdict === null && <p className="muted">This address has no current link to a Nostr key.</p>}
      {verdict && <VerdictCard v={verdict} onPay={(a) => setPayTo(a)} />}
      {payTo && (
        <div className="card">
          <p>
            Pay {short(payTo, 8)}, the address this Nostr identity proved. No address to copy: the npub was enough.
          </p>
          {lock ? (
            <div className="row">
              {[2_000n, 10_000n].map((a) => (
                <button key={String(a)} disabled={busy} onClick={() => pay(a)}>
                  {a.toLocaleString("en-US")} sats
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">Connect a wallet in step 1 to pay.</p>
          )}
        </div>
      )}

      <h2>4. Sign in to an app</h2>
      <div className="card demoapp">
        <p className="muted">
          Demo app. Any site can do this without asking us: it sends a fresh challenge, you sign it with your Nostr key (the NIP-42 auth
          event, kind 22242), and the site checks the signature and then your BCH link.
        </p>
        <p>
          Challenge <code>{short(challenge, 10)}</code>
        </p>
        <button disabled={!signer} onClick={signIn}>
          {signer ? "Sign in with Nostr" : "Pick a Nostr key in step 1"}
        </button>
        {signin?.error && <p className="bad">{signin.error}</p>}
        {signin?.pubkey && (
          <p className="good">
            Signed in as {short(npubOf(signin.pubkey), 10)}.{" "}
            {signin.verdict
              ? signin.verdict.verified
                ? `Your Bitcoin Cash address ${short(signin.verdict.address!, 8)} is verified.`
                : "No verified BCH link for this key yet."
              : "Checking your BCH link..."}
          </p>
        )}
      </div>
    </main>
  );
}
