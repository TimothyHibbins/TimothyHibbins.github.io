"""
Stooq Data Preprocessor
========================

Converts the Stooq bulk download (nested folders of daily .txt files)
into a single monthly returns CSV suitable for the LH comoment replication.

Usage:
    python stooq_preprocess.py --input /path/to/stooq/data/d_us_txt \
                                --output stock_returns_stooq.csv \
                                --start 1990-01-01 \
                                --end   2024-12-31 \
                                --min_months 60

The Stooq structure:
    d_us_txt/
        data/
            daily/
                us/
                    nyse stocks/
                        a/
                            aapl.us.txt
                            ...
                        b/
                            ...
                    nasdaq stocks/
                        ...
                    nyse mkt stocks/  (AMEX)
                        ...

Output:
    stock_returns_stooq.csv
        - Columns: ticker symbols
        - Rows: month-end dates (YYYY-MM-DD)
        - Values: monthly total returns (decimal, e.g. 0.05 = 5%)
        - Missing months filled with NaN

Notes:
    - Returns computed as (close_t / close_{t-1}) - 1 within each month
      using last trading day close price of each month
    - No dividend adjustment (Stooq close prices are not adjusted for
      dividends in the bulk download — prices only)
    - Survivorship bias: Stooq includes delisted stocks in the bulk
      download, so the dataset is largely survivorship-bias free
    - Stocks with fewer than min_months observations are excluded
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ── File parsing ──────────────────────────────────────────────────────────────

def parse_stooq_file(filepath):
    """
    Parse a single Stooq .txt file into a daily price Series.
    Returns (ticker, pd.Series) or (None, None) on failure.
    """
    try:
        df = pd.read_csv(filepath, header=0)
        # Normalise column names — strip angle brackets
        df.columns = [c.strip('<>').upper() for c in df.columns]

        required = {'DATE', 'CLOSE'}
        if not required.issubset(df.columns):
            return None, None

        # Parse dates
        df['DATE'] = pd.to_datetime(df['DATE'].astype(str), format='%Y%m%d',
                                     errors='coerce')
        df = df.dropna(subset=['DATE'])

        # Parse close prices
        df['CLOSE'] = pd.to_numeric(df['CLOSE'], errors='coerce')
        df = df.dropna(subset=['CLOSE'])
        df = df[df['CLOSE'] > 0]

        if len(df) < 10:
            return None, None

        df = df.sort_values('DATE').set_index('DATE')

        # Extract ticker from filename — remove .us.txt suffix
        name = Path(filepath).stem.upper()          # e.g. AAPL.US
        ticker = name.replace('.US', '').replace('.', '-')

        return ticker, df['CLOSE']

    except Exception:
        return None, None


# ── Monthly return aggregation ────────────────────────────────────────────────

def daily_to_monthly_return(price_series):
    """
    Convert daily close prices to monthly returns.
    Uses last trading day close of each month.
    Returns Series indexed by month-end timestamps.
    """
    # Resample to month-end using last available price
    monthly = price_series.resample('ME').last()
    monthly = monthly.dropna()

    # Monthly return = (P_t / P_{t-1}) - 1
    ret = monthly.pct_change().dropna()
    return ret


# ── Main pipeline ─────────────────────────────────────────────────────────────

def find_txt_files(root_dir):
    """Recursively find all .txt files under root_dir."""
    root = Path(root_dir)
    if not root.exists():
        raise FileNotFoundError(f"Directory not found: {root_dir}")
    files = list(root.rglob('*.txt'))
    return files


def run(input_dir, output_file, start_date, end_date,
        min_months=60, chunk_size=1000, verbose=True):

    # ── Discover files ─────────────────────────────────────────────────────
    if verbose:
        print(f"Scanning for .txt files in: {input_dir}")
    files = find_txt_files(input_dir)
    if verbose:
        print(f"  Found {len(files):,} files")

    # Filter to .us.txt files (US stocks) AND exclude ETF folders.
    # Stooq separates stocks and ETFs into different directories
    # (e.g. "nasdaq stocks" vs "nasdaq etfs"). The recursive walk picks
    # up both, and ETFs also have .us.txt filenames, so we must exclude
    # any file whose path contains an ETF folder. ETFs contaminate the
    # universe with funds that hold baskets of the same stocks (inflating
    # correlations) and with leveraged/inverse products that have
    # structural drift unrelated to risk premia.
    def is_stock(f):
        p = str(f).lower()
        name_ok = f.name.lower().endswith('.us.txt') or '.us.' in f.name.lower()
        # path must indicate a stocks folder and must NOT be an etf folder
        in_etf = 'etf' in p          # matches "etfs" folders
        in_stocks = 'stock' in p      # matches "stocks", "stocks intl" etc.
        return name_ok and in_stocks and not in_etf

    us_files = [f for f in files if is_stock(f)]
    if not us_files:
        # Fallback: keep .us.txt but still drop anything in an etf folder
        us_files = [f for f in files
                    if (f.name.lower().endswith('.us.txt')
                        or '.us.' in f.name.lower())
                    and 'etf' not in str(f).lower()]
    if verbose:
        n_etf_excluded = sum(
            1 for f in files
            if (f.name.lower().endswith('.us.txt') or '.us.' in f.name.lower())
            and 'etf' in str(f).lower())
        print(f"  US stock files: {len(us_files):,}  "
              f"(excluded {n_etf_excluded:,} ETF files)")

    # Date range filter
    start = pd.Timestamp(start_date)
    end   = pd.Timestamp(end_date)

    # ── Process in chunks ──────────────────────────────────────────────────
    all_returns = {}
    failed = 0
    short = 0

    print(f"\nProcessing {len(us_files):,} files...")
    print(f"  Date range: {start.date()} to {end.date()}")
    print(f"  Min months required: {min_months}")
    print()

    for i, filepath in enumerate(us_files):
        ticker, prices = parse_stooq_file(filepath)

        if ticker is None:
            failed += 1
            continue

        # Clip to date range
        prices = prices.loc[start:end]
        if len(prices) < 20:  # need at least 20 daily obs
            short += 1
            continue

        # Convert to monthly returns
        monthly_ret = daily_to_monthly_return(prices)
        monthly_ret = monthly_ret.loc[start:end]

        # Filter to minimum months
        if monthly_ret.notna().sum() < min_months:
            short += 1
            continue

        all_returns[ticker] = monthly_ret

        if verbose and (i + 1) % chunk_size == 0:
            print(f"  {i+1:>7,} / {len(us_files):,} files processed  "
                  f"| {len(all_returns):,} valid stocks  "
                  f"| {failed} failed  "
                  f"| {short} too short")

    if verbose:
        print(f"\n  Done. {len(us_files):,} files processed.")
        print(f"  Valid stocks:  {len(all_returns):,}")
        print(f"  Failed:        {failed:,}")
        print(f"  Too short:     {short:,}")

    if not all_returns:
        print("ERROR: No valid stock data found. Check --input path.")
        sys.exit(1)

    # ── Build returns DataFrame ────────────────────────────────────────────
    print(f"\nBuilding monthly returns matrix...")

    # Union of all dates
    all_dates = pd.DatetimeIndex(
        sorted(set().union(*[set(s.index) for s in all_returns.values()])))

    df = pd.concat(all_returns, axis=1)
    df.columns = [t for t in all_returns.keys()]
    df.index = pd.DatetimeIndex(df.index)

    df = df.sort_index()

    # Clip to requested range
    df = df.loc[start:end]

    # Remove stocks that are all NaN
    df = df.dropna(axis=1, how='all')

    # Summary statistics
    n_stocks = df.shape[1]
    n_months = df.shape[0]
    coverage = df.notna().sum().sum() / (n_stocks * n_months)
    mean_history = df.notna().sum(axis=0).mean()

    print(f"  Matrix shape:  {n_months} months × {n_stocks} stocks")
    print(f"  Date range:    {df.index[0].date()} to {df.index[-1].date()}")
    print(f"  Fill rate:     {coverage:.1%}")
    print(f"  Mean history:  {mean_history:.0f} months per stock")

    # Cross-sectional distribution of monthly returns (sanity check)
    flat = df.values.flatten()
    flat = flat[np.isfinite(flat)]
    print(f"\n  Return distribution (sanity check):")
    print(f"    Mean:   {flat.mean()*100:+.2f}%")
    print(f"    Std:    {flat.std()*100:.2f}%")
    print(f"    p5:     {np.percentile(flat,5)*100:+.2f}%")
    print(f"    p95:    {np.percentile(flat,95)*100:+.2f}%")
    print(f"    p1:     {np.percentile(flat,1)*100:+.2f}%")
    print(f"    p99:    {np.percentile(flat,99)*100:+.2f}%")

    # Flag extreme outliers — returns > 500% or < -99% in a single month
    extreme = ((df > 5.0) | (df < -0.99)).sum().sum()
    if extreme > 0:
        print(f"\n  WARNING: {extreme} extreme return observations "
              f"(|ret| > 500% or < -99%)")
        print(f"  These will be winsorised at [-99%, +500%] in the output")
        df = df.clip(lower=-0.99, upper=5.0)

    # ── Save ───────────────────────────────────────────────────────────────
    print(f"\nSaving to {output_file}...")
    df.to_csv(output_file)
    size_mb = Path(output_file).stat().st_size / 1e6
    print(f"  Saved {size_mb:.1f} MB")
    print(f"\nDone. Load with:")
    print(f"  df = pd.read_csv('{output_file}', index_col=0, parse_dates=True)")

    return df


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Convert Stooq daily txt files to monthly returns CSV')

    parser.add_argument('--input', required=True,
        help='Path to Stooq data root directory (e.g. d_us_txt/data/daily/us)')
    parser.add_argument('--output', default='stock_returns_stooq.csv',
        help='Output CSV filename (default: stock_returns_stooq.csv)')
    parser.add_argument('--start', default='1990-01-01',
        help='Start date YYYY-MM-DD (default: 1990-01-01)')
    parser.add_argument('--end', default='2024-12-31',
        help='End date YYYY-MM-DD (default: 2024-12-31)')
    parser.add_argument('--min_months', type=int, default=60,
        help='Minimum months of data required per stock (default: 60)')
    parser.add_argument('--quiet', action='store_true',
        help='Suppress progress output')

    args = parser.parse_args()

    run(
        input_dir   = args.input,
        output_file = args.output,
        start_date  = args.start,
        end_date    = args.end,
        min_months  = args.min_months,
        verbose     = not args.quiet,
    )


if __name__ == '__main__':
    main()