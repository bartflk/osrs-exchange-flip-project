import { useEffect, useRef, useState } from "react";
import { lookupItems, type MarketItem } from "../api";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function GlobalSearch({ onSelect }: { onSelect: (item: MarketItem) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketItem[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      lookupItems(query)
        .then((res) => setResults(res.items))
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        placeholder="Look up any item…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="glass rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 outline-none focus:border-white/20 w-56"
      />
      {open && results.length > 0 && (
        <div className="absolute right-0 mt-1 w-80 glass rounded-lg overflow-hidden shadow-xl z-30 max-h-96 overflow-y-auto">
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelect(item);
                setOpen(false);
                setQuery("");
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 text-sm"
            >
              {item.icon && <img src={iconUrl(item.icon)} alt="" className="w-5 h-5 object-contain shrink-0" />}
              <span className="text-gray-100 truncate flex-1">{item.name}</span>
              <span className="text-gray-500 font-mono text-xs">
                {item.high != null ? item.high.toLocaleString() : "no price"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
