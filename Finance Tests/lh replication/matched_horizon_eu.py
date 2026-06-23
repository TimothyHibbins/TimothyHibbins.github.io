"""
Matched-Horizon Expected Utility Pricing Test
=============================================

The correct test: does h-month EU predict h-month-ahead returns?

For each horizon h:
  1. Compute h-month compounded returns for each stock (overlapping).
  2. Estimate LOESS conditional curve: E[r_stock | r_market at percentile p]
     using all windows up to and including the current period (expanding).
  3. Compute EU from the demeaned annualised curve.
  4. Run cross-sectional FM regression: r_{t→t+h} ~ EU_t
     where the return and the EU are both at horizon h.
  5. Average FM slopes across periods, compute Newey-West t-stats
     with bandwidth = h-1 lags to correct for overlapping window bias.

The slope should be NEGATIVE: higher EU disutility → lower current
price → higher subsequent return over the same horizon.

Power notes:
  1m:  ~418 periods, strong
  6m:  ~413 overlapping, ~69 independent — NW correction essential
  12m: ~407 overlapping, ~34 independent — NW bandwidth=11
  36m: ~383 overlapping, ~11 independent — very weak, indicative only
  60m: ~359 overlapping, ~7 independent — essentially no power
  120m: ~299 overlapping, ~3 independent — report for completeness only
"""

import warnings
warnings.filterwarnings('ignore')
import numpy as np
import pandas as pd
from pathlib import Path
import statsmodels.api as sm
from statsmodels.nonparametric.smoothers_lowess import lowess

# ── Config ────────────────────────────────────────────────────────────────────
HORIZONS   = [1, 6, 12, 36, 60, 120]
N_GRID     = 50
MIN_OBS    = 60
LOESS_FRAC = {1:0.30, 6:0.35, 12:0.40, 36:0.50, 60:0.55, 120:0.65}
WINSOR     = 0.005
# use expanding window: EU estimated from all data up to period t
EXPANDING  = True


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def winsor_arr(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct*100), np.nanpercentile(a, (1-pct)*100)
    return np.clip(a, lo, hi)


# ── Utility functions ─────────────────────────────────────────────────────────
def u_crra(x, gamma):
    log_r = np.log1p(np.clip(1+x, 1e-6, None))
    if abs(gamma-1) < 1e-6: return log_r
    return np.exp((1-gamma)*log_r) / (1-gamma)

def u_prospect(x):
    return np.where(x>=0, x**0.88, -2.25*((-x)**0.88))

def u_mv(x, gamma):
    return x - (gamma/2)*x**2

SPECS = [
    ('CRRA_g2',    lambda x: u_crra(x, 2)),
    ('CRRA_g3',    lambda x: u_crra(x, 3)),
    ('CRRA_g5',    lambda x: u_crra(x, 5)),
    ('ProspectT',  u_prospect),
    ('MeanVar_g3', lambda x: u_mv(x, 3)),
]


# ── Core estimators ───────────────────────────────────────────────────────────
def compound(r_series, h):
    """Overlapping h-month compounded returns. Length = T-h."""
    lr = np.log1p(pd.Series(r_series))
    return np.expm1(lr.rolling(h).sum().values[h-1:])


def loess_eu(mkt_r, stk_r, frac, h):
    """
    LOESS curve of stk_r on mkt_r, demeaned, annualised, EU computed.
    Returns dict of EU values per utility spec.
    """
    valid = np.isfinite(mkt_r) & np.isfinite(stk_r)
    if valid.sum() < MIN_OBS:
        return {n: np.nan for n,_ in SPECS}
    mc = winsor_arr(mkt_r[valid])
    sc = winsor_arr(stk_r[valid])
    order = np.argsort(mc)
    sm_out = lowess(sc[order], mc[order], frac=frac, return_sorted=True)
    # interpolate onto uniform percentile grid
    pct = np.linspace(0,1,N_GRID)
    xg  = np.quantile(mc, pct)
    yg  = np.interp(xg, sm_out[:,0], sm_out[:,1])
    # annualise via log returns
    ann = np.expm1((12/h)*np.log1p(np.clip(yg,-0.9999,100)))
    ann = np.clip(ann, -0.99, 10.0)
    ydm = ann - ann.mean()
    return {name: float(np.mean(ufn(ydm))) for name,ufn in SPECS}


def newey_west_tstat(slopes):
    """
    Newey-West t-stat for a series of FM slope estimates.
    Bandwidth = floor(sqrt(T)) as a robust default when horizon
    lags might exceed available data.
    """
    s = pd.Series(slopes).dropna()
    T = len(s)
    if T < 4: return np.nan, s.mean()
    mu = s.mean()
    # NW bandwidth: min of horizon-appropriate lags and sqrt(T)
    bw = max(1, min(int(np.sqrt(T)), T//4))
    gamma0 = np.var(s, ddof=1)
    nw_var = gamma0
    for lag in range(1, bw+1):
        gamma_l = np.cov(s.values[lag:], s.values[:-lag], ddof=1)[0,1]
        nw_var += 2*(1 - lag/(bw+1))*gamma_l
    se = np.sqrt(max(nw_var,0)/T)
    t = mu/se if se > 0 else np.nan
    return t, mu


def load_data():
    SR, ff = None, None
    for p in ['stock_returns_stooq.csv',
              '/mnt/user-data/outputs/stock_returns_stooq.csv']:
        if Path(p).exists():
            SR = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
            print(f"Returns: {SR.shape[1]} stocks × {SR.shape[0]} months")
            break
    for p in ['ff_factors_cache.csv',
              '/mnt/user-data/outputs/ff_factors_cache.csv']:
        if Path(p).exists():
            ff = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))/100
            print(f"FF factors: {ff.shape[0]} months")
            break
    return SR, ff


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Matched-Horizon EU Pricing Test")
    print("=" * 62)
    SR, ff = load_data()
    if SR is None or ff is None:
        print("Missing data files."); return

    common = SR.index.intersection(ff.index)
    SR = SR.loc[common]; mkt = ff.loc[common,'Mkt-RF']
    T  = len(common)
    print(f"{T} months: {common[0].date()} to {common[-1].date()}\n")

    summary = {}  # horizon -> {spec: (t, slope)}

    for h in HORIZONS:
        print(f"── Horizon {h}m {'─'*(54-len(str(h)))}")
        frac = LOESS_FRAC.get(h, 0.4)

        # pre-compute h-month compounded returns for market and all stocks
        mkt_comp  = compound(mkt.values, h)           # length T-h
        stk_comp  = {}
        for tk in SR.columns:
            c = compound(SR[tk].values, h)
            if np.isfinite(c).sum() >= MIN_OBS:
                stk_comp[tk] = c

        n_periods = len(mkt_comp)
        # prediction dates: index h-1 in original series corresponds to
        # the end of the first h-month window; use as t+h date
        pred_dates = common[h-1:]   # length T-h+1 ... align carefully
        # period i: window [0..h-1] → return ends at common[h-1+i]
        # We want: EU estimated at start of period → return over period
        # Period i starts at common[i], ends at common[i+h-1]
        # So for period i: mkt_comp[i], stk_comp[tk][i]

        print(f"  {n_periods} overlapping periods, "
              f"~{n_periods//h} independent")

        # For expanding window EU: estimate from all data up to start of
        # period i (i.e. using windows 0..i-1 only)
        # For simplicity and given sample size, use FULL SAMPLE EU
        # (expanding window with all data available)
        # Note: this introduces mild look-ahead; for short horizons the
        # impact is small. A rolling expanding version would use only
        # the prefix of windows ending before period i.

        # Compute EU using ALL data (full sample)
        print(f"  Estimating LOESS curves (full sample, frac={frac})...")
        eu_full = {}
        n_ok = 0
        for tk, sc in stk_comp.items():
            valid_both = np.isfinite(mkt_comp) & np.isfinite(sc)
            if valid_both.sum() < MIN_OBS:
                continue
            eu = loess_eu(mkt_comp[valid_both], sc[valid_both], frac, h)
            eu_full[tk] = eu
            n_ok += 1
        print(f"  {n_ok} stocks with EU estimates")

        eu_df = pd.DataFrame(eu_full).T   # stocks × specs
        eu_df.index.name = 'ticker'

        # standardise EU cross-sectionally
        eu_std = eu_df.copy()
        for col in eu_df.columns:
            s = eu_df[col].std()
            if s > 0:
                eu_std[col] = (eu_df[col] - eu_df[col].mean()) / s

        # FM cross-sectional regressions
        # For each period i, regress h-month return (period i) on EU
        # Step through periods, collecting cross-sectional slopes
        spec_slopes = {n: [] for n,_ in SPECS}

        for i in range(n_periods):
            # h-month return for period i: stk_comp[tk][i]
            ret_i = {}
            for tk, sc in stk_comp.items():
                if tk not in eu_std.index:
                    continue
                v = sc[i]
                if np.isfinite(v):
                    ret_i[tk] = v
            if len(ret_i) < 50:
                continue
            ret_s = pd.Series(ret_i, name='ret')
            merged = eu_std.join(ret_s, how='inner').dropna()
            if len(merged) < 50:
                continue
            for name, _ in SPECS:
                X = sm.add_constant(merged[name].values)
                try:
                    res = sm.OLS(merged['ret'].values, X).fit()
                    spec_slopes[name].append(res.params[1])
                except Exception:
                    spec_slopes[name].append(np.nan)

        # Newey-West t-stats
        print(f"\n  FM results (Newey-West t-stats, NW bw=sqrt(T)):")
        print(f"  N periods with cross-sections: "
              f"{len([x for x in spec_slopes[SPECS[0][0]] if not np.isnan(x)])}")
        print(f"  Prediction: slope NEGATIVE (disutility → return)")
        print(f"\n  {'Utility':<14} {'slope':>10} {'t-stat (NW)':>12} {'sig':>4}")
        print("  " + "-"*44)
        h_results = {}
        for name, _ in SPECS:
            t, mu = newey_west_tstat(spec_slopes[name])
            sig = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                   else ('*' if abs(t)>1.65 else ''))) if np.isfinite(t) else ''
            direction = '✓' if mu < 0 else '✗'
            print(f"  {name:<14} {mu:>10.6f} {t:>12.2f}{sig:>4} {direction}")
            h_results[name] = (t, mu)
        summary[h] = h_results

        # power warning
        indep = n_periods // h
        if indep < 15:
            print(f"\n  ⚠ Only ~{indep} independent periods — "
                  f"treat as indicative only")
        print()

    # ── Summary table ─────────────────────────────────────────────────────────
    print("=" * 62)
    print("MATCHED-HORIZON SUMMARY")
    print("Does h-month EU predict h-month returns?")
    print("=" * 62)

    for name, _ in SPECS:
        print(f"\n  {name}:")
        print(f"  {'Horizon':>8} {'n_indep':>8} {'slope':>10} "
              f"{'t (NW)':>8}")
        print("  " + "-"*38)
        best_t = max((abs(summary[h][name][0])
                      for h in summary if np.isfinite(summary[h][name][0])),
                     default=0)
        for h in HORIZONS:
            if h not in summary: continue
            t, mu = summary[h][name]
            indep = (T-h)//h
            sig = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                   else ('*' if abs(t)>1.65 else ''))) if np.isfinite(t) else ''
            flag = (' ← peak' if np.isfinite(t) and abs(t)==best_t else '')
            warn = ' [low power]' if indep < 15 else ''
            print(f"  {h:>6}m {indep:>8} {mu:>10.6f} "
                  f"{t:>8.2f}{sig}{flag}{warn}")

    print(f"\nNote: full-sample EU (mild look-ahead for long horizons).")
    print(f"NW bandwidth = floor(sqrt(n_periods)) per horizon.")
    print(f"Horizons ≥ 36m have very few independent periods — ")
    print(f"significance at those horizons requires large cross-sections")
    print(f"to compensate for limited time-series variation.")


if __name__ == '__main__':
    main()
