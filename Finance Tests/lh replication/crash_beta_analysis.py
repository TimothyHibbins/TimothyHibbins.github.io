"""
Crash Beta vs Calm Beta Analysis
=================================

Tests whether high-beta stocks crash harder, and whether crash risk is a
distinct factor from calm-period beta.

Steps:
1. Identify crash months: Mkt-RF below threshold (e.g. -3%, -5%)
2. For each stock, estimate:
   - beta_calm: OLS beta on non-crash months (36m rolling, then average)
   - beta_crash: OLS beta on crash months only (full sample)
3. Regress beta_crash on beta_calm across stocks:
   - Slope ≈ 1, high R²: crash risk is just amplified beta (same factor)
   - Slope < 1: high-beta stocks crash less than proportionally
   - Low R²: crash risk is largely orthogonal to calm-period beta
4. Check residual crash exposure (beta_crash - predicted) against:
   - Size (number of years stock is in sample — proxy for age/liquidity)
   - Cokurtosis from the LH panel (should predict residual crash beta
     if KURT is capturing something real)
   - Sector if available
5. Report the decomposition of unconditional variance into
   calm-beta and crash-beta components
"""

import numpy as np
import pandas as pd
from pathlib import Path
import statsmodels.api as sm
import warnings
warnings.filterwarnings('ignore')

# ── Config ────────────────────────────────────────────────────────────────────
CRASH_THRESHOLD  = -0.03   # monthly Mkt-RF below this = crash month
CRASH_THRESHOLD2 = -0.05   # second, stricter threshold
MIN_CALM_OBS     = 24      # min non-crash months for calm beta estimate
MIN_CRASH_OBS    = 3       # min crash months for crash beta estimate
WINSOR           = 0.01


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def winsor(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct*100), np.nanpercentile(a, (1-pct)*100)
    return np.clip(a, lo, hi)


def ols_beta(y, x):
    """Simple OLS beta with intercept. Returns (beta, alpha, r2, n)."""
    mask = np.isfinite(y) & np.isfinite(x)
    if mask.sum() < 4:
        return np.nan, np.nan, np.nan, 0
    X = sm.add_constant(x[mask])
    res = sm.OLS(y[mask], X).fit()
    return res.params[1], res.params[0], res.rsquared, mask.sum()


def load_data():
    SR, ff, kurt_panel = None, None, None
    for p in ['stock_returns_stooq.csv',
              '/mnt/user-data/outputs/stock_returns_stooq.csv']:
        if Path(p).exists():
            SR = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
            print(f"Returns: {SR.shape[1]} stocks, {SR.shape[0]} months")
            break
    for p in ['ff_factors_cache.csv',
              '/mnt/user-data/outputs/ff_factors_cache.csv']:
        if Path(p).exists():
            ff = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
            ff = ff / 100
            print(f"FF factors: {ff.shape[0]} months")
            break
    # load cokurtosis from the LH panel if available
    for p in ['lh_comoment_panel_q.csv',
              '/mnt/user-data/outputs/lh_comoment_panel_q.csv']:
        if Path(p).exists():
            kurt_panel = pd.read_csv(p, parse_dates=['date'])
            kurt_panel['date'] = pd.to_datetime(kurt_panel['date'])\
                .dt.to_period('M').dt.to_timestamp('M')
            print(f"Comoment panel: {len(kurt_panel)} obs")
            break
    return SR, ff, kurt_panel


def estimate_betas(SR, ff):
    common = SR.index.intersection(ff.index)
    SR = SR.loc[common]; mkt = ff.loc[common, 'Mkt-RF']

    # ── identify crash months ────────────────────────────────────────────────
    crash1 = mkt[mkt <= CRASH_THRESHOLD].index
    crash2 = mkt[mkt <= CRASH_THRESHOLD2].index
    calm   = mkt[mkt > CRASH_THRESHOLD].index

    print(f"\nCrash months (Mkt-RF ≤ {CRASH_THRESHOLD:.0%}): {len(crash1)}"
          f" ({100*len(crash1)/len(mkt):.1f}% of sample)")
    print(f"Crash months (Mkt-RF ≤ {CRASH_THRESHOLD2:.0%}): {len(crash2)}"
          f" ({100*len(crash2)/len(mkt):.1f}% of sample)")
    print(f"Calm months:  {len(calm)}")

    # summary of crash periods
    print("\nWorst crash months:")
    worst = mkt.nsmallest(15)
    for dt, v in worst.items():
        print(f"  {dt.strftime('%Y-%m')}: {v*100:+.1f}%")

    mkt_calm   = mkt.loc[calm].values
    mkt_crash1 = mkt.loc[crash1].values
    mkt_crash2 = mkt.loc[crash2].values

    results = []
    for ticker in SR.columns:
        r = SR[ticker]
        r_calm   = r.loc[calm].values
        r_crash1 = r.loc[crash1].values
        r_crash2 = r.loc[crash2].values

        # winsorise
        r_calm   = winsor(r_calm[np.isfinite(r_calm)])
        r_crash1 = r_crash1[np.isfinite(r_crash1)]
        r_crash2 = r_crash2[np.isfinite(r_crash2)]
        mc_calm  = mkt_calm[:len(r_calm)]

        # calm beta (all non-crash months)
        valid_calm = np.isfinite(r.loc[calm].values)
        rc = r.loc[calm].values[valid_calm]
        mc = mkt_calm[valid_calm]
        if len(rc) < MIN_CALM_OBS:
            continue
        bc, ac, r2c, nc = ols_beta(rc, mc)

        # crash beta (threshold 1)
        valid_cr1 = np.isfinite(r.loc[crash1].values)
        rc1 = r.loc[crash1].values[valid_cr1]
        mc1 = mkt_crash1[valid_cr1]
        if len(rc1) >= MIN_CRASH_OBS:
            bcr1, _, r2cr1, ncr1 = ols_beta(rc1, mc1)
        else:
            bcr1, r2cr1, ncr1 = np.nan, np.nan, 0

        # crash beta (threshold 2)
        valid_cr2 = np.isfinite(r.loc[crash2].values)
        rc2 = r.loc[crash2].values[valid_cr2]
        mc2 = mkt_crash2[valid_cr2]
        if len(rc2) >= MIN_CRASH_OBS:
            bcr2, _, r2cr2, ncr2 = ols_beta(rc2, mc2)
        else:
            bcr2, r2cr2, ncr2 = np.nan, np.nan, 0

        # full-sample beta (for reference)
        rf = r.values[np.isfinite(r.values)]
        mf = mkt.values[np.isfinite(r.values)]
        bfull, _, r2full, _ = ols_beta(rf, mf)

        results.append({
            'ticker':    ticker.replace('.us','').upper(),
            'beta_calm': bc,
            'beta_crash1': bcr1,
            'beta_crash2': bcr2,
            'beta_full': bfull,
            'r2_calm':   r2c,
            'r2_crash1': r2cr1,
            'n_calm':    nc,
            'n_crash1':  ncr1,
            'n_crash2':  ncr2,
        })

    df = pd.DataFrame(results)
    print(f"\n{len(df)} stocks with sufficient data")
    return df, crash1, crash2, calm, mkt


def analyse(df, mkt, crash1, calm):
    """Main analysis: regress crash beta on calm beta."""
    valid = df.dropna(subset=['beta_calm','beta_crash1'])
    # remove outliers (beta outside [-2, 5] are likely data issues)
    valid = valid[(valid['beta_calm'].between(-2,5)) &
                  (valid['beta_crash1'].between(-3,6))]
    print(f"\n{len(valid)} stocks with both calm and crash beta estimates")

    # ── Key regression: crash beta ~ calm beta ────────────────────────────────
    print("\n" + "="*62)
    print("Key Test: does calm-period beta predict crash beta?")
    print("="*62)
    X = sm.add_constant(valid['beta_calm'].values)
    res = sm.OLS(valid['beta_crash1'].values, X).fit()
    slope = res.params[1]; intercept = res.params[0]
    t_slope = res.tvalues[1]; r2 = res.rsquared
    print(f"\n  beta_crash = {intercept:+.3f} + {slope:.3f} × beta_calm")
    print(f"  t(slope) = {t_slope:+.2f},  R² = {r2:.3f}")
    print(f"\n  Interpretation:")
    if r2 > 0.5 and abs(slope-1) < 0.2:
        print("  Slope ≈ 1, high R²: crash risk ≈ amplified calm beta.")
        print("  The same factor — high-beta stocks crash proportionally harder.")
    elif slope < 0.7:
        print("  Slope < 0.7: high-beta stocks crash LESS than proportionally.")
        print("  Calm beta overstates crash exposure.")
    else:
        print(f"  Slope = {slope:.2f} — partial relationship.")
    if r2 < 0.3:
        print(f"  Low R² ({r2:.2f}): crash risk is LARGELY ORTHOGONAL to calm beta.")
        print("  Crash risk is a distinct factor — knowing calm beta tells")
        print("  you little about how much a stock crashes.")
    elif r2 < 0.5:
        print(f"  Moderate R² ({r2:.2f}): crash risk is PARTIALLY distinct.")

    # ── Residual crash exposure ───────────────────────────────────────────────
    valid = valid.copy()
    valid['beta_crash_predicted'] = intercept + slope * valid['beta_calm']
    valid['crash_residual'] = valid['beta_crash1'] - valid['beta_crash_predicted']

    print(f"\n  Residual crash exposure (beta_crash - predicted):")
    print(f"  Mean:  {valid['crash_residual'].mean():+.3f}")
    print(f"  Std:   {valid['crash_residual'].std():.3f}")
    print(f"  Range: {valid['crash_residual'].min():+.3f} to "
          f"{valid['crash_residual'].max():+.3f}")

    # ── Quintile analysis ────────────────────────────────────────────────────
    print(f"\n── Crash beta by calm-beta quintile ─────────────────────────")
    valid['calm_q'] = pd.qcut(valid['beta_calm'], 5,
                               labels=['Q1\n(low)','Q2','Q3','Q4','Q5\n(high)'])
    qt = valid.groupby('calm_q', observed=True).agg(
        n=('beta_calm','count'),
        beta_calm=('beta_calm','mean'),
        beta_crash=('beta_crash1','mean'),
        crash_resid=('crash_residual','mean')
    )
    print(f"\n  {'Quintile':<10} {'n':>5} {'β_calm':>8} {'β_crash':>8} "
          f"{'resid':>8}")
    print("  " + "-"*42)
    for q, r in qt.iterrows():
        print(f"  {str(q).replace(chr(10),' '):<10} {int(r['n']):>5} "
              f"{r['beta_calm']:>8.3f} {r['beta_crash']:>8.3f} "
              f"{r['crash_resid']:>+8.3f}")

    return valid


def variance_decomposition(df, mkt, crash1, calm):
    """
    Decompose unconditional portfolio variance into calm-beta and crash
    contributions.
    """
    print(f"\n── Unconditional Variance Decomposition ─────────────────────")
    p_crash = len(crash1) / (len(crash1) + len(calm))
    p_calm  = 1 - p_crash

    mkt_var_calm  = mkt.loc[calm].var()
    mkt_var_crash = mkt.loc[crash1].var()
    mkt_var_uncond = p_calm * mkt_var_calm + p_crash * mkt_var_crash + \
                     p_calm * p_crash * (mkt.loc[calm].mean() -
                                         mkt.loc[crash1].mean())**2

    print(f"\n  Market return variance:")
    print(f"    Calm months:          {mkt_var_calm*100:.4f}% (monthly)")
    print(f"    Crash months:         {mkt_var_crash*100:.4f}%")
    print(f"    Unconditional:        {mkt_var_uncond*100:.4f}%")
    print(f"    Crash share of uncon. var: "
          f"{100*p_crash*mkt_var_crash/mkt_var_uncond:.1f}%")
    print(f"    Mean-diff share:      "
          f"{100*p_calm*p_crash*(mkt.loc[calm].mean()-mkt.loc[crash1].mean())**2/mkt_var_uncond:.1f}%")

    valid = df.dropna(subset=['beta_calm','beta_crash1'])
    valid = valid[(valid['beta_calm'].between(-2,5)) &
                  (valid['beta_crash1'].between(-3,6))]

    # For an equal-weighted portfolio:
    # Var(portfolio) = beta_ew² × Var(mkt) + idio_ew²
    # Unconditional: blend calm and crash contributions
    bc_ew  = valid['beta_calm'].mean()
    bcr_ew = valid['beta_crash1'].mean()
    print(f"\n  Equal-weighted portfolio betas:")
    print(f"    Mean calm beta:  {bc_ew:.3f}")
    print(f"    Mean crash beta: {bcr_ew:.3f}")

    contrib_calm  = p_calm  * bc_ew**2  * mkt_var_calm
    contrib_crash = p_crash * bcr_ew**2 * mkt_var_crash
    contrib_total = contrib_calm + contrib_crash
    print(f"\n  Systematic variance contributions to EW portfolio:")
    print(f"    Calm-beta component:  {contrib_calm*100:.5f}% "
          f"({100*contrib_calm/contrib_total:.1f}% of systematic)")
    print(f"    Crash-beta component: {contrib_crash*100:.5f}% "
          f"({100*contrib_crash/contrib_total:.1f}% of systematic)")


def cokurtosis_check(df, kurt_panel):
    """Check whether cokurtosis predicts residual crash exposure."""
    if kurt_panel is None:
        print("\n  (Comoment panel not available for cokurtosis check)")
        return
    print(f"\n── Cokurtosis vs Residual Crash Beta ────────────────────────")
    # average cokurtosis per stock across all quarters
    if 'ticker' in kurt_panel.columns and 'cokurt' in kurt_panel.columns:
        avg_kurt = kurt_panel.groupby('ticker')['cokurt'].mean().reset_index()
        avg_kurt.columns = ['ticker','mean_cokurt']
        valid = df.dropna(subset=['crash_residual']) if 'crash_residual' in df.columns else None
        if valid is None:
            print("  (Run analyse() first)")
            return
        merged = valid.merge(avg_kurt, on='ticker', how='inner')
        if len(merged) < 20:
            print(f"  Only {len(merged)} matches — skipping")
            return
        X = sm.add_constant(merged['mean_cokurt'].values)
        res = sm.OLS(merged['crash_residual'].values, X).fit()
        print(f"\n  crash_residual ~ mean_cokurt:")
        print(f"  slope = {res.params[1]:+.4f},  t = {res.tvalues[1]:+.2f},  "
              f"R² = {res.rsquared:.3f}")
        if res.tvalues[1] < -1.65:
            print("  High cokurtosis (fat-tailed co-movement) predicts")
            print("  HIGHER residual crash beta — cokurtosis captures")
            print("  crash-specific risk beyond calm-period beta. ✓")
        else:
            print("  Cokurtosis does not significantly predict residual crash beta.")
    else:
        print(f"  Columns available: {list(kurt_panel.columns[:8])}")


def main():
    print("Crash Beta vs Calm Beta Analysis")
    print("=" * 62)
    SR, ff, kurt_panel = load_data()
    if SR is None or ff is None:
        print("Missing data files — ensure stock_returns_stooq.csv and "
              "ff_factors_cache.csv are in the working directory.")
        return

    df, crash1, crash2, calm, mkt = estimate_betas(SR, ff)
    df_with_resid = analyse(df, mkt, crash1, calm)
    variance_decomposition(df_with_resid, mkt, crash1, calm)
    cokurtosis_check(df_with_resid, kurt_panel)

    # save results
    df_with_resid.to_csv('crash_beta_results.csv', index=False)
    print(f"\nSaved crash_beta_results.csv")
    print("\nDone.")


if __name__ == '__main__':
    main()
