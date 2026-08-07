#!/usr/bin/env python3
"""
chaos_rune_562_no_buylimit.py

Fetch Chaos rune (item id 562) data and write two CSVs:
 - chaos_rune_562_1year_daily.csv  -> daily data (last 365 days)
 - chaos_rune_562_lastweek_minute.csv -> minute-level data for last 7 days (resampled if necessary)

Changes vs previous:
 - Removed buy_limit entirely (no column, no dependency).
 - potential_profit is computed as margin * daily_volume (may be negative).
 - ROI, margin, potential_profit, margin_x_volume are allowed to be negative.
 - Preserves all original fields where possible and stores raw JSON per row.
"""

import requests
import pandas as pd
import json
import time
from datetime import datetime, timedelta, timezone
import sys
from typing import Any, Dict, List, Optional

# ---------- CONFIG ----------
ITEM_ID = 562
HEADERS = {"User-Agent": "osrs-datascraper/1.0", "Accept": "application/json"}
TIMESERIES_URL = "https://prices.runescape.wiki/api/v1/osrs/timeseries"
LATEST_URL = "https://prices.runescape.wiki/api/v1/osrs/latest"

OUT_DAILY = "chaos_rune_562_1year_daily.csv"
OUT_MINUTE = "chaos_rune_562_lastweek_minute.csv"

REQUEST_TIMEOUT = 30
RETRIES = 3
BACKOFF = 1.0

# ---------- HTTP helper ----------
def get_with_retries(url: str, params: dict = None) -> requests.Response:
    for attempt in range(1, RETRIES + 1):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=REQUEST_TIMEOUT)
            return r
        except requests.RequestException:
            if attempt == RETRIES:
                raise
            time.sleep(BACKOFF * attempt)

# ---------- payload normalization ----------
def extract_series(payload: Any) -> List[Dict[str, Any]]:
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            if isinstance(data.get("daily"), list):
                return data["daily"]
            if isinstance(data.get("average"), list):
                return data["average"]
            for v in data.values():
                if isinstance(v, list):
                    return v
        for v in payload.values():
            if isinstance(v, list):
                return v
    return []

def flatten_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    flat = {}
    for k, v in rec.items():
        if isinstance(v, dict):
            for nk, nv in v.items():
                flat[f"{k}.{nk}"] = nv
        elif isinstance(v, list):
            try:
                flat[k] = json.dumps(v, ensure_ascii=False)
            except Exception:
                flat[k] = str(v)
        else:
            flat[k] = v
    return flat

def normalize_timestamp(val) -> Optional[pd.Timestamp]:
    if val is None:
        return pd.NaT
    try:
        ival = int(val)
        if ival > 1e12:
            return pd.to_datetime(ival, unit="ms", utc=True)
        else:
            return pd.to_datetime(ival, unit="s", utc=True)
    except Exception:
        try:
            return pd.to_datetime(str(val), utc=True)
        except Exception:
            return pd.NaT

def series_to_dataframe(series: List[Dict[str, Any]], source_label: str) -> pd.DataFrame:
    rows = []
    fetched_at = datetime.now(timezone.utc).isoformat()
    for rec in series:
        flat = flatten_record(rec)
        try:
            flat["_raw_json"] = json.dumps(rec, ensure_ascii=False)
        except Exception:
            flat["_raw_json"] = str(rec)
        ds = pd.NaT
        for key in ("timestamp", "time", "date", "day", "datetime"):
            if key in flat and flat[key] not in (None, ""):
                ds = normalize_timestamp(flat[key])
                if not pd.isna(ds):
                    break
        flat["ds"] = ds
        flat["fetched_at"] = fetched_at
        flat["source"] = source_label
        flat["item_id"] = ITEM_ID
        rows.append(flat)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    if "ds" in df.columns:
        df["ds"] = pd.to_datetime(df["ds"], utc=True)
    return df

# ---------- snapshot extraction (no buy_limit) ----------
def fetch_latest_snapshot(item_id: int) -> Optional[Dict[str, Any]]:
    r = get_with_retries(LATEST_URL, params={"id": item_id})
    payload = None
    try:
        payload = r.json()
    except Exception:
        payload = None
    if not payload:
        return None
    item = payload.get("data", {}).get(str(item_id)) or payload.get("data", {}).get(item_id)
    return item

def extract_snapshot_volume(latest_item):
    """
    Extract only daily_volume_snapshot from the item snapshot.
    """
    if not latest_item:
        return {"daily_volume_snapshot": None}

    vol = (
        latest_item.get("dailyVolume")
        or latest_item.get("daily_volume")
        or latest_item.get("volume")
    )

    try:
        vol = int(vol)
    except Exception:
        vol = None

    return {"daily_volume_snapshot": vol}


# ---------- metrics computation (allow negatives) ----------
def compute_row_metrics(df: pd.DataFrame, snapshot_stats: Dict[str, Any]) -> pd.DataFrame:
    df = df.copy()
    # pick price columns
    def pick_col(df, candidates):
        for c in candidates:
            if c in df.columns:
                return c
        return None

    high_col = pick_col(df, ["avgHighPrice", "avgHigh", "high", "highPrice"])
    low_col = pick_col(df, ["avgLowPrice", "avgLow", "low", "lowPrice"])
    avg_col = pick_col(df, ["avg", "average", "price"])

    # coerce numeric (allow negatives)
    df["avgHighPrice"] = pd.to_numeric(df.get(high_col), errors="coerce")
    df["avgLowPrice"] = pd.to_numeric(df.get(low_col), errors="coerce")
    # volumes
    df["highPriceVolume"] = pd.to_numeric(df.get("highPriceVolume"), errors="coerce").fillna(0)
    df["lowPriceVolume"] = pd.to_numeric(df.get("lowPriceVolume"), errors="coerce").fillna(0)
    # daily_volume: prefer computed sum, else snapshot value if present
    df["daily_volume"] = df["highPriceVolume"] + df["lowPriceVolume"]
    if snapshot_stats.get("daily_volume_snapshot") is not None:
        # only use snapshot value where computed daily_volume is zero or missing
        df["daily_volume"] = df["daily_volume"].where(df["daily_volume"] > 0, snapshot_stats["daily_volume_snapshot"])

    # margin (can be negative)
    df["margin"] = (df["avgHighPrice"] - df["avgLowPrice"]).astype("float64")

    # potential_profit = margin * daily_volume (may be negative)
    df["potential_profit"] = df["margin"] * df["daily_volume"]

    # margin_x_volume = margin * daily_volume (same as potential_profit by this definition)
    df["margin_x_volume"] = df["margin"] * df["daily_volume"]

    # ROI: prefer explicit roi column if present, else compute using reference price (allow negative)
    roi_col = pick_col(df, ["roi", "ROI"])
    if roi_col:
        df["roi"] = pd.to_numeric(df[roi_col].astype(str).str.rstrip("%"), errors="coerce")
    else:
        df["roi"] = pd.NA

        for idx, row in df.iterrows():
            ref = None

            # priority: avgLowPrice → avg → avgHighPrice
            if not pd.isna(row.get("avgLowPrice")):
                ref = row.get("avgLowPrice")
            elif avg_col and not pd.isna(row.get(avg_col)):
                try:
                    ref = float(row.get(avg_col))
                except Exception:
                    ref = None
            elif not pd.isna(row.get("avgHighPrice")):
                ref = row.get("avgHighPrice")

            try:
                if ref is not None and ref != 0 and pd.notna(row.get("margin")):
                    df.at[idx, "roi"] = (row["margin"] / float(ref)) * 100.0
                else:
                    df.at[idx, "roi"] = pd.NA
            except Exception:
                df.at[idx, "roi"] = pd.NA




    # ensure ordering of key columns
    cols_order = [
        "ds", "timestamp", "avgHighPrice", "avgLowPrice",
        "highPriceVolume", "lowPriceVolume", "daily_volume",
        "roi", "margin", "potential_profit", "margin_x_volume",
        "low_alch", "high_alch",
        "fetched_at", "source", "item_id", "_raw_json"
    ]
    existing = [c for c in cols_order if c in df.columns]
    extras = [c for c in df.columns if c not in existing]
    df = df[existing + extras]
    return df

# ---------- fetch helpers ----------
def fetch_timeseries(item_id: int, timestep: Optional[str] = None) -> (List[Dict[str, Any]], Any):
    params = {"id": item_id}
    if timestep:
        params["timestep"] = timestep
    r = get_with_retries(TIMESERIES_URL, params=params)
    payload = None
    try:
        payload = r.json()
    except Exception:
        payload = None
    series = extract_series(payload)
    return series, payload

# ---------- build datasets ----------
def build_daily_1year(snapshot_stats: Dict[str, Any]) -> pd.DataFrame:
    series, payload = [], None
    try:
        series, payload = fetch_timeseries(ITEM_ID, timestep="24h")
        if not series:
            series, payload = fetch_timeseries(ITEM_ID, timestep=None)
    except Exception as e:
        print("Daily timeseries fetch failed:", e, file=sys.stderr)
        series = []

    if not series:
        return pd.DataFrame()

    df = series_to_dataframe(series, source_label="timeseries_24h")
    if df.empty:
        return pd.DataFrame()

    df = compute_row_metrics(df, snapshot_stats)
    now = pd.Timestamp.now(tz="UTC")
    cutoff = now - pd.Timedelta(days=365)
    if "ds" in df.columns:
        df = df[df["ds"] >= cutoff].copy()
    df = df.sort_values("ds").reset_index(drop=True)
    return df

def build_minute_lastweek(snapshot_stats: Dict[str, Any]) -> pd.DataFrame:
    timesteps = ["1m", "1h", "6h", "24h", None]
    best_df = pd.DataFrame()
    best_timestep = None
    for ts in timesteps:
        try:
            series, payload = fetch_timeseries(ITEM_ID, timestep=ts)
            if not series:
                continue
            df = series_to_dataframe(series, source_label=f"timeseries_{ts or 'none'}")
            if df.empty or "ds" not in df.columns or df["ds"].isna().all():
                continue
            best_df = df
            best_timestep = ts
            break
        except Exception:
            continue

    if best_df.empty:
        try:
            latest_item = fetch_latest_snapshot(ITEM_ID)
            if latest_item:
                best_df = series_to_dataframe([latest_item], source_label="latest")
                best_timestep = "snapshot"
        except Exception:
            pass

    if best_df.empty:
        return pd.DataFrame()

    best_df = compute_row_metrics(best_df, snapshot_stats)

    df = best_df.copy().dropna(subset=["ds"]).set_index("ds").sort_index()
    now = pd.Timestamp.now(tz="UTC")
    start = now - pd.Timedelta(days=7)
    df_window = df[df.index >= start]
    if df_window.empty:
        earliest = df.index.min()
        if pd.isna(earliest):
            return pd.DataFrame()
        window_start = max(earliest, start)
        df_window = df[df.index >= window_start]

    try:
        numeric_cols = df_window.select_dtypes(include=["number"]).columns.tolist()
        other_cols = [c for c in df_window.columns if c not in numeric_cols]
        idx = pd.date_range(start=df_window.index.min().floor("T"), end=now.ceil("T"), freq="T", tz="UTC")
        df_resampled = pd.DataFrame(index=idx)
        if numeric_cols:
            df_resampled = df_resampled.join(df_window[numeric_cols], how="left")
            df_resampled[numeric_cols] = df_resampled[numeric_cols].ffill()
        for col in other_cols:
            df_resampled[col] = df_window[col].reindex(df_resampled.index).ffill()
        df_resampled["fetched_at"] = datetime.now(timezone.utc).isoformat()
        df_resampled["source"] = f"timeseries_{best_timestep}"
        df_resampled["item_id"] = ITEM_ID
        df_resampled = df_resampled.reset_index().rename(columns={"index": "ds"})
        df_resampled = df_resampled[df_resampled["ds"] >= start].reset_index(drop=True)
        df_resampled = compute_row_metrics(df_resampled, snapshot_stats)
        return df_resampled
    except Exception as e:
        print("Resample to minute failed:", e, file=sys.stderr)
        df_coarse = df.reset_index()
        df_coarse = df_coarse[df_coarse["ds"] >= start].reset_index(drop=True)
        return df_coarse

# ---------- run ----------
def main():
    print("Fetching latest snapshot for alch/volume metadata (no buy_limit)...")
    latest_item = None
    try:
        latest_item = fetch_latest_snapshot(ITEM_ID)
    except Exception as e:
        print("Failed to fetch latest snapshot:", e, file=sys.stderr)
        latest_item = None

    snapshot_stats = extract_snapshot_volume(latest_item)

    # daily CSV
    print("Building daily 1-year dataset...")
    df_daily = build_daily_1year(snapshot_stats)
    if df_daily.empty:
        print("No daily data available; daily CSV will not be written.", file=sys.stderr)
    else:
        if "ds" not in df_daily.columns:
            print("Daily data missing ds; skipping daily CSV.", file=sys.stderr)
        else:
            df_daily.to_csv(OUT_DAILY, index=False)
            print(f"Wrote daily CSV: {OUT_DAILY} ({len(df_daily)} rows)")

    # minute CSV
    print("Building minute last-week dataset...")
    df_minute = build_minute_lastweek(snapshot_stats)
    if df_minute.empty:
        print("No minute data available; minute CSV will not be written.", file=sys.stderr)
    else:
        if "ds" not in df_minute.columns:
            print("Minute data missing ds; skipping minute CSV.", file=sys.stderr)
        else:
            df_minute["ds"] = pd.to_datetime(df_minute["ds"], utc=True)
            df_minute.to_csv(OUT_MINUTE, index=False)
            print(f"Wrote minute CSV: {OUT_MINUTE} ({len(df_minute)} rows)")

if __name__ == "__main__":
    main()
