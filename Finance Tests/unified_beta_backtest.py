"""
Unified Beta Backtest
=====================
Tests the theory that all factor premia reduce to a generalised beta —
the marginal contribution of an asset's return distribution to portfolio
utility, evaluated against the empirical stochastic discount factor.

Pipeline:
  1. Fetch FF5 factors + decile portfolios sorted on each characteristic
     (B/M, Size, Operating Profitability, Investment, Momentum)
  2. In rolling collection windows, estimate the SDF under power utility
     with GMM-calibrated risk aversion γ
  3. For each factor, compute SDF-implied premium for each decile bin
     using the exact pricing equation: E[M·R] = 1
     This gives a nonlinear curve: factor loading → predicted premium
  4. Also compute higher-moment exposures: downside beta, coskewness
  5. In subsequent investment windows, rank portfolios by predicted premium
  6. Evaluate: predicted vs realised premium, Sharpe ratio, vs FF5 benchmark

Data requirements (all free from Ken French's library):
  - F-F_Research_Data_5_Factors_2x3
  - F-F_Momentum_Factor
  - Portfolios_Formed_on_BE-ME       (value deciles)
  - Portfolios_Formed_on_ME          (size deciles)
  - Portfolios_Formed_on_OP          (profitability deciles)
  - Portfolios_Formed_on_INV         (investment deciles)
  - 10_Portfolios_Prior_12_2         (momentum deciles)

Usage:
    pip install pandas numpy scipy scikit-learn statsmodels requests matplotlib
    python unified_beta_backtest.py
"""

import sys, warnings
warnings.filterwarnings('ignore')

try:
    import distutils
except ImportError:
    import types
    distutils = types.ModuleType('distutils')
    distutils.version = types.ModuleType('distutils.version')
    sys.modules['distutils'] = distutils
    sys.modules['distutils.version'] = distutils.version

import pandas as pd
import numpy as np
from scipy.optimize import minimize_scalar, minimize
from scipy import stats
import statsmodels.api as sm
import requests, zipfile, io, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec


# ══════════════════════════════════════════════════════════════════════════════
# 1.  DATA
# ══════════════════════════════════════════════════════════════════════════════

FF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
HEADERS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}

def _get_zip(filename):
    url = f"{FF_BASE}/{filename}_CSV.zip"
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    return zf.read(zf.namelist()[0]).decode('utf-8', errors='replace')

def _parse_monthly(content, n_cols):
    """Extract the first monthly data block from an FF CSV."""
    lines   = content.split('\n')
    rows    = []
    in_data = False
    for line in lines:
        s = line.strip().rstrip(',')
        if not s:
            if in_data:
                break
            continue
        parts = [p.strip() for p in s.split(',')]
        parts = [p for p in parts if p]
        if parts and parts[0].isdigit() and len(parts[0]) == 6:
            in_data = True
            if len(parts) >= n_cols:
                rows.append(parts[:n_cols])
        elif in_data:
            break
    return rows

def _make_df(rows, cols):
    df = pd.DataFrame(rows, columns=cols)
    df['Date'] = pd.to_datetime(df['Date'].str.strip(), format='%Y%m')
    df = df.set_index('Date').astype(float)
    df = df.replace(-99.99, np.nan).replace(-999., np.nan)
    return df

def fetch_all_data():
    print("Fetching data from Ken French's library...")

    # FF5 factors
    rows = _parse_monthly(_get_zip('F-F_Research_Data_5_Factors_2x3'), 7)
    factors = _make_df(rows, ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
    print("  ✓ FF5 factors")

    # Momentum factor
    rows = _parse_monthly(_get_zip('F-F_Momentum_Factor'), 2)
    mom_factor = _make_df(rows, ['Date','MOM'])
    print("  ✓ Momentum factor")

    # Decile portfolios for each characteristic — value-weighted returns
    # Each file has multiple tables; we want the first (value-weighted) monthly block
    decile_files = {
        'value':  ('Portfolios_Formed_on_BE-ME', 11),   # date + 10 deciles
        'size':   ('Portfolios_Formed_on_ME',    11),
        'prof':   ('Portfolios_Formed_on_OP',    11),
        'inv':    ('Portfolios_Formed_on_INV',   11),
        'mom':    ('10_Portfolios_Prior_12_2',   11),
    }

    deciles = {}
    for name, (fname, ncols) in decile_files.items():
        rows = _parse_monthly(_get_zip(fname), ncols)
        cols = ['Date'] + [f'D{i+1}' for i in range(10)]
        deciles[name] = _make_df(rows, cols)
        print(f"  ✓ {name} deciles")

    return factors, mom_factor, deciles


# ══════════════════════════════════════════════════════════════════════════════
# 2.  SDF ESTIMATION  (power utility)
# ══════════════════════════════════════════════════════════════════════════════

def estimate_sdf(factors_window, deciles_window, gamma_grid=(2, 5, 10)):
    """
    Estimate the power-utility SDF:  M_t = (1 + R_m,t)^{-γ}
    where R_m is the market gross return.

    We choose γ by minimising the average absolute pricing error
    E[M·R_i] - 1 across all available decile portfolios.

    Returns: γ_hat, M series, pricing errors by γ
    """
    rf    = factors_window['RF'] / 100
    mkt   = factors_window['Mkt-RF'] / 100
    R_mkt = mkt + rf           # gross excess → gross return (approx)

    # Collect all decile return series aligned to window
    all_rets = []
    for name, df in deciles_window.items():
        for col in df.columns:
            s = df[col].dropna() / 100
            idx = s.index.intersection(R_mkt.index)
            if len(idx) > 12:
                all_rets.append(s.loc[idx])

    def pricing_error(gamma):
        M = (1 + R_mkt) ** (-gamma)
        errors = []
        for r in all_rets:
            idx = M.index.intersection(r.index)
            if len(idx) < 12:
                continue
            gross_r = 1 + r.loc[idx] + rf.loc[idx]
            err = np.abs(np.mean(M.loc[idx] * gross_r) - 1)
            errors.append(err)
        return np.mean(errors) if errors else 1e6

    # Grid search then refine
    errors = {g: pricing_error(g) for g in gamma_grid}
    best_gamma = min(errors, key=errors.get)

    # Refine around best
    res = minimize_scalar(pricing_error,
                          bounds=(max(0.5, best_gamma-3), best_gamma+5),
                          method='bounded')
    gamma_hat = res.x

    M = (1 + R_mkt) ** (-gamma_hat)
    return gamma_hat, M, errors


# ══════════════════════════════════════════════════════════════════════════════
# 3.  PREMIUM PREDICTION
# ══════════════════════════════════════════════════════════════════════════════

def compute_decile_moments(ret_series, mkt_series, rf_series):
    """
    Compute return distribution moments and risk measures for a decile portfolio.
    Returns dict of: mean, std, skew, kurt, downside_beta, coskewness, sdf_premium
    """
    idx = ret_series.index.intersection(mkt_series.index)
    r   = ret_series.loc[idx] / 100
    rm  = mkt_series.loc[idx] / 100
    rf  = rf_series.loc[idx]  / 100

    r_excess  = r  - rf
    rm_excess = rm - rf

    # Standard moments
    mu    = r_excess.mean()
    sigma = r_excess.std()
    skew  = stats.skew(r_excess.dropna())
    kurt  = stats.kurtosis(r_excess.dropna())

    # Standard beta
    cov_matrix = np.cov(r_excess, rm_excess)
    beta = cov_matrix[0,1] / cov_matrix[1,1] if cov_matrix[1,1] > 0 else np.nan

    # Downside beta: beta estimated on months where market is below its mean
    below_mean = rm_excess < rm_excess.mean()
    r_down  = r_excess[below_mean]
    rm_down = rm_excess[below_mean]
    if len(r_down) > 10:
        cov_down = np.cov(r_down, rm_down)
        down_beta = cov_down[0,1] / cov_down[1,1] if cov_down[1,1] > 0 else np.nan
    else:
        down_beta = np.nan

    # Coskewness: E[(r-μ)(rm-μm)²] / σm²
    demeaned_r  = r_excess  - r_excess.mean()
    demeaned_rm = rm_excess - rm_excess.mean()
    coskew = np.mean(demeaned_r * demeaned_rm**2) / (rm_excess.std()**2 + 1e-10)

    return {
        'mean_excess':  mu,
        'std':          sigma,
        'skewness':     skew,
        'kurtosis':     kurt,
        'beta':         beta,
        'down_beta':    down_beta,
        'coskewness':   coskew,
    }


def predict_premiums(M, factors_window, deciles_window):
    """
    For each factor's decile portfolios, compute:
      1. The SDF-implied premium using E[M·R] = 1  →  E[R] = 1/E[M] - Cov(M,R)/E[M]
      2. Distribution moments and higher-moment risk measures

    Returns DataFrame: one row per (factor, decile), columns = moments + predicted_premium
    """
    rf    = factors_window['RF'] / 100
    mkt   = factors_window['Mkt-RF'] / 100

    rows = []
    for fname, ddf in deciles_window.items():
        for i, col in enumerate(ddf.columns):  # D1 .. D10
            s = ddf[col].dropna() / 100
            idx = s.index.intersection(M.index).intersection(rf.index)
            if len(idx) < 24:
                continue

            r      = s.loc[idx]
            M_     = M.loc[idx]
            rf_    = rf.loc[idx]
            gross_r = 1 + r + rf_   # gross return

            # SDF pricing equation: predicted premium = 1/E[M] - 1/rf - Cov(M,R)/E[M]
            EM     = M_.mean()
            cov_MR = np.cov(M_, gross_r)[0,1]
            sdf_predicted_premium = (-cov_MR / EM) * 12  # annualised

            # Moments
            moments = compute_decile_moments(
                ddf[col].loc[idx] * 100,   # back to % for function
                (mkt.loc[idx] * 100),
                (rf.loc[idx] * 100)
            )

            rows.append({
                'factor':            fname,
                'decile':            i + 1,
                'sdf_predicted':     sdf_predicted_premium,
                'realised_mean':     (r - rf_).mean() * 12,   # annualised
                **moments
            })

    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════════════════════
# 4.  ROLLING WINDOW BACKTEST
# ══════════════════════════════════════════════════════════════════════════════

def run_backtest(factors, mom_factor, deciles,
                 collection_years=5, investment_years=1):
    """
    Walk-forward backtest:
      - Fit SDF and predict premiums in collection window
      - Evaluate predictions in subsequent investment window
      - Repeat, stepping forward by investment_years
    """
    # Align everything
    all_factors = pd.concat([factors, mom_factor], axis=1)
    common_start = max(df.index.min() for df in [all_factors] + list(deciles.values()))
    common_end   = min(df.index.max() for df in [all_factors] + list(deciles.values()))

    results = []
    start = common_start

    while True:
        coll_end  = start + pd.DateOffset(years=collection_years)
        inv_end   = coll_end + pd.DateOffset(years=investment_years)

        if inv_end > common_end:
            break

        # Slice windows
        f_coll  = all_factors.loc[start:coll_end]
        f_inv   = all_factors.loc[coll_end:inv_end]
        d_coll  = {k: v.loc[start:coll_end]  for k,v in deciles.items()}
        d_inv   = {k: v.loc[coll_end:inv_end] for k,v in deciles.items()}

        if len(f_coll) < collection_years * 10:
            start += pd.DateOffset(years=investment_years)
            continue

        # Estimate SDF in collection window
        gamma, M_coll, gamma_errors = estimate_sdf(f_coll, d_coll)

        # Predict premiums from collection window
        preds = predict_premiums(M_coll, f_coll, d_coll)
        if preds.empty:
            start += pd.DateOffset(years=investment_years)
            continue

        # Compute realised premiums in investment window
        rf_inv = all_factors.loc[coll_end:inv_end, 'RF'] / 100
        for _, row in preds.iterrows():
            fname  = row['factor']
            decile = int(row['decile'])
            col    = f'D{decile}'
            if fname not in d_inv or col not in d_inv[fname].columns:
                continue
            s   = d_inv[fname][col].dropna() / 100
            idx = s.index.intersection(rf_inv.index)
            if len(idx) < 3:
                continue
            realised = (s.loc[idx] - rf_inv.loc[idx]).mean() * 12

            results.append({
                'window_start':      start,
                'window_coll_end':   coll_end,
                'window_inv_end':    inv_end,
                'factor':            fname,
                'decile':            decile,
                'gamma':             gamma,
                'sdf_predicted':     row['sdf_predicted'],
                'beta':              row['beta'],
                'down_beta':         row['down_beta'],
                'coskewness':        row['coskewness'],
                'skewness':          row['skewness'],
                'kurtosis':          row['kurtosis'],
                'realised':          realised,
                'collection_years':  collection_years,
            })

        start += pd.DateOffset(years=investment_years)

    return pd.DataFrame(results)


# ══════════════════════════════════════════════════════════════════════════════
# 5.  EVALUATION
# ══════════════════════════════════════════════════════════════════════════════

def evaluate(results_df):
    """
    Evaluate prediction quality:
      1. Correlation of predicted vs realised premium overall and by factor
      2. Whether the SDF curve is nonlinear (compare to linear beta prediction)
      3. Whether higher moments (downside beta, coskewness) add predictive power
      4. Sharpe ratio of a strategy that goes long high-predicted-premium deciles
    """
    df = results_df.dropna(subset=['sdf_predicted','realised'])

    print("\n── Overall Prediction Quality ───────────────────────────────────")
    corr_sdf  = df['sdf_predicted'].corr(df['realised'])
    corr_beta = df['beta'].corr(df['realised'])
    corr_db   = df['down_beta'].corr(df['realised'])
    corr_cs   = df['coskewness'].corr(df['realised'])
    print(f"  SDF-predicted vs realised:     r = {corr_sdf:+.4f}")
    print(f"  Standard beta vs realised:     r = {corr_beta:+.4f}")
    print(f"  Downside beta vs realised:     r = {corr_db:+.4f}")
    print(f"  Coskewness vs realised:        r = {corr_cs:+.4f}")

    print("\n── Prediction Quality by Factor ─────────────────────────────────")
    print(f"  {'Factor':<8}  {'SDF corr':>9}  {'Beta corr':>9}  {'N windows':>10}")
    print("  " + "-" * 44)
    for fname, grp in df.groupby('factor'):
        c_sdf  = grp['sdf_predicted'].corr(grp['realised'])
        c_beta = grp['beta'].corr(grp['realised'])
        print(f"  {fname:<8}  {c_sdf:>+9.4f}  {c_beta:>+9.4f}  {len(grp):>10d}")

    print("\n── Regression: What predicts realised premium? ──────────────────")
    sub = df[['realised','sdf_predicted','beta','down_beta','coskewness',
              'skewness','kurtosis']].dropna()

    # Model 1: beta only
    X1 = sm.add_constant(sub[['beta']])
    r1 = sm.OLS(sub['realised'], X1).fit()

    # Model 2: SDF predicted only
    X2 = sm.add_constant(sub[['sdf_predicted']])
    r2 = sm.OLS(sub['realised'], X2).fit()

    # Model 3: SDF + higher moments
    X3 = sm.add_constant(sub[['sdf_predicted','down_beta','coskewness','skewness','kurtosis']])
    r3 = sm.OLS(sub['realised'], X3).fit()

    print(f"  Beta only:              R² = {r1.rsquared:.4f}  coef = {r1.params['beta']:+.4f} (t={r1.tvalues['beta']:+.2f})")
    print(f"  SDF predicted only:     R² = {r2.rsquared:.4f}  coef = {r2.params['sdf_predicted']:+.4f} (t={r2.tvalues['sdf_predicted']:+.2f})")
    print(f"  SDF + higher moments:   R² = {r3.rsquared:.4f}")
    for v in ['sdf_predicted','down_beta','coskewness','skewness','kurtosis']:
        print(f"    {v:<16} coef={r3.params[v]:+.4f}  t={r3.tvalues[v]:+.2f}")

    print("\n── Nonlinearity Test: Is the SDF curve nonlinear? ───────────────")
    # Test whether SDF² adds over SDF alone
    sub2 = sub.copy()
    sub2['sdf_sq'] = sub2['sdf_predicted'] ** 2
    X4 = sm.add_constant(sub2[['sdf_predicted','sdf_sq']])
    r4 = sm.OLS(sub2['realised'], X4).fit()
    print(f"  Adding SDF²:  R² = {r4.rsquared:.4f}  coef(SDF²) = {r4.params['sdf_sq']:+.4f} (t={r4.tvalues['sdf_sq']:+.2f})")
    print(f"  (Significant t on SDF² → pricing curve is nonlinear)")

    print("\n── Strategy Sharpe Ratios ───────────────────────────────────────")
    # Long top-3 deciles by predicted premium, equal weight, each factor separately
    for fname, grp in df.groupby('factor'):
        windows = grp['window_coll_end'].unique()
        strategy_rets = []
        for w in windows:
            wg = grp[grp['window_coll_end'] == w].sort_values('sdf_predicted', ascending=False)
            top = wg.head(3)['realised'].mean()
            bot = wg.tail(3)['realised'].mean()
            strategy_rets.append(top - bot)  # long-short
        if len(strategy_rets) > 3:
            sr = np.mean(strategy_rets) / (np.std(strategy_rets) + 1e-8)
            print(f"  {fname:<8} long-short Sharpe: {sr:+.3f}  (mean spread: {np.mean(strategy_rets)*100:+.2f}%)")

    return df, r1, r2, r3


# ══════════════════════════════════════════════════════════════════════════════
# 6.  ROBUSTNESS: MULTIPLE WINDOW LENGTHS
# ══════════════════════════════════════════════════════════════════════════════

def robustness_check(factors, mom_factor, deciles):
    print("\n── Robustness: Multiple Window Lengths ──────────────────────────")
    print(f"  {'Coll yrs':>9}  {'SDF corr':>9}  {'Beta corr':>9}  {'N obs':>7}")
    print("  " + "-" * 42)

    summary = []
    for coll_yrs in [3, 5, 10]:
        df = run_backtest(factors, mom_factor, deciles,
                          collection_years=coll_yrs, investment_years=1)
        if df.empty:
            print(f"  {coll_yrs:>9}  (insufficient data)")
            continue
        sub = df.dropna(subset=['sdf_predicted','realised'])
        c_sdf  = sub['sdf_predicted'].corr(sub['realised'])
        c_beta = sub['beta'].corr(sub['realised'])
        print(f"  {coll_yrs:>9}  {c_sdf:>+9.4f}  {c_beta:>+9.4f}  {len(sub):>7d}")
        summary.append({'coll_yrs': coll_yrs, 'sdf_corr': c_sdf,
                        'beta_corr': c_beta, 'n': len(sub), 'results': df})

    return summary


# ══════════════════════════════════════════════════════════════════════════════
# 7.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(results_df, outpath='unified_beta_results.png'):
    df = results_df.dropna(subset=['sdf_predicted','realised'])

    fig = plt.figure(figsize=(16, 12))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.45, wspace=0.35)

    # 1. SDF predicted vs realised (scatter by factor)
    ax1 = fig.add_subplot(gs[0, :2])
    colors = plt.cm.tab10(np.linspace(0, 1, df['factor'].nunique()))
    for (fname, grp), c in zip(df.groupby('factor'), colors):
        ax1.scatter(grp['sdf_predicted']*100, grp['realised']*100,
                    label=fname, alpha=0.6, s=30, color=c)
    lo = min(df['sdf_predicted'].min(), df['realised'].min()) * 100 - 1
    hi = max(df['sdf_predicted'].max(), df['realised'].max()) * 100 + 1
    ax1.plot([lo, hi], [lo, hi], 'k--', lw=1, alpha=0.4, label='45° line')
    ax1.set_xlabel('SDF-Predicted Premium (%)')
    ax1.set_ylabel('Realised Premium (%)')
    ax1.set_title('SDF-Predicted vs Realised Premium')
    ax1.legend(fontsize=7, ncol=2)

    # 2. Pricing curve per factor (decile on x, predicted premium on y)
    ax2 = fig.add_subplot(gs[0, 2])
    for (fname, grp), c in zip(df.groupby('factor'), colors):
        curve = grp.groupby('decile')['sdf_predicted'].mean() * 100
        ax2.plot(curve.index, curve.values, marker='o', markersize=4,
                 label=fname, color=c)
    ax2.set_xlabel('Decile')
    ax2.set_ylabel('Mean Predicted Premium (%)')
    ax2.set_title('Nonlinear Pricing Curves by Factor')
    ax2.legend(fontsize=7)

    # 3. Beta vs realised
    ax3 = fig.add_subplot(gs[1, 0])
    ax3.scatter(df['beta'], df['realised']*100, alpha=0.3, s=15, c='steelblue')
    ax3.set_xlabel('Beta'); ax3.set_ylabel('Realised Premium (%)')
    ax3.set_title('Beta vs Realised (CAPM)')

    # 4. SDF vs realised
    ax4 = fig.add_subplot(gs[1, 1])
    ax4.scatter(df['sdf_predicted']*100, df['realised']*100,
                alpha=0.3, s=15, c='darkorange')
    ax4.set_xlabel('SDF Predicted (%)'); ax4.set_ylabel('Realised Premium (%)')
    ax4.set_title('SDF vs Realised (Unified Beta)')

    # 5. Downside beta vs realised
    ax5 = fig.add_subplot(gs[1, 2])
    ax5.scatter(df['down_beta'], df['realised']*100, alpha=0.3, s=15, c='green')
    ax5.set_xlabel('Downside Beta'); ax5.set_ylabel('Realised Premium (%)')
    ax5.set_title('Downside Beta vs Realised')

    # 6. Coskewness vs realised
    ax6 = fig.add_subplot(gs[2, 0])
    ax6.scatter(df['coskewness'], df['realised']*100, alpha=0.3, s=15, c='purple')
    ax6.set_xlabel('Coskewness'); ax6.set_ylabel('Realised Premium (%)')
    ax6.set_title('Coskewness vs Realised')

    # 7. Gamma estimates over time
    ax7 = fig.add_subplot(gs[2, 1])
    gamma_ts = results_df.groupby('window_coll_end')['gamma'].mean()
    ax7.plot(gamma_ts.index, gamma_ts.values, color='crimson')
    ax7.axhline(gamma_ts.mean(), ls='--', color='gray', lw=1)
    ax7.set_xlabel('Window End'); ax7.set_ylabel('γ (risk aversion)')
    ax7.set_title('Estimated Risk Aversion Over Time')

    # 8. Rolling prediction correlation
    ax8 = fig.add_subplot(gs[2, 2])
    roll_corr = []
    windows = sorted(results_df['window_coll_end'].unique())
    for w in windows:
        sub = results_df[results_df['window_coll_end'] <= w].dropna(
            subset=['sdf_predicted','realised'])
        if len(sub) > 20:
            roll_corr.append((w, sub['sdf_predicted'].corr(sub['realised'])))
    if roll_corr:
        wdates, corrs = zip(*roll_corr)
        ax8.plot(wdates, corrs, color='teal')
        ax8.axhline(0, ls='--', color='gray', lw=1)
        ax8.set_xlabel('Window End')
        ax8.set_ylabel('Cumulative Prediction Correlation')
        ax8.set_title('SDF Prediction Correlation Over Time')

    fig.suptitle('Unified Beta Backtest: SDF vs CAPM vs Higher Moments',
                 fontsize=13, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved to: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 8.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 65)
    print("Unified Beta Backtest")
    print("Nonlinear SDF pricing vs CAPM beta vs higher moments")
    print("=" * 65)

    # Fetch
    factors, mom_factor, deciles = fetch_all_data()

    # Main backtest (5-year collection windows)
    print("\nRunning main backtest (5-year collection windows)...")
    results = run_backtest(factors, mom_factor, deciles,
                           collection_years=5, investment_years=1)

    if results.empty:
        print("No results — check data availability.")
        return

    print(f"  {len(results)} observations across "
          f"{results['window_coll_end'].nunique()} windows")
    print(f"  Gamma range: {results['gamma'].min():.2f} – {results['gamma'].max():.2f}")
    print(f"  Mean gamma:  {results['gamma'].mean():.2f}")

    # Evaluate
    df_eval, r_beta, r_sdf, r_full = evaluate(results)

    # Robustness
    robustness_check(factors, mom_factor, deciles)

    # Plots
    print("\nGenerating plots...")
    make_plots(results, outpath='unified_beta_results.png')

    print("\n" + "=" * 65)
    print("Key question: is SDF-predicted r² > beta-only r²?")
    print(f"  Beta only R²:       {r_beta.rsquared:.4f}")
    print(f"  SDF predicted R²:   {r_sdf.rsquared:.4f}")
    print(f"  Full model R²:      {r_full.rsquared:.4f}")
    delta = r_sdf.rsquared - r_beta.rsquared
    if delta > 0.02:
        print(f"  → SDF adds {delta:.4f} R² over raw beta — supports unified beta theory")
    elif delta > 0:
        print(f"  → SDF marginally better ({delta:.4f} R²) — weak support")
    else:
        print(f"  → SDF does not outperform beta ({delta:.4f} R²) — theory not confirmed")
    print("=" * 65)
    print("\nDone.")


if __name__ == '__main__':
    main()
