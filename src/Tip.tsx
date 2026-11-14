import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import { useState } from "react";
import { broadcast } from "./chain";
import { rpc } from "./rpc";
import { buildTipTx, TIP_MIN, wizardRequest } from "./tx";
import { short } from "./ui";
import { ConnectCard, useWallet } from "./wallet";

export const TIP_AMOUNTS = [2_000n, 10_000n, 50_000n];

// The holder's locking bytecode from the address the walk reports (a z or q mainnet address).
export const holderLockFrom = (address: string) => {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === "string" || r.prefix !== "bitcoincash") throw new Error("The project holder's address is not a mainnet address");
  return r.bytecode;
};

// Loaded after a green check: pays the project's current holder from any WizardConnect wallet, with a tip record the project
// page counts. The NFT is not touched.
export default function Tip({ category, version, holder, onSent }: { category: string; version: string; holder: string; onSent: (txid: string) => void }) {
  const w = useWallet();
  const { wc, lock, coinsNow } = w;
  const [amount, setAmount] = useState(TIP_AMOUNTS[0]);
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);

  const tip = async () => {
    if (!wc.manager || !lock || busy) return;
    setBusy(true);
    setSent("");
    setStatus("Building the transaction...");
    try {
      const u = buildTipTx({ category, version, holderLock: holderLockFrom(holder), tipperLock: lock, funding: await coinsNow(), amount });
      setStatus(`Confirm in your wallet: ${amount.toLocaleString("en-US")} sats to the maintainer, fee ${u.fee} sats.`);
      const res = await wc.manager.signTransaction(wizardRequest(u, `Release Seal: tip ${amount} sats to the maintainer of ${version}`));
      setStatus("Signed. Sending to the network...");
      const txid = await broadcast(await rpc(), res.signedTransaction);
      setSent(txid);
      setStatus("Sent. Thank you: the maintainer gets it now, and the project page counts it.");
      onSent(txid);
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card tip">
      <h3>Tip the maintainer</h3>
      <p className="muted">
        The files check out. Say thanks with a small BCH tip to the address that holds this project ({short(holder.replace("bitcoincash:", ""), 6)}).
        It goes straight to them, on mainnet, from your own wallet.
      </p>
      <ConnectCard w={w} label="Connect wallet to tip" />
      {lock && (
        <>
          <div className="row">
            {TIP_AMOUNTS.map((a) => (
              <button key={String(a)} className={a === amount ? "on" : ""} onClick={() => setAmount(a)} disabled={busy}>
                {a.toLocaleString("en-US")} sats
              </button>
            ))}
            <button disabled={busy || amount < TIP_MIN} onClick={tip}>
              Send tip
            </button>
          </div>
          <p className="muted">{wc.walletName} connected. The fee is a few hundred sats; change comes back to your wallet.</p>
        </>
      )}
      {status && <p className="muted">{status}</p>}
      {sent && (
        <p className="good">
          Tip sent:{" "}
          <a href={`https://blockchair.com/bitcoin-cash/transaction/${sent}`} target="_blank" rel="noreferrer">
            {short(sent, 8)}
          </a>
        </p>
      )}
    </div>
  );
}
