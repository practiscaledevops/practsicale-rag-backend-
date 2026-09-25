"use client";

// Last-resort boundary (root layout failures). Must render its own <html>/<body>
// because the root layout is what failed, and globals.css may not be loaded —
// so inline styles only, in the chatbot's LIGHT palette. This is the one file
// allowed hex colours.
const PALETTE = {
  background: "#FFFFFF",
  text: "#111315",
  muted: "#6E7375",
  border: "#EAECEC",
  button: "#0A7C6A",
  buttonText: "#FFFFFF",
} as const;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: PALETTE.background, color: PALETTE.text, fontFamily: "system-ui, sans-serif" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 380,
              boxSizing: "border-box",
              padding: 20,
              textAlign: "center",
              background: PALETTE.background,
              border: `1px solid ${PALETTE.border}`,
              borderRadius: 16,
            }}
          >
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
              The Brain dashboard failed to load
            </h1>
            <p style={{ color: PALETTE.muted, fontSize: 13, lineHeight: 1.5, margin: "8px 0 0" }}>
              Something went wrong before the page could render.
            </p>
            {error.digest ? (
              <p style={{ color: PALETTE.muted, fontSize: 11, margin: "4px 0 0" }}>Reference: {error.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 16,
                height: 36,
                padding: "0 16px",
                background: PALETTE.button,
                color: PALETTE.buttonText,
                border: 0,
                borderRadius: 9999,
                fontSize: 14,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
