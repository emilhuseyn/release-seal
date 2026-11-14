import { binToHex } from "@bitauth/libauth";
import { useCallback, useEffect, useState } from "react";
import { broadcast, heldProjects, type HeldProject } from "./chain";
import { rpc } from "./rpc";
import { badgeSnippets, findDuplicates, merkleRoot, parseManifest, pickList, projectId, type FileEntry, type Manifest } from "./seal";
import { buildPrepTx, buildSealTx, firstSeal, FIRST_VERSION, holderLockOf, wizardRequest, type Send, type Utxo } from "./tx";
import { ConnectCard, useWallet } from "./wallet";
import { DropZone, short, Snippet } from "./ui";

export { PairBar } from "./wallet";

// Loaded only when the Seal tab opens, so the WizardConnect stack stays out of the Verify page bundle.
export default function Publish() {
  const w = useWallet();
  const { wc, lock, address, fundAddress, coinsNow } = w;
  const [drop, setDrop] = useState<{ entries: FileEntry[]; lists: (Manifest | undefined)[]; names: string[] }>({ entries: [], lists: [], names: [] });
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [heir, setHeir] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<{ sats: bigint; projects: HeldProject[] } | "error">();

  // Before any click the publisher sees whether the fee money arrived in the wallet and which projects it already holds.
  const loadWallet = useCallback(async () => {
    if (!address) return;
    try {
      const coins = await coinsNow();
      const sats = coins.filter((c) => !c.token).reduce((s, c) => s + c.satoshis, 0n);
      setWallet({ sats, projects: await heldProjects(await rpc(), coins) });
    } catch {
      setWallet("error");
    }
  }, [address, coinsNow]);
  useEffect(() => {
    loadWallet();
  }, [loadWallet]);

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

  const send = async (kind: "genesis" | "release" | "revoke" | "move") => {
    if (!wc.manager || !lock || busy) return;
    setBusy(true);
    setStatus("Building the transaction...");
    setSent("");
    try {
      const coins = await coinsNow();
      const mine = coins.filter((c) => c.token?.nft?.capability === "mutable");
      const nft = project ? mine.find((c) => binToHex(c.token!.category) === project) : undefined;
      // A hand-over keeps the last release's root on the NFT; it only changes who holds it.
      const holderLock = kind === "move" ? holderLockOf(heir, lock) : undefined;
      const commitment = kind === "genesis" ? merkleRoot([]) : kind === "move" ? (nft?.token?.nft?.commitment ?? merkleRoot([])) : merkleRoot(files);
      const record = { kind, version: kind === "genesis" ? name : kind === "move" ? reason.trim() : version, manifestUrl: kind === "move" ? "" : url };
      let funding: Utxo[] = coins.filter((c) => !c.token);
      if (kind === "genesis" && !funding.some((c) => c.vout === 0)) {
        const p = buildPrepTx({ publisherLock: lock, funding });
        buildSealTx({ record, commitment, publisherLock: lock, funding: [{ txid: "00".repeat(32), vout: 0, satoshis: p.value }] });
        setStatus(`Step 1 of 2: a project starts from a coin at output 0 and yours are elsewhere. Confirm a send to yourself, fee ${p.fee} sats.`);
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
        holderLock,
      });
      setStatus(
        kind === "move"
          ? `Confirm in your wallet. After this only the new address can seal or revoke versions of this project. Fee ${u.fee} sats.`
          : `Confirm in your wallet. Fee ${u.fee} sats.`,
      );
      const res = await wc.manager.signTransaction(
        wizardRequest(u, kind === "move" ? `Release Seal: hand the project over to ${heir.trim()}` : `Release Seal: ${kind} ${kind === "genesis" ? "" : version}`),
      );
      setStatus("Signed. Sending to the network...");
      const txid = await broadcast(await rpc(), res.signedTransaction);
      setSent(txid);
      if (kind === "genesis") setProject(binToHex(u.category));
      if (kind === "move") setHeir("");
      setStatus(
        kind === "genesis"
          ? `Project created. Its id is ${binToHex(u.category)}`
          : kind === "move"
            ? "Handed over. The project page now names the new holder, and their wallet lists the project on this tab."
            : kind === "revoke"
              ? `Version ${version} revoked.`
              : `Version ${version} sealed.`,
      );
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      loadWallet();
    }
  };

  const signAndSend: Send = async (u, step) => {
    setStatus(`${step}. Confirm in your wallet, fee ${u.fee} sats.`);
    const res = await wc.manager!.signTransaction(wizardRequest(u, `Release Seal: ${step}`));
    setStatus("Signed. Sending to the network...");
    return broadcast(await rpc(), res.signedTransaction);
  };

  // One press for a first try: a new project named after the file, the files sealed as v1, the project page as its link.
  const quick = async () => {
    if (!wc.manager || !lock || busy || !files.length) return;
    setBusy(true);
    setStatus("Building the transactions...");
    setSent("");
    const base = new URL(".", location.href).href;
    const link = (c: string) => badgeSnippets(base, c)?.link ?? base;
    let created = "";
    const keep = (c: string) => {
      setProject(c);
      setVersion(FIRST_VERSION);
      setUrl(link(c));
    };
    try {
      const coins = await coinsNow();
      const r = await firstSeal(
        { publisherLock: lock, funding: coins, files, name: (name || files[0].name).slice(0, 32), link, onCreated: (c) => (created = c) },
        signAndSend,
      );
      keep(r.category);
      setSent(r.release);
      setStatus(`Sealed ${files.length === 1 ? files[0].name : `${files.length} files`} as ${FIRST_VERSION}. Open the project page below and drop the same file, then a changed copy.`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (created) keep(created);
      setStatus(created ? `The project was created, but the seal was not sent (${msg}). Press Seal release to try again.` : msg);
    } finally {
      setBusy(false);
      loadWallet();
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
      <ConnectCard w={w}>
        <p className="muted">
          Once it pairs, drop any file and press <b>Seal it now</b> to seal it on mainnet for about 2,300 sats, 1,000 of which stay in
          your wallet on the seal NFT. Your wallet asks before each signature.
        </p>
      </ConnectCard>
      {lock && (
        <div className="card">
          <p className="muted">{wc.walletName} connected. Your projects live at this address. Fees come from any address in this wallet.</p>
          <Snippet label="Publisher address" text={fundAddress} />
          {wallet === "error" ? (
            <p className="bad">
              Could not read this wallet's coins. <button onClick={loadWallet}>Retry</button>
            </p>
          ) : (
            wallet && (
              <>
                <p className={wallet.sats ? "muted" : "bad"}>
                  {wallet.sats
                    ? `${wallet.sats.toLocaleString("en-US")} sats for fees in this wallet.`
                    : "No BCH in this wallet yet. A project and its first releases need about 3,400 sats: send them to the address above."}
                </p>
                {wallet.projects.length > 0 && (
                  <div className="row">
                    <span className="muted">Projects this wallet holds:</span>
                    {wallet.projects.map((p) => (
                      <button key={p.category} className={p.category === project ? "on" : ""} onClick={() => setProject(p.category)}>
                        {p.kind === "genesis" ? p.version : p.kind === "moved" ? `${p.version} (received)` : `${p.kind === "revoke" ? "revoked" : "sealed"} ${p.version}`}{" "}
                        {short(p.category, 4)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          )}
          {!project && (
            <p className="muted">
              First try? Drop any file below and press <b>Seal it now</b>. The page creates a project named after the file and seals
              it as v1 on mainnet: two or three confirmations in your wallet, about 2,300 sats, of which 1,000 stay in your wallet as
              the project's NFT.
            </p>
          )}
          <div className="row">
            <input value={project} onChange={(e) => setProject(projectId(e.target.value) ?? e.target.value.trim().toLowerCase())} placeholder="Project id (empty to create a new project)" />
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
              <button disabled={busy || !files.length || dupes.length > 0} onClick={quick}>
                Seal it now
              </button>
            )}
            {!project && (
              <button disabled={busy || !name || !url} onClick={() => send("genesis")}>
                Create project
              </button>
            )}
            <button disabled={!files.length || !version || !url || !project || dupes.length > 0} onClick={download}>
              Download seal.json
            </button>
            <button disabled={busy || !files.length || !version || !url || !project || dupes.length > 0} onClick={() => send("release")}>
              Seal release
            </button>
            <button disabled={busy || !version || !project} onClick={() => send("revoke")}>
              Revoke this version
            </button>
          </div>
          {project && (
            <div className="row">
              <input value={heir} onChange={(e) => setHeir(e.target.value)} placeholder="New maintainer's token address (z...)" spellCheck={false} />
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. key rotation (optional)" maxLength={60} />
              <button disabled={busy || !heir.trim()} onClick={() => send("move")}>
                Hand over
              </button>
            </div>
          )}
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
