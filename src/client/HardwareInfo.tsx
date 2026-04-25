/**
 * @packageDocumentation
 * Provides an informational component displaying system hardware capabilities.
 */

import { Cpu, MemoryStick, MonitorPlay } from "lucide-react";
import { useAppStore } from "./store";

/**
 * An informational sidebar widget showing CPU threads, System RAM, and GPU/VRAM limits.
 *
 * @returns The rendered React element, or null if hardware information is unavailable.
 */
export function HardwareInfo() {
  const { hardware } = useAppStore();

  if (!hardware) return null;

  const ramGb = (hardware.totalRamBytes / 1024 / 1024 / 1024).toFixed(1);

  return (
    <div className="w-64 border-l border-[var(--color-border)] bg-[var(--color-surface)] p-4 hidden lg:flex flex-col">
      <h3 className="text-xs uppercase font-mono tracking-wider text-[var(--color-text-secondary)] mb-6">
        Hardware Status
      </h3>

      <div className="space-y-6">
        {/* CPU */}
        <div>
          <div className="flex items-center space-x-2 text-[var(--color-text-primary)] mb-2">
            <Cpu size={16} className="text-[var(--color-accent)]" />
            <span className="text-sm font-medium">CPU</span>
          </div>
          <div className="text-xs font-mono text-[var(--color-text-muted)]">
            {hardware.cpuThreads} Threads Available
          </div>
        </div>

        {/* RAM */}
        <div>
          <div className="flex items-center space-x-2 text-[var(--color-text-primary)] mb-2">
            <MemoryStick size={16} className="text-[var(--color-accent)]" />
            <span className="text-sm font-medium">System RAM</span>
          </div>
          <div className="text-xs font-mono text-[var(--color-text-muted)]">{ramGb} GB Total</div>
        </div>

        {/* GPUs */}
        {hardware.gpus.length > 0 && (
          <div>
            <div className="flex items-center space-x-2 text-[var(--color-text-primary)] mb-2">
              <MonitorPlay size={16} className="text-[var(--color-accent)]" />
              <span className="text-sm font-medium">Accelerators</span>
            </div>
            <div className="space-y-2">
              {hardware.gpus.map((gpu) => (
                <div
                  key={gpu.name}
                  className="bg-[var(--color-surface-elevated)] p-2 rounded-md border border-[var(--color-border)]">
                  <div className="text-xs font-medium truncate" title={gpu.name}>
                    {gpu.name}
                  </div>
                  <div className="text-[10px] uppercase font-mono text-[var(--color-text-muted)] mt-1 flex justify-between">
                    <span>{gpu.backend}</span>
                    <span>{(gpu.vramBytes / 1024 / 1024 / 1024).toFixed(1)}GB VRAM</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
