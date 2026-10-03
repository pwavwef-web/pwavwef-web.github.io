/**
 * Test doubles for worker-level tests: an in-memory Firestore (documents, nested paths, transactions,
 * batches, simple queries and the FieldValue sentinels the backend uses), a recorded Cloud Tasks queue,
 * a no-op media bucket and a scripted Google client. Nothing here talks to Google or Firebase.
 */

type Data = Record<string, unknown>;

export const store = new Map<string, Data>();
/** Write counter per document (transactions retry when a document they read was written meanwhile). */
const versions = new Map<string, number>();
const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);
let clock = 1_800_000_000_000;
export const now = () => clock;
export const advance = (ms: number) => (clock += ms);

interface Sentinel {
  __op: 'ts' | 'delete' | 'inc' | 'union';
  n?: number;
  items?: unknown[];
}
const isSentinel = (v: unknown): v is Sentinel => Boolean(v && typeof v === 'object' && '__op' in (v as object));
const isPlain = (v: unknown): v is Data => Boolean(v && typeof v === 'object' && !Array.isArray(v) && !isSentinel(v) && !(v as { toMillis?: unknown }).toMillis);

export const FieldValue = {
  serverTimestamp: (): Sentinel => ({ __op: 'ts' }),
  delete: (): Sentinel => ({ __op: 'delete' }),
  increment: (n: number): Sentinel => ({ __op: 'inc', n }),
  arrayUnion: (...items: unknown[]): Sentinel => ({ __op: 'union', items }),
};
export const Timestamp = { now: () => ({ toMillis: () => clock }) };

function resolve(existing: unknown, value: unknown): unknown {
  if (isSentinel(value)) {
    if (value.__op === 'ts') {
      const at = clock;
      return { toMillis: () => at };
    }
    if (value.__op === 'inc') return (typeof existing === 'number' ? existing : 0) + (value.n ?? 0);
    if (value.__op === 'union') {
      const arr = Array.isArray(existing) ? [...existing] : [];
      for (const it of value.items ?? []) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(it))) arr.push(it);
      return arr;
    }
    return undefined;
  }
  if (isPlain(value)) {
    const out: Data = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(undefined, v);
      if (!(isSentinel(v) && v.__op === 'delete') && r !== undefined) out[k] = r;
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((x) => resolve(undefined, x));
  return value;
}

function deepMerge(target: Data, patch: Data): Data {
  const out: Data = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (isSentinel(v) && v.__op === 'delete') {
      delete out[k];
      continue;
    }
    if (isPlain(v) && isPlain(out[k])) out[k] = deepMerge(out[k] as Data, v);
    else {
      const r = resolve(out[k], v);
      if (r !== undefined) out[k] = r;
    }
  }
  return out;
}

function setPath(target: Data, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = target;
  for (const k of keys.slice(0, -1)) {
    if (!isPlain(cur[k])) cur[k] = {};
    cur = cur[k] as Data;
  }
  const last = keys[keys.length - 1]!;
  if (isSentinel(value) && value.__op === 'delete') delete cur[last];
  else cur[last] = resolve(cur[last], value);
}

export function getPath(data: Data | undefined, path: string): unknown {
  let cur: unknown = data;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Data)[k];
  }
  return cur;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && typeof (x as { toMillis?: unknown }).toMillis === 'function' ? { __ts: (x as { toMillis: () => number }).toMillis() } : x)), (_k, x) => (x && typeof x === 'object' && '__ts' in x ? { toMillis: () => (x as { __ts: number }).__ts } : x)) as T));

let idCounter = 0;
const autoId = () => `id${(++idCounter).toString(36).padStart(5, '0')}`;

export class FakeSnapshot {
  constructor(
    public readonly ref: FakeDocRef,
    private readonly raw: Data | undefined,
  ) {}
  get exists() {
    return this.raw !== undefined;
  }
  get id() {
    return this.ref.id;
  }
  data() {
    return clone(this.raw);
  }
  get(field: string) {
    return clone(getPath(this.raw, field));
  }
}

export class FakeDocRef {
  constructor(public readonly path: string) {}
  get id() {
    return this.path.split('/').pop()!;
  }
  collection(name: string) {
    return new FakeCollection(`${this.path}/${name}`);
  }
  async get() {
    return new FakeSnapshot(this, store.get(this.path));
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    writeDoc(this.path, data, opts?.merge);
  }
  async update(data: Data) {
    updateDoc(this.path, data);
  }
  async delete() {
    bump(this.path);
    store.delete(this.path);
  }
}

function writeDoc(path: string, data: Data, merge?: boolean) {
  bump(path);
  const cur = store.get(path);
  if (merge && cur) store.set(path, deepMerge(cur, data));
  else if (merge) store.set(path, deepMerge({}, data));
  else store.set(path, resolve(undefined, data) as Data);
}

function updateDoc(path: string, data: Data) {
  bump(path);
  const cur = store.get(path);
  if (!cur) throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
  const next = clone(cur) as Data;
  for (const [k, v] of Object.entries(data)) setPath(next, k, v);
  store.set(path, next);
}

type Filter = { field: string; op: string; value: unknown };

export class FakeQuery {
  constructor(
    public readonly path: string,
    private readonly filters: Filter[] = [],
    private readonly order: { field: string; dir: 'asc' | 'desc' } | null = null,
    private readonly lim: number | null = null,
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.path, [...this.filters, { field, op, value }], this.order, this.lim);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.path, this.filters, { field, dir }, this.lim);
  }
  limit(n: number) {
    return new FakeQuery(this.path, this.filters, this.order, n);
  }
  async get() {
    const depth = this.path.split('/').length + 1;
    let docs = [...store.entries()].filter(([p]) => p.startsWith(`${this.path}/`) && p.split('/').length === depth).map(([p, d]) => ({ p, d }));
    for (const f of this.filters) {
      docs = docs.filter(({ d }) => {
        const v = getPath(d, f.field);
        if (f.op === '==') return JSON.stringify(v) === JSON.stringify(f.value);
        if (f.op === 'in') return (f.value as unknown[]).some((x) => JSON.stringify(x) === JSON.stringify(v));
        if (f.op === '>') return (v as number) > (f.value as number);
        return true;
      });
    }
    if (this.order) {
      const { field, dir } = this.order;
      const key = (d: Data) => {
        const v = getPath(d, field) as unknown;
        return v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : (v as number);
      };
      docs.sort((a, b) => ((key(a.d) ?? 0) < (key(b.d) ?? 0) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
    }
    if (this.lim !== null) docs = docs.slice(0, this.lim);
    const snaps = docs.map(({ p, d }) => new FakeSnapshot(new FakeDocRef(p), d));
    return { docs: snaps, size: snaps.length, empty: snaps.length === 0 };
  }
}

export class FakeCollection extends FakeQuery {
  doc(id?: string) {
    return new FakeDocRef(`${this.path}/${id ?? autoId()}`);
  }
  async add(data: Data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export const db = {
  collection: (name: string) => new FakeCollection(name),
  /** Optimistic concurrency like Firestore: writes apply at the end, and the function reruns when a document it read changed meanwhile. */
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const read = new Map<string, number>();
      const writes: (() => void)[] = [];
      const tx = {
        get: async (ref: FakeDocRef) => {
          read.set(ref.path, versions.get(ref.path) ?? 0);
          await Promise.resolve();
          return ref.get();
        },
        update: (ref: FakeDocRef, data: Data) => void writes.push(() => updateDoc(ref.path, data)),
        set: (ref: FakeDocRef, data: Data, opts?: { merge?: boolean }) => void writes.push(() => writeDoc(ref.path, data, opts?.merge)),
        delete: (ref: FakeDocRef) => void writes.push(() => (bump(ref.path), store.delete(ref.path))),
      };
      const result = await fn(tx);
      const stale = [...read].some(([p, v]) => (versions.get(p) ?? 0) !== v);
      if (stale && attempt < 5) continue;
      writes.forEach((w) => w());
      return result;
    }
  },
  batch() {
    const ops: (() => void)[] = [];
    return {
      set: (ref: FakeDocRef, data: Data, opts?: { merge?: boolean }) => ops.push(() => writeDoc(ref.path, data, opts?.merge)),
      update: (ref: FakeDocRef, data: Data) => ops.push(() => updateDoc(ref.path, data)),
      delete: (ref: FakeDocRef) => ops.push(() => store.delete(ref.path)),
      commit: async () => ops.forEach((op) => op()),
    };
  },
  async getAll(...refs: FakeDocRef[]) {
    return Promise.all(refs.map((r) => r.get()));
  },
  settings: () => undefined,
  recursiveDelete: async () => undefined,
};

export const bucket = {
  name: 'test-bucket',
  file: (_p: string) => ({ download: async () => [Buffer.from('')], save: async () => undefined, delete: async () => undefined, exists: async () => [true] }),
  upload: async () => undefined,
};

export const col = {
  users: () => db.collection('users'),
  projects: () => db.collection('projects'),
  jobs: () => db.collection('jobs'),
  batches: () => db.collection('batches'),
  assets: () => db.collection('assets'),
  chains: () => db.collection('chains'),
  renders: () => db.collection('renders'),
  timelines: (projectId: string) => db.collection('projects').doc(projectId).collection('timelines'),
  usage: () => db.collection('usage'),
  usageDaily: () => db.collection('usageDaily'),
  usageMonthly: () => db.collection('usageMonthly'),
  interactions: () => db.collection('interactions'),
  aiRuns: () => db.collection('aiRuns'),
  runtime: () => db.collection('runtime'),
  productions: () => db.collection('productions'),
  songs: (projectId: string) => db.collection('projects').doc(projectId).collection('songs'),
  scores: (projectId: string) => db.collection('projects').doc(projectId).collection('scores'),
  sub: (projectId: string, name: string) => db.collection('projects').doc(projectId).collection(name),
};

export const gsUri = (p: string) => `gs://test-bucket/${p}`;
export function pathFromGsUri(uri: string): string | null {
  return uri.startsWith('gs://test-bucket/') ? uri.slice('gs://test-bucket/'.length) : null;
}

/** Cloud Tasks deliveries recorded in order (delays are recorded, not waited for). */
export const tasks: { payload: { jobId?: string; productionId?: string; step: string; seq: number }; delaySec: number }[] = [];

export function resetFakes(): void {
  store.clear();
  versions.clear();
  tasks.length = 0;
  idCounter = 0;
  clock = 1_800_000_000_000;
}

export const doc = (path: string) => store.get(path) as Record<string, any> | undefined;
export const docs = <T extends Record<string, any> = Record<string, any>>(collection: string): (T & { id: string })[] =>
  [...store.entries()]
    .filter(([p]) => p.startsWith(`${collection}/`) && p.split('/').length === collection.split('/').length + 1)
    .map(([p, d]) => ({ id: p.split('/').pop()!, ...(d as any) })) as (T & { id: string })[];

/** An error shaped like the Gen AI SDK's (HTTP status, Google's error body, optional Retry-After). */
export function apiError(status: number, body: { code?: number | string; status?: string; message: string; details?: unknown[] }, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`${status} ${body.message}`), { status, error: { error: body }, headers: new Headers(headers) });
}
