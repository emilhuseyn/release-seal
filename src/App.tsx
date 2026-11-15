import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import "./App.css";
import { projectTips, walkProject, type SealEvent, type Tip as TipRow } from "./chain";
import { rpc } from "./rpc";
import { badgeSnippets, checkLine, greenRelease, loadManifests, parseManifest, projectId, verdicts, type FileEntry, type Manifest, type Result } from "./seal";
import { fetchRelease, label, parseRef, RegistryError, type Fetched } from "./registry";
import { DropZone, short, Snippet } from "./ui";

const Publish = lazy(() => import("./Publish"));
const Tip = lazy(() => import("./Tip"));
const Embed = lazy(() => import("./Embed"));

// Banner links required by the BLAZE rules. Emil fills these before submission.
const BANNER = {
  deck: "https://docs.google.com/presentation/d/1EnzpFVsCAQISefbwXQt52dGJBMMQL3d8ZGV9NUJ_pzY/edit?usp=sharing",
  repo: "https://github.com/emilhuseyn/release-seal",
  emberAddress: "bitcoincash:zzrq9aavqx57w49galdt3paav9lnk3zy9q6hszc6q0",
};

// Token category of the demo project that seals public/demo/v1.0.0 on mainnet. Empty until that seal exists; the links stay hidden.
const DEMO_PROJECT = "0bdf14fca14c69a2fc695191ffb94a2e0dda4b61ca6c4998fbaf3a02b3f40d42";

// GitHub release whose two assets are the files of DEMO_PROJECT's v1.0.0, for the check by name.
export const DEMO_RELEASE = "emilhuseyn/release-seal@hello-seal-v1.0.0";

// The home page line that offers the demo zips hides once a project is open, so the demo project links them again.
export function DemoFiles({ project }: { project: string }) {
  if (!DEMO_PROJECT || project !== DEMO_PROJECT) return null;
  return (
    <p className="muted">
      Demo files: the <a href="./demo/v1.0.0/hello-seal-1.0.0.zip">sealed zip</a> and a{" "}
      <a href="./demo/tampered/hello-seal-1.0.0.zip">tampered copy</a> with the same name. Download either and drop it below, or check the same files on GitHub by name:{" "}
      <code>{DEMO_RELEASE}</code>.
    </p>
  );
}

// Check by name: a GitHub release, a PyPI version or an npm version, without downloading anything by hand.
export function ByName({ onStart, onFetched, get }: { onStart?: () => void; onFetched: (f: Fetched) => void; get?: (url: string) => Promise<Response> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="byname"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        onStart?.();
        const ref = parseRef(text);
        if (!ref) return setError("Write owner/repo@tag for GitHub, name==version for PyPI or name@version for npm, or paste the release page link.");
        setBusy(true);
        try {
          const f = await fetchRelease(ref, get);
          if (!f.files.length) throw new RegistryError(`${label(ref)} publishes no SHA-256 for any of its files, so it cannot be checked by name. Download the files and drop them.`);
          onFetched(f);
        } catch (err) {
          setError(err instanceof RegistryError ? err.message : `Could not read ${label(ref)}: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="byname">Or check a published release by name, no download</label>
      <div className="row">
        <input id="byname" value={text} onChange={(e) => setText(e.target.value)} placeholder="owner/repo@v1.2.0, name==1.2.0, name@1.2.0" spellCheck={false} />
        <button type="submit" disabled={busy}>
          {busy ? "Reading..." : "Check"}
        </button>
      </div>
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Verify() {
  const [category, setCategory] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [events, setEvents] = useState<SealEvent[] | null>(null);
  const [opened, setOpened] = useState("");
  const [manifests, setManifests] = useState<Record<string, Manifest>>({});
  const [wrong, setWrong] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [from, setFrom] = useState<Fetched>();
  const [tips, setTips] = useState<TipRow[]>();

  // Tips are read after the timeline shows, so a slow history never holds up the check.
  const loadTips = useCallback(async (cat: string, ev: SealEvent[]) => {
    try {
      setTips(await projectTips(await rpc(), cat, ev));
    } catch {
      setTips(undefined);
    }
  }, []);

  const load = useCallback(async (cat: string) => {
    setError("");
    setEvents(null);
    setResults(null);
    if (!/^[0-9a-f]{64}$/i.test(cat)) return setError("A project id is the 64-character token category.");
    setBusy("Reading the chain...");
    try {
      const ev = await walkProject(await rpc(), cat.toLowerCase());
      if (!ev.length) throw new Error("No seal records found for this project.");
      // a replaced list must not shadow an honest seal.json the user drops, so only a list with the chain's root is kept
      const { lists, wrong } = await loadManifests(ev, async (url, signal) => (await fetch(url, { signal })).text());
      setManifests(lists);
      setWrong(wrong);
      setEvents(ev);
      setTips(undefined);
      loadTips(cat.toLowerCase(), ev);
      setOpened(cat.toLowerCase());
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(/No such mempool or blockchain transaction/.test(msg) ? "No project with this id exists on Bitcoin Cash. Check the id or the link." : msg);
    } finally {
      setBusy("");
    }
  }, [loadTips]);

  useEffect(() => {
    if (category) load(category);
    // load once for a ?project= link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async (all: FileEntry[], raw: File[]) => {
    if (!events) return;
    setFrom(undefined);
    // A dropped seal.json stands in for a list the page could not fetch (site down or taken over, no CORS); the chain decides.
    const lists = await Promise.all(raw.map(async (f) => (/\.json$/i.test(f.name) && f.size < 1e6 ? parseManifest(await f.text()) : undefined)));
    setResults(verdicts(events, manifests, wrong, all, lists));
  };

  const latest = events?.filter((e) => e.kind === "release").at(-1);
  const green = greenRelease(results);
  const name = events?.find((e) => e.kind === "genesis")?.version;
  // the id that was opened, not the input box, which the user may have edited since
  const badge = events ? badgeSnippets(new URL(".", location.href).href, opened) : undefined;
  return (
    <section>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          // a pasted project or badge link opens its project
          const id = projectId(category) ?? category;
          setCategory(id);
          history.replaceState(null, "", `?project=${id}`);
          load(id);
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
            {tips && tips.length > 0 && (
              <p className="muted">
                Tipped {tips.length} time{tips.length === 1 ? "" : "s"} by people who checked a release,{" "}
                {tips.reduce((a, t) => a + t.sats, 0n).toLocaleString("en-US")} sats in all.
              </p>
            )}
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.txid} className={e.revoked ? "revoked" : ""}>
                  <b>{e.kind === "genesis" ? "created" : e.kind === "move" ? "handed over" : e.kind}</b>{" "}
                  {e.kind === "moved" || e.kind === "move"
                    ? `to ${short(e.publisher.replace("bitcoincash:", ""), 6)}${e.kind === "move" && e.version ? `: ${e.version}` : ""}`
                    : e.kind !== "genesis" && e.version}
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
                <p className="muted">
                  Or a live box on the download page itself: it shows the latest sealed version and checks a dropped file in place (
                  <a href="./widget-demo/">example page</a>).
                </p>
                <Snippet label="Live widget (HTML)" text={badge.widget} />
              </details>
            )}
          </div>
          <DemoFiles project={opened} />
          <DropZone onFiles={verify} label="Drop downloaded files here to check them" />
          <ByName
            onStart={() => {
              setFrom(undefined);
              setResults(null);
            }}
            onFetched={(f) => {
              setFrom(f);
              setResults(verdicts(events, manifests, wrong, f.files, f.files.map(() => undefined)));
            }}
          />
        </>
      )}
      {from && results && (
        <p className="muted">
          Checked {from.files.length} file{from.files.length === 1 ? "" : "s"} of <a href={from.page}>{label(from.ref)}</a> by the hashes{" "}
          {from.ref.source === "npm" ? "of the tarball, fetched from the npm registry" : `${from.ref.source === "github" ? "GitHub" : "PyPI"} publishes`}.
          {from.skipped.length > 0 && ` Not checked, no SHA-256 published: ${from.skipped.join(", ")}.`}
        </p>
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
              {checkLine(c, r.unchecked)}
            </p>
          ))}
        </div>
      ))}
      {events && green && (
        <Suspense fallback={<p className="muted">Loading the wallet tools...</p>}>
          <Tip category={opened} version={green.version} holder={events.at(-1)!.publisher} onSent={() => setTimeout(() => loadTips(opened, events), 1500)} />
        </Suspense>
      )}
    </section>
  );
}


export default function App() {
  const [tab, setTab] = useState<"verify" | "publish">("verify");
  const q = new URLSearchParams(location.search);
  if (q.get("embed") === "1") {
    return (
      <Suspense fallback={null}>
        <Embed project={(q.get("project") ?? "").toLowerCase()} />
      </Suspense>
    );
  }
  return (
    <main>
      <div className="banner">
        <a href={BANNER.deck || undefined}>Deck</a>
        <a href={BANNER.repo || undefined}>Source</a>
        <a href="./story/">Story</a>
        <a href="./2026-11-14/" title="The app as it stood on 14 Nov 2026, when the BLAZE judged window opened">14 Nov demo</a>
        <a href="https://github.com/emilhuseyn/release-seal/tree/blaze-2026-11-14" title="Source at tag blaze-2026-11-14">14 Nov code</a>
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
