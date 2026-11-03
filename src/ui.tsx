import { useState } from "react";
import { entryFor, type FileEntry } from "./seal";

export const readFiles = async (list: FileList | File[]) =>
  Promise.all([...list].map(async (f) => entryFor(f.name, new Uint8Array(await f.arrayBuffer()))));

export const short = (s: string, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}...${s.slice(-n)}` : s);

export function DropZone({ onFiles, label }: { onFiles: (f: FileEntry[]) => void; label: string }) {
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
