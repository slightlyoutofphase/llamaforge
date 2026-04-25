/**
 * @packageDocumentation
 * Provides the interactive debug and server log console.
 */

import { X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

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

  const deferredLogs = useDeferredValue(logs);
  const deferredSearch = useDeferredValue(search);

  const promptCacheStats = useAppStore((state) => state.promptCacheStats);
  const genStats = useAppStore((state) => state.generationStats);

  if (!isConsoleVisible) return null;

  const filteredLogs = deferredLogs.filter((log) => {
    const text = typeof log === "string" ? log : JSON.stringify(log);

    if (filter !== "ALL") {
      if (!text.toLowerCase().includes(`[${filter.toLowerCase()}]`)) return false;
    }

    if (deferredSearch && !text.toLowerCase().includes(deferredSearch.toLowerCase())) {
      return false;
    }
    return true;
  });

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
            <div title="Total tokens evaluated across session">
              EV:{" "}
              <span className="text-[var(--color-text-primary)]">
                {promptCacheStats.totalEvaluated}
              </span>
            </div>
            <div title="Total tokens retrieved from cache across session">
              CH:{" "}
              <span className="text-[var(--color-success)]">{promptCacheStats.totalCached}</span>
            </div>
            {genStats && (
              <div className="bg-[var(--color-surface-elevated)] px-1 rounded text-[var(--color-accent)]">
                Last: {genStats.tokensCached}/{genStats.tokensEvaluated || "?"} cached
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

      <div className="flex-1 overflow-y-auto font-mono text-[11px] p-2 space-y-1 text-[var(--color-text-secondary)]">
        {filteredLogs.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] italic mt-4">
            No logs match criteria
          </div>
        ) : (
          filteredLogs.map((log, i) => {
            const logContent = typeof log === "string" ? log : JSON.stringify(log);
            return (
              <div
                key={`${i}-${logContent.slice(0, 50)}`}
                className="whitespace-pre-wrap break-all hover:bg-[var(--color-surface)] px-1 -mx-1 rounded">
                {logContent}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
