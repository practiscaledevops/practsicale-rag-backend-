"use client";

// Last-resort boundary (root layout failures). Must render its own <html>/<body>
// because the root layout is what failed; inline styles only.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#06100D", color: "#EDF7F2", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>The Brain dashboard failed to load</h1>
            <p style={{ color: "#91AAA0", fontSize: 14, marginTop: 8 }}>
              Something went wrong before the page could render.{error.digest ? ` (ref ${error.digest})` : ""}
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 20,
                background: "#00BFAE",
                color: "#06100D",
                border: 0,
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
