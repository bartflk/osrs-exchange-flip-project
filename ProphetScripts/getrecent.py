#!/usr/bin/env python3
# Python 3.10+
"""
extract_tooltip_values_final.py

1) Try to extract chart data directly from Chart.js.
2) If that fails, move the mouse (CDP) across the canvas and read tooltip HTML via JS.
Writes CSV incrementally. Timestamp column is formatted as "YYYY-MM-DD HH:MM:SS" (UTC).
Rows that contain no instabuy and no instasell values are skipped.
"""
from __future__ import annotations
import csv
import os
import re
import time
from datetime import datetime, timezone
from typing import List, Dict, Optional

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# --- CONFIG ---
ITEM_ID = 562
PAGE_URL = f"https://prices.runescape.wiki/osrs/item/{ITEM_ID}"
DATA_DIR = "data"  # folder to save CSV into
os.makedirs(DATA_DIR, exist_ok=True)
OUTPUT_CSV = os.path.join(DATA_DIR, f"item_{ITEM_ID}_last_24_hours.csv")
SAMPLES = 360            # number of hover positions across the chart (fallback)
QUICK_SAMPLES = 0        # set >0 to test quickly (set to 0 to use SAMPLES)
CANVAS_WAIT = 12.0       # seconds to wait for chart to render
HOVER_WAIT = 0.12        # seconds to wait after each hover (increase if tooltips are slow)
HEADLESS = True          # set False to watch the browser
USE_CDP_MOUSE = True     # recommended True for headless
TOOLTIP_JS_RETRIES = 6   # how many times to poll for tooltip HTML after moving
TOOLTIP_JS_DELAY = 0.04  # delay between tooltip polls (seconds)
# If True, skip writing rows that have neither instabuy nor instasell
SKIP_EMPTY_ROWS = True
SEEN_TIMESTAMPS = set()
# --- END CONFIG ---


def start_driver(headless: bool = True):
    opts = Options()
    if headless:
        try:
            opts.add_argument("--headless=new")
        except Exception:
            opts.add_argument("--headless")
    opts.add_argument("--window-size=1400,1000")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=opts)


def find_canvas(driver, timeout: float = CANVAS_WAIT):
    end = time.time() + timeout
    while time.time() < end:
        canvases = driver.find_elements(By.TAG_NAME, "canvas")
        for c in canvases:
            try:
                size = c.size
                if size.get("width", 0) > 10 and size.get("height", 0) > 10:
                    return c
            except Exception:
                continue
        time.sleep(0.2)
    return None


def csv_appender_factory(filename: str):
    # NOTE: timestamp column is "timestamp" formatted as "YYYY-MM-DD HH:MM:SS" (UTC)
    fieldnames = ["timestamp", "timestamp_unix_ms", "instabuy", "instasell", "instabuy_volume", "instasell_volume"]
    exists = os.path.exists(filename)
    f = open(filename, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    if not exists or os.path.getsize(filename) == 0:
        writer.writeheader()
        f.flush()
        try:
            os.fsync(f.fileno())
        except Exception:
            pass

    def _row_has_data(row: Dict) -> bool:
        # consider a row "empty" if both instabuy and instasell are None/empty
        ib = row.get("instabuy")
        isell = row.get("instasell")
        if ib is None and isell is None:
            return False
        # also treat empty strings as missing
        if (str(ib).strip() == "" or str(ib).lower() == "none") and (str(isell).strip() == "" or str(isell).lower() == "none"):
            return False
        return True

    def append_row(row: Dict) -> bool:
        """
        Append a row to CSV.
        Returns True if written, False if skipped (because SKIP_EMPTY_ROWS and no data).
        """
        if SKIP_EMPTY_ROWS and not _row_has_data(row):
            # skip writing rows that have no instabuy and no instasell
            print("Skipping empty row (no instabuy/instasell).")
            return False
        ts_ms = row.get("timestamp_unix_ms") or int(datetime.now(timezone.utc).timestamp() * 1000)
        
        # Deduplicate timestamps
        if ts_ms in SEEN_TIMESTAMPS:
            print(f"Skipping duplicate timestamp {ts_ms}")
            return False
        SEEN_TIMESTAMPS.add(ts_ms)
    
        # format as "YYYY-MM-DD HH:MM:SS" in UTC
        ts_formatted = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")
        out = {
            "timestamp": ts_formatted,
            "timestamp_unix_ms": ts_ms,
            "instabuy": row.get("instabuy"),
            "instasell": row.get("instasell"),
            "instabuy_volume": row.get("instabuy_volume"),
            "instasell_volume": row.get("instasell_volume"),
        }
        writer.writerow(out)
        f.flush()
        try:
            os.fsync(f.fileno())
        except Exception:
            pass
        return True

    def close():
        try:
            f.close()
        except Exception:
            pass

    return append_row, close


# ---------------- parsing helpers ----------------

def parse_tooltip_html_to_values(html: str) -> Optional[Dict]:
    if not html:
        return None
    s = re.sub(r"\s+", " ", html).strip()

    # timestamp like "6-8-2026, 20:55:00"
    ts_match = re.search(r"(\d{1,2}[-/]\d{1,2}[-/]\d{4},\s*\d{1,2}:\d{2}:\d{2})", s)
    ts_ms = None
    if ts_match:
        ts_text = ts_match.group(1)
        for fmt in ("%d-%m-%Y, %H:%M:%S", "%m-%d-%Y, %H:%M:%S", "%d/%m/%Y, %H:%M:%S", "%m/%d/%Y, %H:%M:%S"):
            try:
                dt = datetime.strptime(ts_text, fmt)
                dt = dt.replace(tzinfo=timezone.utc)
                ts_ms = int(dt.timestamp() * 1000)
                break
            except Exception:
                continue

    def parse_int(pattern):
        m = re.search(pattern, s, flags=re.I)
        if not m:
            return None
        for g in m.groups():
            if g:
                try:
                    return int(g.replace(",", ""))
                except Exception:
                    return None
        return None

    def parse_volume_as_int(pattern):
        m = re.search(pattern, s, flags=re.I)
        if not m:
            return None
        txt = None
        for g in m.groups():
            if g:
                txt = g.strip()
                break
        if not txt:
            return None
        txt = txt.replace(",", "")
        suffix = None
        if txt.lower().endswith("k"):
            suffix = "k"
            txt = txt[:-1]
        elif txt.lower().endswith("m"):
            suffix = "m"
            txt = txt[:-1]
        try:
            val = float(txt)
            if suffix == "k":
                val = val * 1000
            elif suffix == "m":
                val = val * 1_000_000
            else:
                # site uses decimals like 138.783 meaning 138.783k -> multiply by 1000
                if "." in txt and val < 1000:
                    val = val * 1000
            return int(round(val))
        except Exception:
            txt2 = txt.replace(".", "")
            return int(txt2) if txt2.isdigit() else None

    instabuy = parse_int(r"Instabuy\s*<b[^>]*>\s*([\d,]+)\s*</b>|Instabuy\s*[:\-]\s*([\d,]+)|Instabuy\s+([\d,]+)")
    instasell = parse_int(r"Instasell\s*<b[^>]*>\s*([\d,]+)\s*</b>|Instasell\s*[:\-]\s*([\d,]+)|Instasell\s+([\d,]+)")
    instabuy_vol = parse_volume_as_int(r"Instabuy vol\s*<b[^>]*>\s*([\d.,kKmM]+)\s*</b>|Instabuy vol\s*[:\-]\s*([\d.,kKmM]+)|Instabuy vol\s+([\d.,kKmM]+)")
    instasell_vol = parse_volume_as_int(r"Instasell vol\s*<b[^>]*>\s*([\d.,kKmM]+)\s*</b>|Instasell vol\s*[:\-]\s*([\d.,kKmM]+)|Instasell vol\s+([\d.,kKmM]+)")

    if any(v is not None for v in (instabuy, instasell, instabuy_vol, instasell_vol, ts_ms)):
        return {
            "timestamp_unix_ms": ts_ms,
            "instabuy": instabuy,
            "instasell": instasell,
            "instabuy_volume": instabuy_vol,
            "instasell_volume": instasell_vol,
        }
    return None


# ---------------- Chart.js extraction ----------------

def extract_chart_data_via_js(driver, canvas) -> Optional[list]:
    snippets = [
        # Chart.js v3+ API
        """
        try {
            const c = arguments[0];
            const chart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(c) : null;
            if (!chart) return null;
            return {labels: chart.data.labels || [], datasets: chart.data.datasets || []};
        } catch (e) { return null; }
        """,
        # fallback: older Chart.instances or window.__chartjs
        """
        try {
            const c = arguments[0];
            if (window.Chart && Chart.instances) {
                for (const k in Chart.instances) {
                    const inst = Chart.instances[k];
                    if (inst && inst.canvas === c) {
                        return {labels: inst.data.labels || [], datasets: inst.data.datasets || []};
                    }
                }
            }
            if (window.__chartjs && Array.isArray(window.__chartjs)) {
                for (const inst of window.__chartjs) {
                    if (inst && inst.canvas === c) {
                        return {labels: inst.data.labels || [], datasets: inst.data.datasets || []};
                    }
                }
            }
            return null;
        } catch (e) { return null; }
        """
    ]

    for js in snippets:
        try:
            res = driver.execute_script(js, canvas)
        except Exception:
            res = None
        if res:
            labels = res.get("labels", []) or []
            datasets = res.get("datasets", []) or []

            def label_to_ms(lbl):
                try:
                    if isinstance(lbl, (int, float)):
                        return int(lbl)
                    s = str(lbl)
                    try:
                        dt = datetime.fromisoformat(s)
                        return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
                    except Exception:
                        pass
                    for fmt in ("%d-%m-%Y, %H:%M:%S", "%m-%d-%Y, %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
                        try:
                            dt = datetime.strptime(s, fmt)
                            dt = dt.replace(tzinfo=timezone.utc)
                            return int(dt.timestamp() * 1000)
                        except Exception:
                            continue
                except Exception:
                    pass
                return None

            rows = []
            label_map = {}
            for idx, ds in enumerate(datasets):
                ds_label = ""
                if isinstance(ds, dict):
                    ds_label = (ds.get("label") or "").lower()
                if "instabuy" in ds_label:
                    label_map["instabuy"] = idx
                elif "instasell" in ds_label:
                    label_map["instasell"] = idx
                if "vol" in ds_label and "buy" in ds_label:
                    label_map["instabuy_volume"] = idx
                if "vol" in ds_label and "sell" in ds_label:
                    label_map["instasell_volume"] = idx

            if "instabuy" not in label_map and len(datasets) >= 1:
                label_map["instabuy"] = 0
            if "instasell" not in label_map and len(datasets) >= 2:
                label_map["instasell"] = 1

            n = max(len(labels), max((len(ds.get("data", [])) for ds in datasets), default=0))
            for i in range(n):
                lbl = labels[i] if i < len(labels) else None
                ts_ms = label_to_ms(lbl) if lbl is not None else None

                def get_ds_value(key):
                    idx = label_map.get(key)
                    if idx is None or idx >= len(datasets):
                        return None
                    ds = datasets[idx]
                    data = ds.get("data", [])
                    if i >= len(data):
                        return None
                    val = data[i]
                    if isinstance(val, dict):
                        return val.get("y") if "y" in val else val.get("value") or None
                    return val

                def norm(v):
                    try:
                        if v is None:
                            return None
                        if isinstance(v, (int, float)):
                            return int(v)
                        s = str(v).replace(",", "")
                        if s.isdigit():
                            return int(s)
                        return int(float(s))
                    except Exception:
                        return None

                rows.append({
                    "timestamp_unix_ms": int(ts_ms) if ts_ms is not None else None,
                    "instabuy": norm(get_ds_value("instabuy")),
                    "instasell": norm(get_ds_value("instasell")),
                    "instabuy_volume": norm(get_ds_value("instabuy_volume")),
                    "instasell_volume": norm(get_ds_value("instasell_volume")),
                })
            return rows
    return None


# ---------------- tooltip HTML via JS ----------------

def _dispatch_cdp_mouse_move(driver, client_x: int, client_y: int) -> bool:
    try:
        params = {
            "type": "mouseMoved",
            "x": float(client_x),
            "y": float(client_y),
            "button": "none",
            "buttons": 0,
            "modifiers": 0,
            "timestamp": time.time()
        }
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", params)
        return True
    except Exception:
        return False


def _get_canvas_client_coords(driver, canvas):
    rect = driver.execute_script(
        "const c = arguments[0]; const r = c.getBoundingClientRect(); return {left: r.left, top: r.top, width: r.width, height: r.height};",
        canvas
    )
    return int(rect["left"]), int(rect["top"]), int(rect["width"]), int(rect["height"])


def get_tooltip_html_via_js(driver) -> Optional[str]:
    """
    Return innerHTML of the floating tooltip div by scanning divs for transform: translate3d(...) and Instabuy/Instasell text.
    """
    js = r"""
    try {
        const divs = Array.from(document.querySelectorAll('div'));
        for (const d of divs) {
            const style = d.getAttribute('style') || '';
            const txt = (d.innerText || '').toLowerCase();
            if (style.includes('translate3d') && (txt.includes('instabuy') || txt.includes('instasell'))) {
                return d.innerHTML;
            }
            // some tooltips may not use translate3d but are absolute positioned with high z-index
            if (style.includes('position: absolute') && (txt.includes('instabuy') || txt.includes('instasell'))) {
                return d.innerHTML;
            }
        }
        // last resort: any div containing the keywords
        for (const d of divs) {
            const txt = (d.innerText || '').toLowerCase();
            if (txt.includes('instabuy') || txt.includes('instasell')) {
                return d.innerHTML;
            }
        }
        return null;
    } catch (e) { return null; }
    """
    try:
        return driver.execute_script(js)
    except Exception:
        return None


# ---------------- hover fallback that uses JS tooltip read ----------------

def hover_and_collect_js_tooltip(driver, canvas, samples: int, append_row) -> List[Dict]:
    left, top, width, height = _get_canvas_client_coords(driver, canvas)
    y_client = int(top + height * 0.5)
    results: List[Dict] = []

    for i in range(samples):
        x_client = int(left + 5 + (width - 10) * (i / max(1, samples - 1)))
        moved = False
        if USE_CDP_MOUSE:
            moved = _dispatch_cdp_mouse_move(driver, x_client, y_client)
        if not moved:
            try:
                ActionChains(driver).move_to_element_with_offset(canvas, x_client - left, y_client - top).perform()
            except Exception:
                try:
                    driver.execute_script(
                        "const c=arguments[0]; const x=arguments[1]; const y=arguments[2];"
                        "c.dispatchEvent(new MouseEvent('mousemove', {clientX:x, clientY:y, bubbles:true}));",
                        canvas, x_client, y_client
                    )
                except Exception:
                    pass

        # poll for tooltip HTML a few times (tooltip may be created asynchronously)
        html = None
        for _ in range(TOOLTIP_JS_RETRIES):
            time.sleep(TOOLTIP_JS_DELAY)
            html = get_tooltip_html_via_js(driver)
            if html:
                break

        parsed = parse_tooltip_html_to_values(html or "")
        if parsed is None:
            approx_ts = int((datetime.now(timezone.utc).timestamp() - (samples - 1 - i) * 60) * 1000)
            parsed = {
                "timestamp_unix_ms": approx_ts,
                "instabuy": None,
                "instasell": None,
                "instabuy_volume": None,
                "instasell_volume": None,
            }
        if parsed["timestamp_unix_ms"] is None:
            parsed["timestamp_unix_ms"] = int((datetime.now(timezone.utc).timestamp() - (samples - 1 - i) * 60) * 1000)

        written = append_row(parsed)
        if written:
            results.append(parsed)
            print(f"[{i+1}/{samples}] wrote timestamp {parsed['timestamp_unix_ms']} instabuy={parsed['instabuy']} instasell={parsed['instasell']}")
        else:
            print(f"[{i+1}/{samples}] skipped timestamp {parsed['timestamp_unix_ms']} (no data)")
        time.sleep(HOVER_WAIT)
    return results


# ---------------- main ----------------

def main():
    samples = QUICK_SAMPLES if QUICK_SAMPLES > 0 else SAMPLES
    driver = start_driver(headless=HEADLESS)
    append_row, close_csv = csv_appender_factory(OUTPUT_CSV)
    try:
        driver.get(PAGE_URL)
        time.sleep(2.0)

        canvas = find_canvas(driver)
        if not canvas:
            time.sleep(4.0)
            canvas = find_canvas(driver)
        if not canvas:
            with open("page_dump.html", "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            raise RuntimeError("Chart canvas not found on page; saved page_dump.html for inspection.")

        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", canvas)
        time.sleep(0.5)

        # 1) Try Chart.js extraction first
        try:
            rows = extract_chart_data_via_js(driver, canvas)
        except Exception:
            rows = None

        if rows:
            # write rows immediately, but skip empty ones if SKIP_EMPTY_ROWS
            written_count = 0
            for r in rows:
                if r["timestamp_unix_ms"] is None:
                    r["timestamp_unix_ms"] = int(datetime.now(timezone.utc).timestamp() * 1000)
                if append_row(r):
                    written_count += 1
            print(f"Extracted {len(rows)} rows from Chart.js and wrote {written_count} rows to CSV: {OUTPUT_CSV}")
            return

        # 2) Fallback: CDP mouse moves + JS tooltip read
        try:
            # small initial move to initialize tooltip system
            left, top, width, height = _get_canvas_client_coords(driver, canvas)
            if USE_CDP_MOUSE:
                _dispatch_cdp_mouse_move(driver, left + 10, top + int(height * 0.5))
            else:
                ActionChains(driver).move_to_element_with_offset(canvas, 10, int(canvas.size["height"] * 0.5)).perform()
            time.sleep(0.2)
        except Exception:
            pass

        hover_and_collect_js_tooltip(driver, canvas, samples, append_row)
        print(f"Completed sampling {samples} points. CSV at: {OUTPUT_CSV}")

    finally:
        close_csv()
        driver.quit()


if __name__ == "__main__":
    main()
