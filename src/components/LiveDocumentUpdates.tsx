"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Refresh the existing server list only when its scoped database revision changes. */
export function LiveDocumentUpdates({ initialVersion }: { initialVersion: string | null }) {
  const router = useRouter();
  const version = useRef(initialVersion);
  const [state, setState] = useState("Connecting to live updates…");
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disposed || controller || document.visibilityState === "hidden") return;
      const own = new AbortController(); controller = own;
      let next = 2000; let blocked = false;
      try {
        const res = await fetch("/api/admin/documents/revision", { cache: "no-store", signal: own.signal });
        if ([401,403].includes(res.status)) { blocked = true; if (!disposed) setState("Live updates unavailable"); return; }
        if (!res.ok) throw Error("unavailable");
        const data = await res.json(); if (typeof data.version !== "string") throw Error("Invalid revision");
        if (disposed || own.signal.aborted) return;
        if (data.version !== version.current) { version.current = data.version; router.refresh(); }
        setState("Live · new calls and document updates appear automatically");
      } catch { next = 5000; if (!disposed && !own.signal.aborted) setState("Live updates reconnecting · showing last loaded data"); }
      finally { if (controller === own) controller = null; if (!disposed && !blocked && !own.signal.aborted) timer = setTimeout(poll, next); }
    };
    const resume = () => { clearTimeout(timer); controller?.abort(); controller = null; if (document.visibilityState !== "hidden") void poll(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [router]);
  return <p role="status" className="mb-3 text-xs text-muted-foreground">{state}</p>;
}
