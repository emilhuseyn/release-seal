import { hexToBin, lockingBytecodeToCashAddress, publicKeyToP2pkhLockingBytecode } from "@bitauth/libauth";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { walletCoins } from "./chain";
import { rpc } from "./rpc";
import { pairLinks, receiveKey } from "./tx";

// The QR dialog takes no children, so pairing without a second device sits in a bar of its own above the dialog's backdrop.
export function PairBar({ uri }: { uri: string }) {
  const links = pairLinks(uri);
  return (
    <div className="pairbar">
      <p>
        No phone to scan with? <a href={links.app}>Open in a wallet app on this device</a> or{" "}
        <a href={links.web} target="_blank" rel="noopener noreferrer">
          open the Cashonize web wallet
        </a>
        .
      </p>
      <p className="muted">Paytaca: press Copy above and paste the code in its WizardConnect page.</p>
    </div>
  );
}

// WizardConnect pairing, the receive/0 key and the wallet's coins, shared by the Seal tab and the tip button. Both load lazily,
// so the WizardConnect stack stays out of the Verify page bundle until a wallet is wanted.
export function useWallet() {
  const wc = useWizardConnect({ dappName: "Release Seal", persistSession: true });
  const [ready, setReady] = useState(false);
  const [pubHex, setPubHex] = useState("");
  const [showQr, setShowQr] = useState(false);
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
    setReady(false);
    setPubHex("");
    setStale(false);
    setRenew(true);
  };

  // The key is read on every wallet_ready: Selene's second one (after its user approves) changes nothing in the hook's state,
  // so a key read once at render time would stay empty.
  useEffect(() => {
    const m = wc.manager;
    if (!m) return;
    const on = () => {
      setReady(true);
      setPubHex(receiveKey(m));
    };
    m.on("walletready", on);
    return () => {
      m.off?.("walletready", on);
    };
  }, [wc.manager]);

  const lock = useMemo(() => (pubHex ? publicKeyToP2pkhLockingBytecode({ publicKey: hexToBin(pubHex) }) : undefined), [pubHex]);
  const address = useMemo(() => {
    if (!lock) return "";
    const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: "bitcoincash", tokenSupport: true });
    return typeof r === "string" ? r : r.address;
  }, [lock]);
  // Exchanges and most wallets send only to the plain q address; the token-aware z address above holds the same coins.
  const fundAddress = useMemo(() => {
    if (!lock) return "";
    const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: "bitcoincash" });
    return typeof r === "string" ? r : r.address;
  }, [lock]);

  // Every address of the wallet the page may spend from; pubHex is a dependency because xpubs can arrive after the manager.
  const coinsNow = useCallback(async () => {
    const m = wc.manager;
    return walletCoins(await rpc(), (child, index) => {
      const k = pubHex ? m?.getPubkey(child, BigInt(index)) : undefined;
      return k ? publicKeyToP2pkhLockingBytecode({ publicKey: k }) : undefined;
    });
  }, [wc.manager, pubHex]);

  return { wc, ready, lock, address, fundAddress, coinsNow, showQr, setShowQr, stale, freshQr };
}

export type Wallet = ReturnType<typeof useWallet>;

// What shows until the wallet has paired and shared its address; null after that.
export function ConnectCard({ w, children, label = "Connect wallet" }: { w: Wallet; children?: ReactNode; label?: string }) {
  const { wc, ready, lock, showQr, setShowQr, stale, freshQr } = w;
  if (ready && lock) return null;
  return (
    <>
      {!ready ? (
        <div className="card">
          <p>Connect a Bitcoin Cash wallet that speaks WizardConnect: Cashonize, Paytaca or Selene (2026.10 or newer).</p>
          {children}
          <button
            onClick={() => {
              wc.connect();
              setShowQr(true);
            }}
          >
            {label}
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
            className="wc-backdrop"
          />
          {showQr && wc.uri && createPortal(<PairBar uri={wc.uri} />, document.body)}
        </div>
      ) : (
        <div className="card">
          <p>
            {wc.walletName ?? "Your wallet"} is paired but has not shared its address yet. Approve Release Seal in the wallet.
          </p>
          <p className="muted">
            Declined, or nothing after a minute? <button onClick={freshQr}>New QR code</button>
          </p>
        </div>
      )}
    </>
  );
}
