// Theme constants shared by the server (root layout's inline init script) and
// the browser (lib/theme). Dependency-free: lib/theme imports React hooks, so
// server components must import from here instead.

export const THEME_KEY = "practiscale:theme";

/** Browser-chrome colours per theme (PWA title bar / mobile status bar) = the rail colour. */
export const CHROME_COLOR = { light: "#161616", dark: "#141413" } as const;

/**
 * Runs in <head> before first paint: applies the saved theme ("light" default,
 * "dark", or "system") so the page never flashes the wrong one.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light";var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",d?"${CHROME_COLOR.dark}":"${CHROME_COLOR.light}");}catch(_){}})();`;
