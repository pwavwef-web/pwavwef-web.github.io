import { useEffect, useMemo, useRef, useState } from 'react';
import { doc, onSnapshot, type DocumentData, type Query } from 'firebase/firestore';
import { db } from './firebase';

export type WithId<T> = T & { id: string };

export interface Live<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

/** Live document subscription. `path` null disables it. */
export function useDoc<T>(path: string | null): Live<WithId<T> | null> & { exists: boolean } {
  const [state, setState] = useState<Live<WithId<T> | null> & { exists: boolean }>({ data: null, loading: Boolean(path), error: null, exists: false });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: null, exists: false });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    return onSnapshot(
      doc(db, path),
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...(snap.data() as T) } as WithId<T>) : null, loading: false, error: null, exists: snap.exists() }),
      (error) => setState({ data: null, loading: false, error, exists: false }),
    );
  }, [path]);
  return state;
}

/** Live query subscription. The factory is re-run when `deps` change; return null to disable. */
export function useQuery<T>(factory: () => Query<DocumentData> | null, deps: unknown[]): Live<WithId<T>[]> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const q = useMemo(factory, deps);
  const [state, setState] = useState<Live<WithId<T>[]>>({ data: [], loading: Boolean(q), error: null });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }) as WithId<T>), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error }),
    );
  }, [q]);
  return state;
}

/** Debounces a value (used for autosave). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
