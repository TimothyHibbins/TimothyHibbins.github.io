"""
Export LOESS curves and raw percentile data for the interactive viewer.

For each stock present in the EU files, for each horizon:
  - Raw scatter: (market_percentile, stock_return) pairs
  - LOESS fitted curve on a 100-point grid
  - Demeaned annualised curve (what goes into EU)

Output: loess_curves.json
  { tickers: [...],
    horizons: [1,6,12,36,60,120],
    data: {
      AAPL: {
        '1': { raw_x, raw_y, curve_x, curve_y, dm_curve_y, eu:{CRRA_g2:..} },
        '12': { ... },
        ...
      }
    }
  }

To keep file size manageable:
  - Raw scatter: max 200 points (sampled uniformly by market percentile)
  - Only stocks present in eu_h1m.csv are included
  - Tickers sorted alphabetically for the dropdown
"""

import json, warnings
import numpy as np
import pandas as pd
from pathlib import Path
from statsmodels.nonparametric.smoothers_lowess import lowess
warnings.filterwarnings('ignore')

HORIZONS   = [1, 6, 12, 36, 60, 120]
N_GRID     = 100
MAX_RAW    = 200
LOESS_FRAC = {1:0.30, 6:0.35, 12:0.40, 36:0.50, 60:0.55, 120:0.65}
WINSOR     = 0.005

SPECS = [
    ('CRRA_g2',    lambda x: np.exp((1-2)*np.log1p(np.clip(1+x,1e-6,None)))/(1-2)),
    ('CRRA_g3',    lambda x: np.exp((1-3)*np.log1p(np.clip(1+x,1e-6,None)))/(1-3)),
    ('CRRA_g5',    lambda x: np.exp((1-5)*np.log1p(np.clip(1+x,1e-6,None)))/(1-5)),
    ('ProspectT',  lambda x: np.where(x>=0, x**0.88, -2.25*((-x)**0.88))),
    ('MeanVar_g3', lambda x: x - 1.5*x**2),
]


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def winsor(a):
    lo, hi = np.nanpercentile(a, WINSOR*100), np.nanpercentile(a, (1-WINSOR)*100)
    return np.clip(a, lo, hi)


def compound(r, h):
    lr = np.log1p(pd.Series(r))
    return np.expm1(lr.rolling(h).sum().values[h-1:])


def process_stock(mkt_comp, stk_comp, h, frac):
    valid = np.isfinite(mkt_comp) & np.isfinite(stk_comp)
    if valid.sum() < 40:
        return None
    mc = winsor(mkt_comp[valid])
    sc = winsor(stk_comp[valid])

    # raw scatter: sample MAX_RAW points uniformly across market percentile
    order = np.argsort(mc)
    mc_s, sc_s = mc[order], sc[order]
    n = len(mc_s)
    if n > MAX_RAW:
        idx = np.linspace(0, n-1, MAX_RAW, dtype=int)
        mc_s, sc_s = mc_s[idx], sc_s[idx]

    # convert raw to market percentile (0-100) for display
    raw_pct = np.linspace(0, 100, len(mc_s))
    raw_y   = sc_s

    # LOESS curve on full data
    sm = lowess(sc[np.argsort(mc)], mc[np.argsort(mc)],
                frac=frac, return_sorted=True)
    pct_grid = np.linspace(0, 100, N_GRID)
    x_grid   = np.quantile(mc, pct_grid/100)
    curve_y  = np.interp(x_grid, sm[:,0], sm[:,1])

    # demeaned annualised curve
    ann = np.expm1((12/h)*np.log1p(np.clip(curve_y, -0.9999, 100)))
    ann = np.clip(ann, -0.99, 10.0)
    dm  = ann - ann.mean()

    # EU values
    eu = {}
    for name, ufn in SPECS:
        try:
            eu[name] = round(float(np.mean(ufn(dm))), 6)
        except Exception:
            eu[name] = None

    return {
        'raw_pct':   [round(x,1) for x in raw_pct.tolist()],
        'raw_y':     [round(x,4) for x in raw_y.tolist()],
        'curve_pct': [round(x,1) for x in pct_grid.tolist()],
        'curve_y':   [round(x,4) for x in curve_y.tolist()],
        'dm_y':      [round(x,4) for x in dm.tolist()],
        'eu':        eu,
    }


def main():
    # load returns
    SR = None
    for p in ['stock_returns_stooq.csv',
              '/mnt/user-data/outputs/stock_returns_stooq.csv']:
        if Path(p).exists():
            SR = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
            print(f"Loaded returns: {SR.shape}")
            break
    if SR is None:
        print("stock_returns_stooq.csv not found"); return

    ff = None
    for p in ['ff_factors_cache.csv',
              '/mnt/user-data/outputs/ff_factors_cache.csv']:
        if Path(p).exists():
            ff = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))/100
            break
    if ff is None:
        print("ff_factors_cache.csv not found"); return

    common = SR.index.intersection(ff.index)
    SR = SR.loc[common]; mkt = ff.loc[common,'Mkt-RF']

    # which tickers to include: those present in eu_h1m.csv
    eu1_path = Path('eu_h1m.csv')
    if eu1_path.exists():
        eu1 = pd.read_csv(eu1_path)
        include_set = set(eu1['ticker'].str.upper().str.replace('.US',''))
        print(f"Restricting to {len(include_set)} tickers from eu_h1m.csv")
    else:
        # fall back: all tickers
        include_set = set(tk.replace('.us','').upper() for tk in SR.columns)
        print(f"No eu_h1m.csv found — using all {len(include_set)} tickers")

    # map clean ticker -> original column name
    tk_map = {}
    for col in SR.columns:
        clean = col.replace('.us','').replace('.US','').upper()
        if clean in include_set:
            tk_map[clean] = col

    tickers_sorted = sorted(tk_map.keys())
    print(f"{len(tickers_sorted)} tickers to export")

    # pre-compute compounded market returns per horizon
    mkt_comp_h = {}
    for h in HORIZONS:
        mkt_comp_h[h] = compound(mkt.values, h)

    out = {'tickers': tickers_sorted,
           'horizons': HORIZONS,
           'data': {}}

    for ti, tk in enumerate(tickers_sorted):
        col = tk_map[tk]
        stk_data = {}
        for h in HORIZONS:
            mc = mkt_comp_h[h]
            sc = compound(SR[col].values, h)
            n  = min(len(mc), len(sc))
            res = process_stock(mc[:n], sc[:n], h, LOESS_FRAC[h])
            if res is not None:
                stk_data[str(h)] = res
        if stk_data:
            out['data'][tk] = stk_data
        if (ti+1) % 200 == 0:
            print(f"  {ti+1}/{len(tickers_sorted)} tickers...")

    # save
    outpath = Path('loess_curves.json')
    with open(outpath, 'w') as f:
        json.dump(out, f)
    size_mb = outpath.stat().st_size / 1e6
    print(f"\nWrote loess_curves.json ({size_mb:.1f} MB)")
    print(f"{len(out['data'])} tickers, {len(HORIZONS)} horizons each")


if __name__ == '__main__':
    main()
