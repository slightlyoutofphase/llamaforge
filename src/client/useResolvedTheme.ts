/**
 * @packageDocumentation
 * Resolves the active light or dark appearance from settings and the OS.
 */

import { useEffect, useState } from "react";
import { useSettings } from "./queries";

/**
 * Resolves `dark`, `light`, or `system` into the appearance theme-sensitive
 * widgets should use right now.
 *
 * Explicit settings win. `system` follows `prefers-color-scheme` and updates
 * when the OS appearance changes. When the media query is unavailable the
 * result is dark, matching the default CSS palette.
 *
 * @returns `"dark"` or `"light"`.
 */
export function useResolvedTheme(): "dark" | "light" {
  const { data: settings } = useSettings();
  const preference = settings?.theme ?? "system";
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    if (preference !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /**
     * Copies the current OS appearance into component state.
     *
     * @returns No return value.
     */
    const apply = () => setSystemDark(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemDark ? "dark" : "light";
}
