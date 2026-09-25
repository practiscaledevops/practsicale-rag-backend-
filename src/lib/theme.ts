// Light / dark / system theme. A per-viewer convenience kept in this browser's
// localStorage (every access guarded: storage can be unavailable in private
// windows). The `dark` class on <html> switches the colour tokens in
// globals.css; THEME_INIT_SCRIPT applies the saved choice before first paint so
// the page never flashes the wrong theme.

import { useCallback, useEffect, useState } from "react";
import { CHROME_COLOR, THEME_KEY as KEY } from "@/lib/theme-shared";

export type ThemePref = "light" | "dark" | "system";

export const THEME_EVENT = "theme:changed";

export function readTheme(): ThemePref {
  if (typeof window === "undefined") return "light";
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** Resolve a preference to the theme actually shown. */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "dark" || (pref === "system" && systemDark()) ? "dark" : "light";
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const dark = resolveTheme(pref) === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? CHROME_COLOR.dark : CHROME_COLOR.light);
}

export function setTheme(pref: ThemePref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent<ThemePref>(THEME_EVENT, { detail: pref }));
}

/**
 * The current theme preference + a setter. Follows changes made elsewhere on
 * the page (e.g. the sidebar menu vs Settings) and, for "system", the OS
 * setting as it changes.
 */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>("light");

  useEffect(() => {
    setPref(readTheme());
    const onChange = (e: Event) => setPref((e as CustomEvent<ThemePref>).detail ?? readTheme());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (pref !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onOs = () => applyTheme("system");
    mq.addEventListener("change", onOs);
    return () => mq.removeEventListener("change", onOs);
  }, [pref]);

  const update = useCallback((next: ThemePref) => {
    setPref(next);
    setTheme(next);
  }, []);

  return [pref, update];
}
