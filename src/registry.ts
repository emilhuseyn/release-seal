// Check by name: the file list of a published release, read from the registry instead of downloaded by hand.
// GitHub release assets and PyPI files carry their SHA-256; npm gives only sha512/sha1, so its tarball is fetched and hashed.
// Leaves are the same (name, size, sha256) as seal.ts, so the result goes through the same verdicts as dropped files.
import { entryFor, type FileEntry } from "./seal";

export type Source = "github" | "pypi" | "npm";

export interface Ref {
  source: Source;
  name: string;
  version: string;
}

export interface Fetched {
  ref: Ref;
  files: FileEntry[];
  skipped: string[];
  page: string;
}

const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const GH_REPO = /^[\w.-]+\/[\w.-]+$/;
const PYPI_NAME = /^[a-z0-9]([\w.-]*[a-z0-9])?$/i;

// owner/repo@tag, name==version, name@version or @scope/name@version, an explicit github: / pypi: / npm: prefix, or the release's
// page URL on github.com, pypi.org or npmjs.com.
export const parseRef = (text: string): Ref | undefined => {
  const t = text.trim();
  let m = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/tag\/([^/?#]+)/i.exec(t);
  if (m) return { source: "github", name: m[1], version: decodeURIComponent(m[2]) };
  m = /^https?:\/\/pypi\.org\/project\/([^/]+)\/([^/?#]+)/i.exec(t);
  if (m) return { source: "pypi", name: m[1], version: m[2] };
  m = /^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/]+)\/v\/([^/?#]+)/i.exec(t);
  if (m) return { source: "npm", name: decodeURIComponent(m[1]), version: m[2] };
  const pre = /^(github|gh|pypi|npm):\s*(.+)$/i.exec(t);
  const body = pre ? pre[2].trim() : t;
  const want = pre ? (pre[1].toLowerCase() === "gh" ? "github" : (pre[1].toLowerCase() as Source)) : undefined;
  m = /^(.+?)==(.+)$/.exec(body);
  if (m && (!want || want === "pypi") && PYPI_NAME.test(m[1]) && !/\s/.test(m[2])) return { source: "pypi", name: m[1], version: m[2] };
  const at = body.lastIndexOf("@");
  if (at <= 0 || /\s/.test(body)) return undefined;
  const name = body.slice(0, at);
  const version = body.slice(at + 1);
  if (!version) return undefined;
  if (want === "github" || (!want && !name.startsWith("@") && GH_REPO.test(name))) {
    return GH_REPO.test(name) ? { source: "github", name, version } : undefined;
  }
  if ((want === "npm" || !want) && NPM_NAME.test(name)) return { source: "npm", name, version };
  return undefined;
};

export class RegistryError extends Error {}

type Get = (url: string) => Promise<Response>;

const json = async (get: Get, url: string, what: string) => {
  const r = await get(url);
  if (r.status === 404) throw new RegistryError(`${what} was not found.`);
  if (r.status === 403 || r.status === 429) {
    throw new RegistryError(`${new URL(url).host} refused the request (rate limit: GitHub allows 60 an hour per address). Try again later or drop the files.`);
  }
  if (!r.ok) throw new RegistryError(`${new URL(url).host} answered ${r.status}.`);
  return r.json();
};

interface GhAsset {
  name: string;
  size: number;
  digest?: string | null;
}

// Assets uploaded before GitHub added digests (mid 2025) have none; those are named, not guessed.
export const githubFiles = (assets: GhAsset[]) => {
  const files: FileEntry[] = [];
  const skipped: string[] = [];
  for (const a of assets) {
    const m = /^sha256:([0-9a-f]{64})$/i.exec(a.digest ?? "");
    if (m && Number.isSafeInteger(a.size)) files.push({ name: a.name, size: a.size, sha256: m[1].toLowerCase() });
    else skipped.push(a.name);
  }
  return { files, skipped };
};

interface PypiUrl {
  filename: string;
  size: number;
  digests?: { sha256?: string };
}

export const pypiFiles = (urls: PypiUrl[]) => {
  const files: FileEntry[] = [];
  const skipped: string[] = [];
  for (const u of urls) {
    const h = u.digests?.sha256 ?? "";
    if (/^[0-9a-f]{64}$/i.test(h) && Number.isSafeInteger(u.size)) files.push({ name: u.filename, size: u.size, sha256: h.toLowerCase() });
    else skipped.push(u.filename);
  }
  return { files, skipped };
};

const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export const fetchRelease = async (ref: Ref, get: Get = (u) => fetch(u)): Promise<Fetched> => {
  if (ref.source === "github") {
    const rel = await json(get, `https://api.github.com/repos/${enc(ref.name)}/releases/tags/${encodeURIComponent(ref.version)}`, `GitHub release ${ref.name}@${ref.version}`);
    const { files, skipped } = githubFiles(rel.assets ?? []);
    return { ref, files, skipped, page: rel.html_url ?? `https://github.com/${ref.name}/releases/tag/${ref.version}` };
  }
  if (ref.source === "pypi") {
    const rel = await json(get, `https://pypi.org/pypi/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.version)}/json`, `PyPI ${ref.name}==${ref.version}`);
    const { files, skipped } = pypiFiles(rel.urls ?? []);
    return { ref, files, skipped, page: `https://pypi.org/project/${ref.name}/${ref.version}/` };
  }
  const name = ref.name.startsWith("@") ? `@${encodeURIComponent(ref.name.slice(1))}` : encodeURIComponent(ref.name);
  const meta = await json(get, `https://registry.npmjs.org/${name}/${encodeURIComponent(ref.version)}`, `npm ${ref.name}@${ref.version}`);
  const url: string | undefined = meta?.dist?.tarball;
  if (!url || !/^https:\/\/registry\.npmjs\.org\//.test(url)) throw new RegistryError(`npm ${ref.name}@${ref.version} has no tarball on registry.npmjs.org.`);
  const r = await get(url);
  if (!r.ok) throw new RegistryError(`The tarball ${url} answered ${r.status}.`);
  const file = entryFor(url.slice(url.lastIndexOf("/") + 1), new Uint8Array(await r.arrayBuffer()));
  return { ref, files: [file], skipped: [], page: `https://www.npmjs.com/package/${ref.name}/v/${ref.version}` };
};

// What the user typed, written back in the form each registry uses.
export const label = (ref: Ref) => (ref.source === "pypi" ? `${ref.name}==${ref.version}` : `${ref.name}@${ref.version}`);
