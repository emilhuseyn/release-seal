import { useState } from "react";
import { entryFor, type FileEntry } from "./seal";

// A dropped folder (or a file the browser cannot read) rejects arrayBuffer(); it is skipped and named instead of failing silently.
export const readFiles = async (list: FileList | File[]) => {
  const all = [...list];
  const read = await Promise.allSettled(all.map(async (f) => entryFor(f.name, new Uint8Array(await f.arrayBuffer()))));
  const ok = read.flatMap((r, i) => (r.status === "fulfilled" ? [{ entry: r.value, file: all[i] }] : []));
  return {
    entries: ok.map((o) => o.entry),
    files: ok.map((o) => o.file),
    failed: all.filter((_, i) => read[i].status === "rejected").map((f) => f.name),
  };
};

export const short = (s: string, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}...${s.slice(-n)}` : s);

export function DropZone({ onFiles, label }: { onFiles: (f: FileEntry[], raw: File[]) => void; label: string }) {
  const [over, setOver] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const take = async (list: File[]) => {
    const r = await readFiles(list);
    setFailed(r.failed);
    if (r.entries.length) onFiles(r.entries, r.files);
  };
  return (
    <label
      className={`drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take([...e.dataTransfer.files]);
      }}
    >
      {/* visually hidden, not display:none, so Tab reaches it; value cleared so picking the same file again still fires */}
      <input
        type="file"
        multiple
        className="visually-hidden"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          take(list);
        }}
      />
      <span>{label}</span>
      <small>Files are hashed in your browser. Nothing is uploaded.</small>
      {failed.length > 0 && (
        <span className="bad" role="alert">
          Could not read {failed.join(", ")}. Drop files, not folders.
        </span>
      )}
    </label>
  );
}

export function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <div className="row">
        <span className="muted">{label}</span>
        <button
          type="button"
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
