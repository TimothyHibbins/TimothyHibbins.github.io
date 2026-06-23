"""
Horizon-Dependent Expected Utility Pricing Test
================================================

Tests whether the expected disutility of a stock's market-driven return
distribution predicts cross-sectional returns, and at which horizon the
prediction is strongest — revealing the effective horizon of the marginal
investor.

Pipeline:
  1. For each stock and each horizon h, compute all overlapping h-period
     compounded returns (stock and market), sorted by market return.
  2. Fit LOESS to get E[r_stock | market at percentile p].
  3. Demean the curve (subtract its mean across percentiles) to remove
     the stock's unconditional expected return. Only the shape remains.
  4. Apply utility function U to the demeaned curve, integrate across
     percentiles to get EU per stock per period.
  5. Fama-MacBeth regression: r_{t+1} ~ EU_t across all stocks.
     Test across horizons h ∈ {1m, 6m, 12m, 36m, 60m, 120m}.
     Horizon where |t-stat on EU| is largest = effective marginal investor horizon.

Utility functions tested:
  - CRRA: U(x) = (1+x)^(1-γ)/(1-γ)  [γ = 2, 3, 5]
  - Prospect theory (loss-averse): U(x) = x^α if x>0, -λ|x|^β if x<0
  - Mean-variance: U(x) = x - (γ/2)x²  [baseline, recovers variance pricing]

Key prediction: EU coefficient in FM regression is NEGATIVE
(high disutility = high required compensation = high subsequent return).
Horizon where this is most negative and most significant = marginal
investor horizon.
"""

import warnings
warnings.filterwarnings('ignore')
import numpy as np
import pandas as pd
from pathlib import Path
import statsmodels.api as sm
from statsmodels.nonparametric.smoothers_lowess import lowess

# ── Config ────────────────────────────────────────────────────────────────────
HORIZONS      = [1, 6, 12, 36, 60, 120]  # months
N_GRID        = 50     # percentile grid points for LOESS output
MIN_OBS       = 60     # min windows needed to estimate curve per stock
LOESS_FRAC    = {1: 0.30, 6: 0.35, 12: 0.40, 36: 0.50, 60: 0.55, 120: 0.65}
WINSOR        = 0.005
GAMMA_CRRA    = [2, 3, 5]
LAMBDA_PT     = 2.25   # prospect theory loss aversion
ALPHA_PT      = 0.88   # prospect theory gain curvature
BETA_PT       = 0.88   # prospect theory loss curvature

# For the rolling EU estimate, use a rolling window of this many months
# before each prediction date. If None, uses full history up to that date.
ROLLING_WINDOW = None   # None = expanding window (all history)


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def winsor(a, pct=WINSOR):
    lo = np.nanpercentile(a, pct*100)
    hi = np.nanpercentile(a, (1-pct)*100)
    return np.clip(a, lo, hi)


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
            ff = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True)) / 100
            print(f"FF factors: {ff.shape[0]} months")
            break
    return SR, ff


# ── Utility functions ─────────────────────────────────────────────────────────
def u_crra(x, gamma):
    """
    CRRA utility over LOG returns (continuously compounded).
    This is the natural domain — CRRA is defined over wealth ratios,
    and log(1+r) is the log wealth ratio. Using log returns prevents
    the catastrophic asymmetry between large gains and large losses
    in simple return space.
    U(log_r) = exp((1-gamma)*log_r) / (1-gamma)  for gamma != 1
             = log_r                               for gamma = 1
    """
    log_r = np.log1p(np.clip(1 + x, 1e-6, None))  # log(1+x), x is demeaned
    if abs(gamma - 1) < 1e-6:
        return log_r
    return np.exp((1-gamma) * log_r) / (1-gamma)


def u_prospect(x):
    """Prospect theory (Tversky-Kahneman)."""
    out = np.where(x >= 0,
                   x**ALPHA_PT,
                   -LAMBDA_PT * ((-x)**BETA_PT))
    return out


def u_mv(x, gamma):
    """Mean-variance: recovers variance pricing as baseline."""
    return x - (gamma/2) * x**2


UTILITY_SPECS = (
    [('CRRA_g2',    lambda x: u_crra(x, 2)),
     ('CRRA_g3',    lambda x: u_crra(x, 3)),
     ('CRRA_g5',    lambda x: u_crra(x, 5)),
     ('ProspectT',  u_prospect),
     ('MeanVar_g3', lambda x: u_mv(x, 3))]
)


# ── LOESS curve estimation ─────────────────────────────────────────────────────
def loess_curve(mkt_ret, stk_ret, frac, n_grid=N_GRID):
    """
    Fit LOESS of stk_ret on mkt_ret.
    Returns (grid_x, grid_y) where grid_x is evenly spaced percentiles
    of mkt_ret and grid_y is the smoothed conditional mean.
    """
    # sort by market return
    order = np.argsort(mkt_ret)
    x = mkt_ret[order]
    y = stk_ret[order]
    # LOESS fit
    smoothed = lowess(y, x, frac=frac, return_sorted=True)
    xs, ys = smoothed[:, 0], smoothed[:, 1]
    # interpolate onto uniform percentile grid
    pct = np.linspace(0, 1, n_grid)
    x_grid = np.quantile(x, pct)
    y_grid = np.interp(x_grid, xs, ys)
    return x_grid, y_grid


def demeaned_eu(y_grid, u_func, horizon_months):
    """
    Demean the curve and compute expected utility.

    Annualise using log returns to handle extreme values gracefully:
      r_ann = exp((12/h) * log(1+R_h)) - 1

    Clip to [-0.99, 10.0] annualised before utility evaluation to
    prevent CRRA overflow from extreme compounded returns.

    Demean the annualised curve to remove unconditional expected return.
    Only the shape of the distribution relative to its mean is retained.
    """
    ann_factor = 12.0 / horizon_months
    # log-return annualisation
    log_r = np.log1p(np.clip(y_grid, -0.9999, 100.0))
    y_ann = np.expm1(ann_factor * log_r)
    # clip to prevent utility overflow
    y_ann = np.clip(y_ann, -0.99, 10.0)
    # demean
    y_dm = y_ann - y_ann.mean()
    eu = np.mean(u_func(y_dm))
    return eu


# ── Compounded returns ────────────────────────────────────────────────────────
def compound_returns(r_series, h):
    """
    For a return series r (monthly), compute all overlapping h-month
    compounded returns. Returns array of length (T - h).
    """
    log1r = np.log1p(r_series)
    # rolling sum of log returns = log of compounded return
    # use pandas rolling for efficiency
    log_cum = pd.Series(log1r).rolling(h).sum().values
    return np.expm1(log_cum[h-1:])   # drop first h-1 NaN entries


# ── Per-stock curve estimation ────────────────────────────────────────────────
def estimate_curves(SR, mkt_series, horizon):
    """
    For a given horizon, estimate the demeaned LOESS curve for each stock.
    Returns DataFrame: index=stock, columns=EU under each utility spec.
    """
    h = horizon
    frac = LOESS_FRAC.get(h, 0.4)
    mkt_comp = compound_returns(mkt_series.values, h)
    T_mkt = len(mkt_comp)
    results = {}
    for ticker in SR.columns:
        r = SR[ticker].values
        stk_comp = compound_returns(r, h)
        # align lengths
        n = min(len(mkt_comp), len(stk_comp))
        if n < MIN_OBS:
            continue
        mc = mkt_comp[:n]
        sc = stk_comp[:n]
        # remove NaN pairs
        valid = np.isfinite(mc) & np.isfinite(sc)
        if valid.sum() < MIN_OBS:
            continue
        mc = winsor(mc[valid])
        sc = winsor(sc[valid])
        try:
            _, y_grid = loess_curve(mc, sc, frac)
        except Exception:
            continue
        # compute EU under each utility spec
        eu_row = {}
        for name, u_func in UTILITY_SPECS:
            try:
                eu_row[name] = demeaned_eu(y_grid, u_func, h)
            except Exception:
                eu_row[name] = np.nan
        results[ticker] = eu_row
    df = pd.DataFrame(results).T
    df.index.name = 'ticker'
    return df


# ── Fama-MacBeth regression ───────────────────────────────────────────────────
def fama_macbeth(eu_panel, ret_next, ff=None):
    """
    FM regression: ret_{t+1} ~ EU_t [+ FF controls].
    eu_panel: DataFrame with MultiIndex (date, ticker) or dict of
              {date: DataFrame(ticker x utility_specs)}.
    ret_next: Series with MultiIndex (date, ticker).
    Returns DataFrame of mean coefficients, t-stats, R².
    """
    # This simplified version uses the full-sample EU (not rolling)
    # matched to each month's next return
    monthly_slopes = []
    dates = sorted(ret_next.index.get_level_values(0).unique())
    for dt in dates:
        try:
            r_t = ret_next.loc[dt]
        except Exception:
            continue
        if not isinstance(eu_panel, pd.DataFrame):
            continue
        # merge EU (full sample) with next-month return
        merged = pd.concat([eu_panel, r_t.rename('ret')], axis=1, join='inner')
        merged = merged.dropna()
        if len(merged) < 30:
            continue
        slopes = {}
        for col in eu_panel.columns:
            X = sm.add_constant(merged[col].values)
            try:
                res = sm.OLS(merged['ret'].values, X).fit()
                slopes[col] = res.params[1]
            except Exception:
                slopes[col] = np.nan
        monthly_slopes.append(slopes)
    if not monthly_slopes:
        return None
    slopes_df = pd.DataFrame(monthly_slopes)
    mean_slope = slopes_df.mean()
    t_stat = mean_slope / (slopes_df.std() / np.sqrt(len(slopes_df)))
    return pd.DataFrame({'mean_slope': mean_slope, 't_stat': t_stat})


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Horizon-Dependent Expected Utility Pricing Test")
    print("=" * 62)
    SR, ff = load_data()
    if SR is None or ff is None:
        print("Missing data — need stock_returns_stooq.csv + ff_factors_cache.csv")
        return

    common = SR.index.intersection(ff.index)
    SR = SR.loc[common]
    ff = ff.loc[common]
    mkt = ff['Mkt-RF']

    # align SR and mkt
    T = len(common)
    print(f"\n{T} months of aligned data: {common[0].date()} to {common[-1].date()}")

    all_results = {}  # horizon -> FM result DataFrame

    for h in HORIZONS:
        print(f"\n── Horizon {h}m {'─'*(50-len(str(h)))}")
        print(f"  Estimating LOESS curves (frac={LOESS_FRAC.get(h,0.4)})...")
        eu_df = estimate_curves(SR, mkt, h)
        print(f"  {len(eu_df)} stocks with sufficient data")
        if len(eu_df) < 50:
            print("  Too few stocks — skipping")
            continue

        # save EU estimates
        eu_df.to_csv(f'eu_h{h}m.csv')

        # standardise EU cross-sectionally so slopes are comparable across
        # horizons and utility specs (unit = one cross-sectional std of EU)
        eu_df_std = eu_df.copy()
        for col in eu_df.columns:
            s = eu_df[col].std()
            if s > 0:
                eu_df_std[col] = (eu_df[col] - eu_df[col].mean()) / s

        print(f"\n  EU summary (mean across stocks, annualised, pre-standardisation):")
        print(f"  {'Utility':<14} {'mean EU':>12} {'std EU':>12}")
        print("  " + "-"*40)
        for col in eu_df.columns:
            print(f"  {col:<14} {eu_df[col].mean():>12.5f} "
                  f"{eu_df[col].std():>12.5f}")

        # check for overflow
        overflow_cols = [c for c in eu_df.columns
                         if eu_df[c].abs().max() > 1e10]
        if overflow_cols:
            print(f"\n  WARNING: overflow in {overflow_cols} — "
                  f"check annualisation")

        print(f"\n  Running Fama-MacBeth (standardised EU)...")
        slopes_by_month = []
        for dt in SR.index[1:]:
            try:
                r_t1 = SR.loc[dt]
            except Exception:
                continue
            merged = eu_df_std.join(r_t1.rename('ret'), how='inner').dropna()
            if len(merged) < 50:
                continue
            row = {'date': dt}
            for col in eu_df_std.columns:
                X = sm.add_constant(merged[col].values)
                try:
                    res = sm.OLS(merged['ret'].values, X).fit()
                    row[col] = res.params[1]
                except Exception:
                    row[col] = np.nan
            slopes_by_month.append(row)

        if not slopes_by_month:
            print("  No FM results")
            continue

        fm_df = pd.DataFrame(slopes_by_month).set_index('date')
        n_months = len(fm_df)
        mean_sl = fm_df.mean()
        t_sl = mean_sl / (fm_df.std() / np.sqrt(n_months))

        print(f"\n  Fama-MacBeth results (N={n_months} months):")
        print(f"  Prediction: slope should be NEGATIVE")
        print(f"  (high disutility → high required return)")
        print(f"\n  {'Utility':<14} {'slope':>10} {'t-stat':>8} {'sig':>4}")
        print("  " + "-"*40)
        for col in eu_df.columns:
            sl = mean_sl[col]; t = t_sl[col]
            sig = '***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                  else ('*' if abs(t)>1.65 else ''))
            direction = '✓' if sl < 0 else '✗'
            print(f"  {col:<14} {sl:>10.6f} {t:>8.2f}{sig:>4} {direction}")

        all_results[h] = {'mean_slope': mean_sl, 't_stat': t_sl}

    # ── Horizon comparison ──────────────────────────────────────────────────
    print(f"\n{'='*62}")
    print(f"HORIZON COMPARISON — which horizon is most predictive?")
    print(f"(most negative t-stat = marginal investor horizon)")
    print(f"{'='*62}")
    for utility_name, _ in UTILITY_SPECS:
        print(f"\n  {utility_name}:")
        print(f"  {'Horizon':>8} {'slope':>10} {'t-stat':>8}")
        print("  " + "-"*30)
        for h, res in sorted(all_results.items()):
            if res is None:
                continue
            sl = res['mean_slope'].get(utility_name, np.nan)
            t  = res['t_stat'].get(utility_name, np.nan)
            sig = '***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                  else ('*' if abs(t)>1.65 else ''))
            best = ' ← most predictive' if not np.isnan(t) and \
                   abs(t) == max(abs(all_results[hh]['t_stat'].get(
                       utility_name, 0)) for hh in all_results) else ''
            print(f"  {h:>6}m {sl:>10.6f} {t:>8.2f}{sig}{best}")

    print(f"\nDone. Per-horizon EU estimates saved to eu_h*.csv")
    print(f"The horizon with the most negative significant t-stat")
    print(f"approximates the investment horizon of the marginal investor.")


if __name__ == '__main__':
    main()