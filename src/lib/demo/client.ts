// A minimal fake of the Supabase client, backed by the in-memory demo store.
// It implements exactly the query-builder surface the app uses (from/select/eq/
// in/is/gte/order/limit/insert/update/delete/single/maybeSingle, rpc, auth).
// Returned as `any` so it drops in wherever a SupabaseClient is expected.

import { demoStore, DEMO_USER_ID, DEMO_ORG_ID } from "./fixtures";

type Row = Record<string, any>;
type Filter = { col: string; op: "eq" | "in" | "is" | "gte" | "lte"; val: any };

const genId = () => "demo-" + Math.random().toString(36).slice(2, 10);

class Query implements PromiseLike<{ data: any; error: any; count?: number }> {
  private filters: Filter[] = [];
  private _orders: { col: string; asc: boolean }[] = [];
  private _limit?: number;
  private _op: "select" | "insert" | "update" | "delete" = "select";
  private _payload: any;
  private _count = false;
  private _head = false;

  constructor(private table: string) {}

  private rows(): Row[] {
    const store = demoStore();
    return (store[this.table] ||= []);
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this._count = true;
    if (opts?.head) this._head = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this._op = "insert";
    this._payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(obj: Row) {
    this._op = "update";
    this._payload = obj;
    return this;
  }
  delete() {
    this._op = "delete";
    return this;
  }
  eq(col: string, val: any) { this.filters.push({ col, op: "eq", val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ col, op: "in", val }); return this; }
  is(col: string, val: any) { this.filters.push({ col, op: "is", val }); return this; }
  gte(col: string, val: any) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col: string, val: any) { this.filters.push({ col, op: "lte", val }); return this; }
  match(obj: Row) { for (const k of Object.keys(obj)) this.filters.push({ col: k, op: "eq", val: obj[k] }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this._orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this._limit = n; return this; }

  private matches(r: Row): boolean {
    return this.filters.every((f) => {
      const v = r[f.col];
      switch (f.op) {
        case "eq": return v === f.val;
        case "in": return Array.isArray(f.val) && f.val.includes(v);
        case "is": return v === f.val || (f.val === null && (v === null || v === undefined));
        case "gte": return v >= f.val;
        case "lte": return v <= f.val;
        default: return true;
      }
    });
  }

  private run(): { data: any; error: any; count?: number } {
    const arr = this.rows();

    if (this._op === "insert") {
      const now = new Date().toISOString();
      const inserted = this._payload.map((r: Row) => ({ id: genId(), created_at: now, ...r }));
      arr.push(...inserted);
      return { data: inserted, error: null };
    }
    if (this._op === "update") {
      const updated: Row[] = [];
      for (const r of arr) if (this.matches(r)) { Object.assign(r, this._payload); updated.push(r); }
      return { data: updated, error: null };
    }
    if (this._op === "delete") {
      const kept: Row[] = [], removed: Row[] = [];
      for (const r of arr) (this.matches(r) ? removed : kept).push(r);
      demoStore()[this.table] = kept;
      return { data: removed, error: null };
    }
    // select
    let rows = arr.filter((r) => this.matches(r));
    if (this._orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const { col, asc } of this._orders) {
          if (a[col] === b[col]) continue;
          return (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    const count = rows.length;
    if (this._head) return { data: null, error: null, count };
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return { data: rows, error: null, count: this._count ? count : undefined };
  }

  private firstResult(): { data: any; error: any } {
    const res = this.run();
    if (this._op !== "select") return { data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: null };
    const first = (res.data as Row[])?.[0] ?? null;
    return { data: first, error: null };
  }

  single() { return Promise.resolve(this.firstResult()); }
  maybeSingle() { return Promise.resolve(this.firstResult()); }

  then<R1 = any, R2 = never>(
    onfulfilled?: ((v: { data: any; error: any; count?: number }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

const demoChunks = () =>
  demoStore().chunks.map((c) => ({
    id: c.id, document_id: c.document_id, parent_id: c.parent_id,
    content: c.content, metadata: c.metadata, source_type: c.source_type,
  }));

const fakeAuth = {
  getUser: async () => ({ data: { user: { id: DEMO_USER_ID, email: "demo@practiscale.co" } }, error: null }),
  getSession: async () => ({ data: { session: { user: { id: DEMO_USER_ID } } }, error: null }),
  signInWithPassword: async () => ({ data: { user: { id: DEMO_USER_ID } }, error: null }),
  signOut: async () => ({ error: null }),
  admin: {
    createUser: async ({ email }: { email?: string } = {}) => ({ data: { user: { id: genId(), email } }, error: null }),
    inviteUserByEmail: async (email: string) => ({ data: { user: { id: genId(), email } }, error: null }),
  },
};

export function fakeSupabase(): any {
  return {
    from(table: string) { return new Query(table); },
    async rpc(name: string, _params?: any) {
      if (name === "hybrid_search_scoped" || name === "hybrid_search") {
        return { data: demoChunks(), error: null };
      }
      return { data: [], error: null };
    },
    auth: fakeAuth,
    _demo: { orgId: DEMO_ORG_ID },
  };
}
