import { useEffect, useState } from "preact/hooks";
import type { ReactNode } from "preact/compat";
import { type Settings, DEFAULT_SETTINGS } from "../settings";
import type { BlockEntry } from "../blocklist";
import { fetchLlmHealth, type LlmHealthResponse } from "../api";
import { NumberInput, Input } from "./ui";
import { PlayerPanel } from "./PlayerPanel";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
        checked ? "bg-emerald-500/70" : "bg-white/10"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-gray-200">{label}</div>
        {description && <div className="text-xs text-gray-500 mt-0.5">{description}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsModal({
  settings,
  onChange,
  onClose,
  blocklist,
  onRemoveBlock,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  blocklist: Record<number, BlockEntry>;
  onRemoveBlock: (itemId: number) => void;
}) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [llmTest, setLlmTest] = useState<
    { status: "idle" } | { status: "loading" } | { status: "done"; result: LlmHealthResponse }
  >({ status: "idle" });

  async function testLlm() {
    setLlmTest({ status: "loading" });
    try {
      const result = await fetchLlmHealth();
      setLlmTest({ status: "done", result });
    } catch (err) {
      setLlmTest({
        status: "done",
        result: {
          ok: false,
          baseURL: "",
          model: "",
          latencyMs: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...settings, [key]: value });
  }

  async function requestPermission() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl w-full max-w-md p-6 max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">
            ✕
          </button>
        </div>

        <div className="mb-5">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            Notifications
          </div>
          <Row
            label="Browser notifications"
            description={
              permission === "unsupported"
                ? "Not supported in this browser"
                : permission === "granted"
                  ? "Enabled"
                  : permission === "denied"
                    ? "Blocked — enable in your browser's site settings"
                    : "Not enabled yet"
            }
          >
            {permission === "default" && (
              <button
                onClick={requestPermission}
                className="px-2.5 py-1 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-white transition-colors shrink-0"
              >
                Enable
              </button>
            )}
          </Row>
          <Row
            label="Market alerts (crash/spike)"
            description="Catalogue-wide price move alerts, §11.3 item 5"
          >
            <Toggle
              checked={!settings.muteMarketAlerts}
              onChange={(v) => set("muteMarketAlerts", !v)}
            />
          </Row>
          <Row label="Watchlist alerts" description="Your pinned items' price thresholds">
            <Toggle
              checked={!settings.muteWatchlistAlerts}
              onChange={(v) => set("muteWatchlistAlerts", !v)}
            />
          </Row>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">General</div>
          <Row
            label="Auto-refresh interval"
            description="How often the app polls the local backend"
          >
            <select
              value={settings.refreshIntervalSec}
              onChange={(e) => set("refreshIntervalSec", Number(e.currentTarget.value))}
              className="glass rounded-lg px-2 py-1 text-sm text-gray-100 outline-none"
            >
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
              <option value={120}>2m</option>
            </select>
          </Row>
          <Row
            label="Default min liquidity/hr"
            description="Market tab's starting filter on next load"
          >
            <NumberInput
              value={settings.defaultMinLiquidity}
              onChange={(v) => set("defaultMinLiquidity", v)}
              className="w-20"
            />
          </Row>
        </div>

        <div className="mt-5">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            Player (Wise Old Man)
          </div>
          <Row label="OSRS username" description="Used by the upcoming session planner (§14.13)">
            <Input
              type="text"
              value={settings.womUsername}
              onInput={(e) => set("womUsername", (e.target as HTMLInputElement).value)}
              placeholder="e.g. Zezima"
              className="w-40"
            />
          </Row>
          <PlayerPanel username={settings.womUsername} />
        </div>

        <div className="mt-5">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">LLM / AI</div>
          <Row
            label="Test connection"
            description="Pings the configured provider (llm.ts) with a one-word prompt"
          >
            <button
              onClick={testLlm}
              disabled={llmTest.status === "loading"}
              className="px-2.5 py-1 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-white transition-colors shrink-0 disabled:opacity-50"
            >
              {llmTest.status === "loading" ? "Testing…" : "Test LLM"}
            </button>
          </Row>
          {llmTest.status === "done" && (
            <div
              className={`text-xs rounded-lg px-3 py-2 mt-1 ${
                llmTest.result.ok
                  ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                  : "bg-rose-500/10 text-rose-300 border border-rose-500/20"
              }`}
            >
              {llmTest.result.ok ? (
                <>
                  <div>
                    ✓ {llmTest.result.model} responded in {llmTest.result.latencyMs}ms
                  </div>
                  <div className="text-gray-400 mt-0.5">
                    {llmTest.result.baseURL} — reply: "{llmTest.result.reply}"
                  </div>
                </>
              ) : (
                <>
                  <div>✗ Failed{llmTest.result.model ? ` (${llmTest.result.model})` : ""}</div>
                  <div className="text-gray-400 mt-0.5">{llmTest.result.error}</div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
            Blocklist ({Object.keys(blocklist).length})
          </div>
          {Object.keys(blocklist).length === 0 ? (
            <p className="text-xs text-gray-500 py-2">
              No blocked items. Use the block button next to any item to keep it out of Buy Signals
              and the Capital Allocator for good.
            </p>
          ) : (
            <div className="max-h-40 overflow-auto flex flex-col gap-1 py-1">
              {Object.values(blocklist).map((b) => (
                <div
                  key={b.itemId}
                  className="flex items-center justify-between gap-2 text-sm py-1"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {b.icon && (
                      <img
                        src={iconUrl(b.icon)}
                        alt=""
                        className="w-4 h-4 object-contain shrink-0"
                      />
                    )}
                    <span className="text-gray-300 truncate">{b.name}</span>
                  </div>
                  <button
                    onClick={() => onRemoveBlock(b.itemId)}
                    className="text-xs text-gray-500 hover:text-emerald-400 shrink-0"
                  >
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 pt-3 border-t border-white/5">
          <button
            onClick={() => onChange(DEFAULT_SETTINGS)}
            className="text-xs text-gray-500 hover:text-rose-400"
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
