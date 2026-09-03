/**
 * @packageDocumentation
 * Provides the interactive debug and server log console.
 */

import { X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

const LOG_ROW_HEIGHT = 20;
const LOG_OVERSCAN_ROWS = 12;

/**
 * A slide-over panel displaying real-time server logs and generation stats.
 *
 * @returns The rendered React element, or null if not visible.
 */
export function ConsoleLog() {
  const { isConsoleVisible, toggleConsole } = useUiStore();
  const logs = useAppStore((state) => state.logs);
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const deferredLogs = useDeferredValue(logs);
  const deferredSearch = useDeferredValue(search);

  const promptCacheStats = useAppStore((state) => state.promptCacheStats);
  const genStats = useAppStore((state) => state.generationStats);

  const filteredLogs = useMemo(() => {
    const needle = deferredSearch.toLowerCase();
    const levelNeedle = `[${filter.toLowerCase()}]`;
    return deferredLogs.filter((log) => {
      const text = typeof log === "string" ? log : JSON.stringify(log);
      const lower = text.toLowerCase();
      if (filter !== "ALL" && !lower.includes(levelNeedle)) return false;
      if (needle && !lower.includes(needle)) return false;
      return true;
    });
  }, [deferredLogs, deferredSearch, filter]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    /**
     * Measures the current log viewport height for virtualized row calculations.
     *
     * @returns No return value.
     */
    const updateViewportHeight = () => {
      setViewportHeight(viewport.clientHeight);
    };

    updateViewportHeight();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      updateViewportHeight();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const effectiveViewportHeight = viewportHeight || 320;
  const startIndex = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - LOG_OVERSCAN_ROWS);
  const visibleRowCount =
    Math.ceil(effectiveViewportHeight / LOG_ROW_HEIGHT) + LOG_OVERSCAN_ROWS * 2;
  const endIndex = Math.min(filteredLogs.length, startIndex + visibleRowCount);
  const visibleLogs = filteredLogs.slice(startIndex, endIndex);

  if (!isConsoleVisible) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 h-80 bg-[var(--color-bg)] border-t border-[var(--color-border)] shadow-[0_-10px_30px_rgba(0,0,0,0.5)] flex flex-col z-50">
      <div className="flex items-center justify-between p-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center space-x-4">
          <h3 className="font-semibold text-sm">System Stream</h3>
          <label htmlFor="logFilter" className="sr-only">
            Filter Logs
          </label>
          <select
            id="logFilter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded text-xs px-2 py-1 outline-none text-[var(--color-text-primary)]">
            <option value="ALL">All</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="DEBUG">DEBUG</option>
            <option value="SERVER">SERVER</option>
          </select>
          <label htmlFor="logSearch" className="sr-only">
            Search Logs
          </label>
          <input
            id="logSearch"
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded text-xs px-2 py-1 outline-none text-[var(--color-text-primary)] w-48"
          />
        </div>

        {promptCacheStats && (
          <div className="flex items-center space-x-4 text-[10px] font-mono text-[var(--color-text-secondary)] border-l border-[var(--color-border)] pl-4 h-5">
            <div title="Total prompt tokens processed across this session">
              Prompt tokens processed:{" "}
              <span className="text-[var(--color-text-primary)]">
                {promptCacheStats.totalEvaluated}
              </span>
            </div>
            <div title="Total prompt tokens reused from cache across this session">
              Prompt tokens reused from cache:{" "}
              <span className="text-[var(--color-success)]">{promptCacheStats.totalCached}</span>
            </div>
            {genStats && (
              <div className="bg-[var(--color-surface-elevated)] px-1 rounded text-[var(--color-accent)]">
                Last request cache reuse: {genStats.tokensCached}/{genStats.tokensEvaluated || "?"}{" "}
                prompt tokens
              </div>
            )}
          </div>
        )}

        <div className="flex items-center space-x-2">
          <button
            type="button"
            className="text-xs text-[var(--color-text-muted)] hover:text-white transition-colors px-2 py-1"
            onClick={() => useAppStore.setState({ logs: [] })}>
            Clear
          </button>
          <button
            type="button"
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded transition-colors text-[var(--color-text-muted)] hover:text-white"
            onClick={toggleConsole}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto font-mono text-[11px] p-2 text-[var(--color-text-secondary)]">
        {filteredLogs.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] italic mt-4">
            No logs match criteria
          </div>
        ) : (
          <div className="relative" style={{ height: `${filteredLogs.length * LOG_ROW_HEIGHT}px` }}>
            {visibleLogs.map((log, offset) => {
              const rowIndex = startIndex + offset;
              const logContent = typeof log === "string" ? log : JSON.stringify(log);
              return (
                <div
                  key={`${rowIndex}-${logContent.slice(0, 50)}`}
                  data-testid="console-log-row"
                  title={logContent}
                  className="absolute left-0 right-0 h-5 px-1 -mx-1 rounded hover:bg-[var(--color-surface)] overflow-hidden text-ellipsis whitespace-nowrap"
                  style={{ top: `${rowIndex * LOG_ROW_HEIGHT}px` }}>
                  {logContent}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
