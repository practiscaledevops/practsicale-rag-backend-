"use client";

import { useEffect } from "react";
import { applyTheme, readTheme, THEME_EVENT } from "@/lib/theme";
import { THEME_KEY } from "@/lib/theme-shared";

/**
 * Keeps the page's theme in step with the saved preference after first paint
 * (the inline init script handles first paint): re-applies it when the OS
 * switches light/dark under "System", and when another tab changes it.
 */
export function ThemeSync() {
  useEffect(() => {
    applyTheme(readTheme());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onOs = () => {
      if (readTheme() === "system") applyTheme("system");
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) {
        const pref = readTheme();
        applyTheme(pref);
        window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: pref }));
      }
    };
    mq?.addEventListener("change", onOs);
    window.addEventListener("storage", onStorage);
    return () => {
      mq?.removeEventListener("change", onOs);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}
