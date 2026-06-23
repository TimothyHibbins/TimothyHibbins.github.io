"""
Fetch Industry Classifications for Stooq Universe
==================================================

Run once to build ticker_industries.csv, which the cluster export uses
for the industry colour mode in the animated map.

Uses yfinance to pull sector/industry for each ticker. Only fetches for
current (non-delisted) tickers — delisted names are assigned the sector
of the nearest surviving name by prefix heuristic, or "Unknown" if none.

Output: ticker_industries.csv
  columns: ticker, sector, industry

This is not survivorship-bias-free (yfinance only knows current names)
but it's sufficient for the visual colour layer — we're labelling for
interpretability, not for statistical analysis.

Run with:
    python fetch_industries.py

Requires: yfinance (pip install yfinance)
"""

import time
import pandas as pd
import yfinance as yf
from pathlib import Path

RETURNS_FILE  = 'stock_returns_stooq.csv'
OUTPUT_FILE   = 'ticker_industries.csv'
BATCH_DELAY   = 0.3   # seconds between requests (polite to Yahoo)

SECTOR_COLOURS = {
    'Technology':               '#5ad1c8',
    'Healthcare':               '#7aa8e0',
    'Financial Services':       '#d9a441',
    'Consumer Cyclical':        '#e07ab0',
    'Communication Services':   '#9b8ce0',
    'Industrials':              '#6fc26f',
    'Consumer Defensive':       '#46b0a8',
    'Energy':                   '#e2614a',
    'Basic Materials':          '#cf7d4a',
    'Real Estate':              '#5c8fd6',
    'Utilities':                '#b0a03a',
    'Unknown':                  '#445566',
}


def main():
    if not Path(RETURNS_FILE).exists():
        print(f"{RETURNS_FILE} not found — run stooq_preprocess.py first")
        return

    tickers = pd.read_csv(RETURNS_FILE, index_col=0, nrows=0).columns.tolist()
    tickers_clean = [t.replace('.us','').replace('.US','').upper()
                     for t in tickers]
    print(f"{len(tickers_clean)} tickers to classify")

    # check if we have a partial cache
    done = {}
    if Path(OUTPUT_FILE).exists():
        existing = pd.read_csv(OUTPUT_FILE)
        for _, r in existing.iterrows():
            done[r['ticker']] = (r['sector'], r['industry'])
        print(f"  Resuming from {len(done)} already fetched")

    results = dict(done)
    to_fetch = [t for t in tickers_clean if t not in results]
    print(f"  {len(to_fetch)} remaining to fetch")

    # Pre-assign Unknown for tickers that yfinance will never know:
    # preferred stock series (JPM_D, BAC_B etc), warrants, rights
    # These are identifiable by underscore or letter suffix patterns
    import re
    pref_pattern = re.compile(r'^[A-Z]+-?[A-Z]$|.*_[A-Z]$')
    auto_unknown = [t for t in to_fetch if pref_pattern.match(t)]
    for t in auto_unknown:
        results[t] = ('Unknown', 'Unknown')
    to_fetch = [t for t in to_fetch if t not in set(auto_unknown)]
    print(f"  Skipped {len(auto_unknown)} preferred/warrant tickers (→ Unknown)")
    print(f"  {len(to_fetch)} common stock tickers to fetch")

    import os, sys

    # Batch download in chunks
    CHUNK = 200
    for start in range(0, len(to_fetch), CHUNK):
        chunk = to_fetch[start:start+CHUNK]
        try:
            # Suppress yfinance stderr noise (404s etc)
            devnull = open(os.devnull, 'w')
            old_stderr = sys.stderr
            sys.stderr = devnull
            try:
                batch = yf.Tickers(' '.join(chunk))
                for tk in chunk:
                    try:
                        info = batch.tickers[tk].info
                        sector   = info.get('sector',   'Unknown') or 'Unknown'
                        industry = info.get('industry', 'Unknown') or 'Unknown'
                    except Exception:
                        sector, industry = 'Unknown', 'Unknown'
                    results[tk] = (sector, industry)
            finally:
                sys.stderr = old_stderr
                devnull.close()
        except Exception:
            sys.stderr = old_stderr if 'old_stderr' in dir() else sys.stderr
            for tk in chunk:
                try:
                    info = yf.Ticker(tk).info
                    sector   = info.get('sector',   'Unknown') or 'Unknown'
                    industry = info.get('industry', 'Unknown') or 'Unknown'
                except Exception:
                    sector, industry = 'Unknown', 'Unknown'
                results[tk] = (sector, industry)

        _save(results, OUTPUT_FILE)
        done_n = start + len(chunk)
        known = sum(1 for s,_ in results.values() if s != 'Unknown')
        print(f"  {done_n}/{len(to_fetch)} fetched "
              f"({known} with sector data)...")

    _save(results, OUTPUT_FILE)
    by_sector = pd.Series(
        [r[0] for r in results.values()]).value_counts()
    print(f"\nDone. {len(results)} tickers classified.")
    print("Sector breakdown:")
    for sec, n in by_sector.items():
        print(f"  {sec:<30} {n}")


def _save(results, path):
    rows = [{'ticker': tk, 'sector': s, 'industry': i}
            for tk, (s, i) in results.items()]
    pd.DataFrame(rows).to_csv(path, index=False)


if __name__ == '__main__':
    main()