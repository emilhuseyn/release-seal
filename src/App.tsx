import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import "./App.css";
import { walkProject, type SealEvent } from "./chain";
import { rpc } from "./rpc";
import { badgeSnippets, parseManifest, readManifest, verdicts, type FileEntry, type Manifest, type Result } from "./seal";
import { DropZone, short, Snippet } from "./ui";

const Publish = lazy(() => import("./Publish"));

// Banner links required by the BLAZE rules. Emil fills these before submission.
const BANNER = {
  deck: "https://docs.google.com/presentation/d/1EnzpFVsCAQISefbwXQt52dGJBMMQL3d8ZGV9NUJ_pzY/edit?usp=sharing",
  repo: "https://github.com/emilhuseyn/release-seal",
  emberAddress: "bitcoincash:zzrq9aavqx57w49galdt3paav9lnk3zy9q6hszc6q0",
};

// Token category of the demo project that seals public/demo/v1.0.0 on mainnet. Empty until that seal exists; the links stay hidden.
const DEMO_PROJECT = "";


function Verify() {
  const [category, setCategory] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [events, setEvents] = useState<SealEvent[] | null>(null);
  const [opened, setOpened] = useState("");
  const [manifests, setManifests] = useState<Record<string, Manifest>>({});
  const [wrong, setWrong] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (cat: string) => {
    setError("");
    setEvents(null);
    setResults(null);
    if (!/^[0-9a-f]{64}$/i.test(cat)) return setError("A project id is the 64-character token category.");
    setBusy("Reading the chain...");
    try {
      const ev = await walkProject(await rpc(), cat.toLowerCase());
      if (!ev.length) throw new Error("No seal records found for this project.");
      const ms: Record<string, Manifest> = {};
      const bad: Record<string, boolean> = {};
      for (const e of ev.filter((x) => x.kind === "release")) {
        try {
          // a replaced list must not shadow an honest seal.json the user drops, so only a list with the chain's root is kept
          const m = readManifest(await (await fetch(e.manifestUrl)).text(), e.commitment);
          if (m === "wrong") bad[e.txid] = true;
          else if (m) ms[e.txid] = m;
        } catch {
          // a missing manifest shows as unverifiable for that release
        }
      }
      setManifests(ms);
      setWrong(bad);
      setEvents(ev);
      setOpened(cat.toLowerCase());
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(/No such mempool or blockchain transaction/.test(msg) ? "No project with this id exists on Bitcoin Cash. Check the id or the link." : msg);
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    if (category) load(category);
    // load once for a ?project= link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async (all: FileEntry[], raw: File[]) => {
    if (!events) return;
    // A dropped seal.json stands in for a list the page could not fetch (site down or taken over, no CORS); the chain decides.
    const lists = await Promise.all(raw.map(async (f) => (/\.json$/i.test(f.name) && f.size < 1e6 ? parseManifest(await f.text()) : undefined)));
    setResults(verdicts(events, manifests, wrong, all, lists));
  };

  const latest = events?.filter((e) => e.kind === "release").at(-1);
  const name = events?.find((e) => e.kind === "genesis")?.version;
  // the id that was opened, not the input box, which the user may have edited since
  const badge = events ? badgeSnippets(new URL(".", location.href).href, opened) : undefined;
  return (
    <section>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          history.replaceState(null, "", `?project=${category}`);
          load(category);
        }}
      >
        <input value={category} onChange={(e) => setCategory(e.target.value.trim())} placeholder="Project id (token category)" spellCheck={false} />
        <button type="submit">Open</button>
      </form>
      {DEMO_PROJECT && !events && (
        <p className="muted">
          No project to hand? Open the <a href={`?project=${DEMO_PROJECT}`}>demo project</a>, then drop its{" "}
          <a href="./demo/v1.0.0/hello-seal-1.0.0.zip">sealed zip</a> or a <a href="./demo/tampered/hello-seal-1.0.0.zip">tampered copy</a>.
        </p>
      )}
      {!events && !busy && (
        <div className="card">
          <h3>How it works</h3>
          <ol className="steps">
            <li>
              A maintainer seals each release from a wallet. The seal is a CashTokens NFT whose commitment is the root hash of the
              release files. Only the holder of that NFT can seal the next version or revoke a bad one.
            </li>
            <li>
              You open the project by its id (projects share a link ending in <code>?project=</code>) and drop the files you
              downloaded. They are hashed in your browser and compared with the root on Bitcoin Cash. No wallet, no upload.
            </li>
            <li>If someone swapped the installer on the download site, its hash no longer matches the seal and the page says so in red.</li>
          </ol>
          <p className="muted">
            To make a seal yourself, open <b>Seal a release</b>, connect a WizardConnect wallet with about 2,300 sats, drop any file and
            press <b>Seal it now</b>.
          </p>
        </div>
      )}
      {busy &&<p className="muted">{busy}</p>}
      {error && <p className="bad">{error}</p>}
      {events && (
        <>
          <div className="card">
            <h2>{name ?? "Project"}</h2>
            <p className="muted">
              Publisher {short(events.at(-1)!.publisher.replace("bitcoincash:", ""), 8)}. Latest release{" "}
              {latest ? `${latest.version}, block ${latest.height || "unconfirmed"}` : "none yet"}.
            </p>
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.txid} className={e.revoked ? "revoked" : ""}>
                  <b>{e.kind === "genesis" ? "created" : e.kind}</b> {e.kind !== "genesis" && e.version}
                  {e.revoked && <span className="tag bad">revoked</span>}
                  <a href={`https://blockchair.com/bitcoin-cash/transaction/${e.txid}`} target="_blank" rel="noreferrer">
                    {e.height ? `block ${e.height}` : "unconfirmed"}
                  </a>
                </li>
              ))}
            </ol>
            {badge && (
              <details className="badge">
                <summary>Badge for your download page</summary>
                <p>
                  <a href={badge.link}>
                    <img src="./badge.svg" alt="Verify this download with Release Seal" height="20" />
                  </a>
                </p>
                <p className="muted">Put it next to your download links. It opens this page with the project already loaded.</p>
                <Snippet label="HTML" text={badge.html} />
                <Snippet label="Markdown, for a README" text={badge.markdown} />
              </details>
            )}
          </div>
          <DropZone onFiles={verify} label="Drop downloaded files here to check them" />
        </>
      )}
      {results?.map((r) => (
        <div key={r.event.txid} className="card">
          <h3>
            {r.event.version} {r.event.revoked && <span className="tag bad">revoked by the publisher</span>}
          </h3>
          {!r.rootOk && <p className="bad">The manifest at {r.event.manifestUrl} does not match the sealed root. Do not trust it.</p>}
          {r.mismatch && <p className="bad">{r.mismatch}</p>}
          {r.note && <p className="muted">{r.note}</p>}
          {r.checks.map((c) => (
            <p key={c.name} className={c.status === "match" && r.rootOk && !r.event.revoked ? "good" : c.status === "unknown" ? "muted" : "bad"}>
              {r.unchecked ? "Not checked yet" : `${c.status === "match" ? "Matches" : c.status === "changed" ? "DIFFERENT from" : "Not part of"} ${c.expected?.name ?? "this release"}`}: {c.name}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}


export default function App() {
  const [tab, setTab] = useState<"verify" | "publish">("verify");
  return (
    <main>
      <div className="banner">
        <a href={BANNER.deck || undefined}>Deck</a>
        <a href={BANNER.repo || undefined}>Source</a>
        <a href="./story/">Story</a>
        <span>Donate EMBER2026: {BANNER.emberAddress || "address pending"}</span>
      </div>
      <header>
        <h1>Release Seal</h1>
        <p>Check that the file you downloaded is the file the maintainer shipped. The proof lives on Bitcoin Cash.</p>
      </header>
      <nav>
        <button className={tab === "verify" ? "on" : ""} onClick={() => setTab("verify")}>
          Verify a download
        </button>
        <button className={tab === "publish" ? "on" : ""} onClick={() => setTab("publish")}>
          Seal a release
        </button>
      </nav>
      {tab === "verify" ? (
        <Verify />
      ) : (
        <Suspense fallback={<p className="muted">Loading the wallet tools...</p>}>
          <Publish />
        </Suspense>
      )}
    </main>
  );
}
