import { useEffect, useRef, useState } from "react";
import { walkProject, type SealEvent } from "./chain";
import { rpc } from "./rpc";
import { loadManifests, oneLine, parseManifest, verdicts, type FileEntry, type Manifest } from "./seal";
import { DropZone } from "./ui";

// The page height goes to the download page that holds this frame (public/widget.js), which sizes the frame to it.
// Only a number is sent; the loader checks that the message comes from its own frame.
const useReportHeight = (deps: unknown[]) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.parent === window) return;
    const send = () => window.parent.postMessage({ releaseSeal: "height", height: Math.ceil(el.getBoundingClientRect().height) + 2 }, "*");
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
};

// ?project=<id>&embed=1: what a download page shows through widget.js. The latest sealed version, its block, revoked or not, and
// a drop box that answers in one line. The full check opens in a new tab.
export default function Embed({ project }: { project: string }) {
  const [events, setEvents] = useState<SealEvent[]>();
  const [lists, setLists] = useState<{ lists: Record<string, Manifest>; wrong: Record<string, boolean> }>();
  const [error, setError] = useState("");
  const [line, setLine] = useState<{ good: boolean; text: string }>();
  const ref = useReportHeight([events, error, line]);

  // the frame's corners show the host page, not this app's dark background
  useEffect(() => {
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  useEffect(() => {
    if (!/^[0-9a-f]{64}$/.test(project)) return setError("No project id in the widget.");
    (async () => {
      try {
        const ev = await walkProject(await rpc(), project);
        if (!ev.length) throw new Error("No seal records for this project.");
        setLists(await loadManifests(ev, async (url, signal) => (await fetch(url, { signal })).text()));
        setEvents(ev);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        setError(/No such mempool or blockchain transaction/.test(msg) ? "No project with this id on Bitcoin Cash." : msg);
      }
    })();
  }, [project]);

  const check = async (all: FileEntry[], raw: File[]) => {
    if (!events || !lists) return;
    const dropped = await Promise.all(raw.map(async (f) => (/\.json$/i.test(f.name) && f.size < 1e6 ? parseManifest(await f.text()) : undefined)));
    setLine(oneLine(verdicts(events, lists.lists, lists.wrong, all, dropped)));
  };

  const latest = events?.filter((e) => e.kind === "release").at(-1);
  const name = events?.find((e) => e.kind === "genesis")?.version;
  const full = `${new URL(".", location.href).href}?project=${project}`;
  return (
    <div className="embed" ref={ref}>
      <p className="embed-head">
        <b>Release Seal</b>{" "}
        {events ? (
          <>
            {name}: {latest ? `${latest.version}, block ${latest.height || "unconfirmed"}` : "no release yet"}
            {latest?.revoked && <span className="tag bad">revoked</span>}
          </>
        ) : error ? (
          <span className="bad">{error}</span>
        ) : (
          <span className="muted">reading Bitcoin Cash...</span>
        )}
      </p>
      {events && <DropZone onFiles={check} label="Drop your download here to check it" />}
      {line && (
        <p className={line.good ? "good" : "bad"} role="status">
          {line.text}
        </p>
      )}
      <p className="muted embed-foot">
        <a href={full} target="_blank" rel="noopener">
          Full check and history
        </a>
      </p>
    </div>
  );
}
