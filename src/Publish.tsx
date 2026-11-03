import { binToHex, publicKeyToP2pkhLockingBytecode, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { useEffect, useMemo, useState } from "react";
import { broadcast, listUnspent } from "./chain";
import { rpc } from "./rpc";
import { findDuplicates, merkleRoot, parseManifest, pickList, type FileEntry, type Manifest } from "./seal";
import { buildPrepTx, buildSealTx, wizardRequest, type Utxo } from "./tx";
import { DropZone, short } from "./ui";

// Loaded only when the Seal tab opens, so the WizardConnect stack stays out of the Verify page bundle.
export default function Publish() {
  const wc = useWizardConnect({ dappName: "Release Seal", persistSession: true });
  const [ready, setReady] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [drop, setDrop] = useState<{ entries: FileEntry[]; lists: (Manifest | undefined)[]; names: string[] }>({ entries: [], lists: [], names: [] });
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState("");
  const [stale, setStale] = useState(false);

  // The dapp gives up on the key exchange 30 s after the relay connects and only logs it, so a QR scanned later never pairs.
  useEffect(() => {
    if (ready || !showQr || !wc.uri) return;
    setStale(false);
    const t = setTimeout(() => setStale(true), 30_000);
    return () => clearTimeout(t);
  }, [ready, showQr, wc.uri]);

  // connect() refuses while the hook's state still reads "connecting", so the new pairing starts once disconnect has set it to idle.
  const [renew, setRenew] = useState(false);
  const { state: wcState, connect } = wc;
  useEffect(() => {
    if (!renew || wcState !== "idle") return;
    setRenew(false);
    if (connect()) setShowQr(true);
  }, [renew, wcState, connect]);

  const freshQr = async () => {
    await wc.disconnect();
    setStale(false);
    setRenew(true);
  };

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

  // A seal.json from a release job (public/seal-manifest.mjs) stands in for the files; any files dropped with it must be on it.
  // Derived on every render, so a project id typed after the drop is still checked against the list.
  const picked = pickList(drop.entries, drop.lists, project);
  const files = picked.files;
  const fromList = picked.list ? drop.names[drop.lists.indexOf(picked.list)] : "";
  const pick = async (entries: FileEntry[], raw: File[]) => {
    const lists = await Promise.all(raw.map(async (f) => (/\.json$/i.test(f.name) && f.size < 1e6 ? parseManifest(await f.text()) : undefined)));
    setDrop({ entries, lists, names: raw.map((f) => f.name) });
    const v = lists.find((l) => l)?.version;
    if (!version && v) setVersion(v);
  };

  const manifest: Manifest = { protocol: 1, project, version, files };
  const dupes = findDuplicates(files);

  const send = async (kind: "genesis" | "release" | "revoke") => {
    if (!wc.manager || !lock) return;
    setStatus("Building the transaction...");
    setSent("");
    try {
      const coins = await listUnspent(await rpc(), address);
      const mine = coins.filter((c) => c.token?.nft?.capability === "mutable");
      const nft = project ? mine.find((c) => binToHex(c.token!.category) === project) : undefined;
      const commitment = kind === "genesis" ? merkleRoot([]) : merkleRoot(files);
      const record = { kind, version: kind === "genesis" ? name : version, manifestUrl: url };
      let funding: Utxo[] = coins.filter((c) => !c.token);
      if (kind === "genesis" && !funding.some((c) => c.vout === 0)) {
        const p = buildPrepTx({ publisherLock: lock, funding });
        buildSealTx({ record, commitment, publisherLock: lock, funding: [{ txid: "00".repeat(32), vout: 0, satoshis: p.value }] });
        setStatus(`Step 1 of 2: a project starts from a coin at output 0 and yours are elsewhere. Confirm moving them to yourself, fee ${p.fee} sats.`);
        const pr = await wc.manager.signTransaction(wizardRequest(p, "Release Seal: move coins to output 0 before creating the project"));
        const prepTxid = await broadcast(await rpc(), pr.signedTransaction);
        funding = [{ txid: prepTxid, vout: 0, satoshis: p.value }];
        setStatus("Step 2 of 2: building the project transaction...");
      }
      const u = buildSealTx({
        record,
        commitment,
        publisherLock: lock,
        funding,
        nft: kind === "genesis" ? undefined : nft,
      });
      setStatus(`Confirm in your wallet. Fee ${u.fee} sats.`);
      const res = await wc.manager.signTransaction(wizardRequest(u, `Release Seal: ${kind} ${kind === "genesis" ? "" : version}`));
      setStatus("Signed. Sending to the network...");
      const txid = await broadcast(await rpc(), res.signedTransaction);
      setSent(txid);
      if (kind === "genesis") setProject(binToHex(u.category));
      setStatus(kind === "genesis" ? `Project created. Its id is ${binToHex(u.category)}` : kind === "revoke" ? `Version ${version} revoked.` : `Version ${version} sealed.`);
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
          {stale && (
            <p className="muted">
              No wallet yet. A code older than 30 seconds may no longer pair. <button onClick={freshQr}>New QR code</button>
            </p>
          )}
          <WizardConnectQRDialog
            show={showQr && !!wc.uri}
            onClose={() => setShowQr(false)}
            uri={wc.uri ?? ""}
            qrUri={wc.qrUri ?? ""}
            title="Scan with your wallet"
            subtitle={stale ? "This code is over 30 seconds old and may not pair. Close this and press New QR code." : undefined}
          />
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
          <DropZone
            onFiles={pick}
            label={
              files.length
                ? `${files.length} files${fromList ? ` from ${fromList}` : ""}, root ${short(binToHex(merkleRoot(files)), 6)}`
                : "Drop the release files, or the seal.json your release job wrote"
            }
          />
          {picked.error && <p className="bad">{picked.error}</p>}
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
          {sent && (
            <p className="muted">
              Transaction{" "}
              <a href={`https://blockchair.com/bitcoin-cash/transaction/${sent}`} target="_blank" rel="noreferrer">
                {short(sent, 8)}
              </a>
            </p>
          )}
          {/^[0-9a-f]{64}$/i.test(project) && (
            <p className="muted">
              <a href={`./?project=${project.toLowerCase()}`}>Project page</a>: the link to share, and the badge for your download page.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
