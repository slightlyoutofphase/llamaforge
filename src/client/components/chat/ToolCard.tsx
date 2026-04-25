/**
 * @packageDocumentation
 * Provides the component to render tool call requests from the assistant and capture user approval.
 */

import { Check, ChevronDown, ChevronUp, Edit, Play, Terminal, X } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../store";

/**
 * Properties for the ToolCard component.
 */
interface ToolCardProps {
  /** The tool call object received from the model. */
  toolCall: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  };
  /** Callback to approve the execution of the tool call. */
  onApprove: (id: string, args?: string) => void;
  /** Callback to reject the execution of the tool call. */
  onReject: (id: string) => void;
}

/**
 * Renders a tool call card, allowing users to modify parameters and approve or cancel execution.
 *
 * @param props - The component properties: {@link ToolCardProps}.
 * @returns The rendered React element.
 */
export function ToolCard({ toolCall, onApprove, onReject }: ToolCardProps) {
  const resultMsg = useAppStore((state) =>
    state.messages.find((m) => m.role === "tool" && m.toolCallId === toolCall.id),
  );

  const isExecuted = !!resultMsg;
  const toolResult = resultMsg?.content;

  const [isEditing, setIsEditing] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [args, setArgs] = useState(toolCall.function.arguments);

  return (
    <div className="mt-4 border border-[var(--color-border)] rounded-2xl bg-[var(--color-surface-elevated)] overflow-hidden shadow-sm animate-in zoom-in-95 duration-200">
      <div className="flex items-center justify-between px-4 py-3 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded-lg">
            <Terminal size={14} />
          </div>
          <span className="text-sm font-bold font-mono">{toolCall.function.name}()</span>
        </div>
        {!isExecuted && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-yellow-500 uppercase tracking-widest bg-yellow-500/10 px-2 py-0.5 rounded-full border border-yellow-500/20">
              Awaiting Action
            </span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-widest">
              Parameters (JSON)
            </h4>
            {!isExecuted && !isEditing && (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-[10px] text-[var(--color-accent)] hover:underline flex items-center gap-1">
                <Edit size={10} /> EDIT
              </button>
            )}
          </div>

          {isEditing ? (
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-accent)] rounded-xl p-3 font-mono text-xs min-h-[100px] outline-none shadow-inner"
            />
          ) : (
            <pre className="bg-[var(--color-bg)] p-3 rounded-xl font-mono text-xs overflow-x-auto border border-[var(--color-border)] text-[var(--color-text-secondary)]">
              {args}
            </pre>
          )}
        </div>

        {!isExecuted && (
          <div className="flex gap-2">
            {isEditing ? (
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="flex-1 py-2 text-xs font-bold border border-[var(--color-border)] rounded-xl hover:bg-[var(--color-bg)] transition-colors">
                Cancel Edit
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReject(toolCall.id)}
                className="flex-1 py-2 text-xs font-bold border border-red-500/30 text-red-500 rounded-xl hover:bg-red-500/5 transition-colors flex items-center justify-center gap-2">
                <X size={14} /> REJECT
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setIsEditing(false);
                onApprove(toolCall.id, args);
              }}
              className="flex-1 py-2 bg-[var(--color-accent)] text-white rounded-xl shadow-lg shadow-[var(--color-accent)]/20 hover:shadow-[var(--color-accent)]/30 transition-all font-bold text-xs flex items-center justify-center gap-2">
              <Play size={14} /> {isEditing ? "SAVE & EXECUTE" : "APPROVE"}
            </button>
          </div>
        )}

        {isExecuted && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-[var(--color-success)] font-medium">
                <Check size={14} /> Execution authorized
              </div>
              {toolResult && (
                <button
                  type="button"
                  onClick={() => setShowResult(!showResult)}
                  className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] flex items-center gap-1 transition-colors">
                  {showResult ? (
                    <>
                      <ChevronUp size={12} /> Hide Result
                    </>
                  ) : (
                    <>
                      <ChevronDown size={12} /> View Result
                    </>
                  )}
                </button>
              )}
            </div>
            {showResult && toolResult && (
              <div className="mt-2 text-xs font-mono bg-black/20 p-3 rounded-xl border border-[var(--color-border)] max-h-64 overflow-y-auto w-full break-all whitespace-pre-wrap text-[var(--color-text-secondary)]">
                {toolResult}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
