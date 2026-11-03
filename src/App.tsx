import { binToHex, hexToBin, publicKeyToP2pkhLockingBytecode, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { listUnspent, walkProject, type SealEvent } from "./chain";
import { rpc } from "./rpc";
import { checkFiles, entryFor, findDuplicates, merkleRoot, type Check, type FileEntry, type Manifest } from "./seal";
import { buildSealTx, wizardRequest } from "./tx";

// Banner links required by the BLAZE rules. Emil fills these before submission.
const BANNER = {
  deck: "",
  repo: "",
  emberAddress: "",
};

const readFiles = async (list: FileList | File[]) =>
  Promise.all([...list].map(async (f) => entryFor(f.name, new Uint8Array(await f.arrayBuffer()))));

const short = (s: string, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}...${s.slice(-n)}` : s);

function DropZone({ onFiles, label }: { onFiles: (f: FileEntry[]) => void; label: string }) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        onFiles(await readFiles(e.dataTransfer.files));
      }}
    >
      <input type="file" multiple hidden onChange={async (e) => e.target.files && onFiles(await readFiles(e.target.files))} />
      <span>{label}</span>
      <small>Files are hashed in your browser. Nothing is uploaded.</small>
    </label>
  );
}

interface Result {
  event: SealEvent;
  rootOk: boolean;
  checks: Check[];
}

function Verify() {
  const [category, setCategory] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [events, setEvents] = useState<SealEvent[] | null>(null);
  const [manifests, setManifests] = useState<Record<string, Manifest>>({});
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
      for (const e of ev.filter((x) => x.kind === "release")) {
        try {
          ms[e.txid] = await (await fetch(e.manifestUrl)).json();
        } catch {
          // a missing manifest shows as unverifiable for that release
        }
      }
      setManifests(ms);
      setEvents(ev);
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

  const verify = (dropped: FileEntry[]) => {
    if (!events) return;
    const out: Result[] = [];
    for (const event of events.filter((e) => e.kind === "release").reverse()) {
      const m = manifests[event.txid];
      if (!m) continue;
      const r = checkFiles(m, hexToBin(event.commitment), dropped);
      if (r.checks.some((c) => c.status !== "unknown")) out.push({ event, ...r });
    }
    setResults(out.length ? out : [{ event: events[events.length - 1], rootOk: true, checks: dropped.map((d) => ({ name: d.name, status: "unknown" })) }]);
  };

  const latest = events?.filter((e) => e.kind === "release").at(-1);
  const name = events?.find((e) => e.kind === "genesis")?.version;
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
      {busy && <p className="muted">{busy}</p>}
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
          {r.checks.map((c) => (
            <p key={c.name} className={c.status === "match" && r.rootOk && !r.event.revoked ? "good" : c.status === "unknown" ? "muted" : "bad"}>
              {c.status === "match" ? "Matches" : c.status === "changed" ? "DIFFERENT from" : "Not part of"} {c.expected?.name ?? "this release"}: {c.name}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

function Publish() {
  const wc = useWizardConnect({ dappName: "Release Seal", persistSession: true });
  const [ready, setReady] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const m = wc.manager;
    if (!m) return;
    const on = () => setReady(true);
    m.on("walletready", on);
    return () => {
      m.off?.("walletready", on);
    };
  }, [wc.manager]);

  const pub = ready ? wc.manager?.getPubkey(0, 0n) : undefined;
  const lock = useMemo(() => (pub ? publicKeyToP2pkhLockingBytecode({ publicKey: pub }) : undefined), [pub]);
  const address = useMemo(() => {
    if (!lock) return "";
    const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: "bitcoincash", tokenSupport: true });
    return typeof r === "string" ? r : r.address;
  }, [lock]);

  const manifest: Manifest = { protocol: 1, project, version, files };
  const dupes = findDuplicates(files);

  const send = async (kind: "genesis" | "release" | "revoke") => {
    if (!wc.manager || !lock) return;
    setStatus("Building the transaction...");
    try {
      const coins = await listUnspent(await rpc(), address);
      const mine = coins.filter((c) => c.token?.nft?.capability === "mutable");
      const nft = project ? mine.find((c) => binToHex(c.token!.category) === project) : undefined;
      const commitment = kind === "genesis" ? merkleRoot([]) : merkleRoot(files);
      const u = buildSealTx({
        record: { kind, version: kind === "genesis" ? name : version, manifestUrl: url },
        commitment,
        publisherLock: lock,
        funding: coins.filter((c) => !c.token),
        nft: kind === "genesis" ? undefined : nft,
      });
      setStatus(`Confirm in your wallet. Fee ${u.fee} sats.`);
      const res = await wc.manager.signTransaction(wizardRequest(u, `Release Seal: ${kind} ${kind === "genesis" ? "" : version}`));
      setStatus(kind === "genesis" ? `Project created. Its id is ${binToHex(u.category)}` : `Sealed. Transaction sent: ${short(res.signedTransaction, 6)}`);
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    }
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "seal.json";
    a.click();
  };

  return (
    <section>
      {!ready ? (
        <div className="card">
          <p>Connect a Bitcoin Cash wallet that speaks WizardConnect (for example Cashonize).</p>
          <button
            onClick={() => {
              wc.connect();
              setShowQr(true);
            }}
          >
            Connect wallet
          </button>
          {wc.error && <p className="bad">{wc.error}</p>}
          <WizardConnectQRDialog show={showQr && !!wc.uri} onClose={() => setShowQr(false)} uri={wc.uri ?? ""} qrUri={wc.qrUri ?? ""} title="Scan with your wallet" />
        </div>
      ) : (
        <div className="card">
          <p className="muted">
            {wc.walletName} connected. Publisher address {short(address.replace("bitcoincash:", ""), 8)}
          </p>
          <div className="row">
            <input value={project} onChange={(e) => setProject(e.target.value.trim())} placeholder="Project id (empty to create a new project)" />
            {!project && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" />}
          </div>
          <div className="row">
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Release version, e.g. v1.2.0" />
            <input value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="Project page or seal.json URL (https://...)" />
          </div>
          <DropZone onFiles={setFiles} label={files.length ? `${files.length} files, root ${short(binToHex(merkleRoot(files)), 6)}` : "Drop the release files"} />
          {dupes.length > 0 && <p className="bad">Duplicate names: {dupes.join(", ")}</p>}
          <div className="row">
            {!project && (
              <button disabled={!name || !url} onClick={() => send("genesis")}>
                Create project
              </button>
            )}
            <button disabled={!files.length || !version || !url || !project || dupes.length > 0} onClick={download}>
              Download seal.json
            </button>
            <button disabled={!files.length || !version || !url || !project || dupes.length > 0} onClick={() => send("release")}>
              Seal release
            </button>
            <button disabled={!version || !project} onClick={() => send("revoke")}>
              Revoke this version
            </button>
          </div>
          {status && <p className="muted">{status}</p>}
        </div>
      )}
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
      {tab === "verify" ? <Verify /> : <Publish />}
    </main>
  );
}
