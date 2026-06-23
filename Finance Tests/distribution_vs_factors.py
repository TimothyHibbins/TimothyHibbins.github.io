"""
Distribution vs Factors Test
=============================
Tests whether return distribution moments (std, skewness, kurtosis,
downside beta, coskewness) absorb the explanatory power of FF5 factors
in cross-sectional return prediction.

The theory: if factors are proxies for return distribution shape
interacting with investor utility, then controlling for distribution
moments should cause factor loadings to shrink toward zero.

Test structure:
  For each decile portfolio sorted on each FF characteristic:
    1. Compute factor loadings (betas on FF5 + momentum factors)
    2. Compute return distribution moments
    3. Run three cross-sectional regressions:
         Model A: E[R] ~ factor loadings only
         Model B: E[R] ~ distribution moments only
         Model C: E[R] ~ factor loadings + distribution moments
    4. Compare: do factor coefficients shrink in Model C vs A?
       Does Model B approach Model A in R²?

Data: Ken French decile portfolios (all free, no WRDS needed)
  - Portfolios_Formed_on_BE-ME  (value deciles)
  - Portfolios_Formed_on_ME     (size deciles)
  - Portfolios_Formed_on_OP     (profitability deciles)
  - Portfolios_Formed_on_INV    (investment deciles)
  - 10_Portfolios_Prior_12_2    (momentum deciles)
  - 49_Industry_Portfolios      (independent test assets)
  - F-F_Research_Data_5_Factors_2x3
  - F-F_Momentum_Factor

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python distribution_vs_factors.py
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
from scipy import stats
import statsmodels.api as sm
import requests, zipfile, io
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
    lines, rows, in_data = content.split('\n'), [], False
    for line in lines:
        s = line.strip().rstrip(',')
        if not s:
            if in_data: break
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
    return df.replace(-99.99, np.nan).replace(-999., np.nan)

def fetch_data():
    print("Fetching data...")

    rows = _parse_monthly(_get_zip('F-F_Research_Data_5_Factors_2x3'), 7)
    factors = _make_df(rows, ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
    print("  ✓ FF5 factors")

    rows = _parse_monthly(_get_zip('F-F_Momentum_Factor'), 2)
    mom = _make_df(rows, ['Date','MOM'])
    print("  ✓ Momentum factor")

    decile_specs = {
        'value': ('Portfolios_Formed_on_BE-ME', 11),
        'size':  ('Portfolios_Formed_on_ME',    11),
        'prof':  ('Portfolios_Formed_on_OP',    11),
        'inv':   ('Portfolios_Formed_on_INV',   11),
        'mom':   ('10_Portfolios_Prior_12_2',   11),
    }
    deciles = {}
    for name, (fname, nc) in decile_specs.items():
        rows = _parse_monthly(_get_zip(fname), nc)
        cols = ['Date'] + [f'D{i+1}' for i in range(10)]
        deciles[name] = _make_df(rows, cols)
        print(f"  ✓ {name} deciles")

    rows = _parse_monthly(_get_zip('49_Industry_Portfolios'), 50)
    industries = _make_df(rows, ['Date'] + [f'Ind{i+1}' for i in range(49)])
    print("  ✓ 49 industry portfolios")

    return factors, mom, deciles, industries


# ══════════════════════════════════════════════════════════════════════════════
# 2.  COMPUTE PORTFOLIO CHARACTERISTICS
# ══════════════════════════════════════════════════════════════════════════════

def compute_characteristics(ret_series, factors_df, label=''):
    """
    For a single portfolio return series, compute:
      - Factor loadings (FF5 + momentum) via time-series OLS
      - Return distribution moments
      - Higher-moment risk measures

    Returns a dict of all characteristics plus mean excess return.
    """
    # Align
    idx = ret_series.index\
            .intersection(factors_df.index)\
            .dropna()
    ret_series = ret_series.loc[idx].dropna()
    idx = ret_series.index.intersection(factors_df.index)
    if len(idx) < 60:   # need at least 5 years
        return None

    r   = ret_series.loc[idx] / 100        # decimal returns
    rf  = factors_df.loc[idx, 'RF'] / 100
    mkt = factors_df.loc[idx, 'Mkt-RF'] / 100
    smb = factors_df.loc[idx, 'SMB'] / 100
    hml = factors_df.loc[idx, 'HML'] / 100
    rmw = factors_df.loc[idx, 'RMW'] / 100
    cma = factors_df.loc[idx, 'CMA'] / 100
    mom_col = factors_df.loc[idx, 'MOM'] / 100 if 'MOM' in factors_df.columns else pd.Series(0, index=idx)

    r_exc  = r - rf
    rm_exc = mkt

    # ── Factor loadings via OLS ───────────────────────────────────────────────
    X_factors = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_col
    }))
    reg = sm.OLS(r_exc, X_factors).fit()
    loadings = {f'load_{k}': reg.params[k] for k in
                ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}
    factor_r2 = reg.rsquared

    # ── Distribution moments ──────────────────────────────────────────────────
    sigma  = r_exc.std()
    skew   = float(stats.skew(r_exc.dropna()))
    kurt   = float(stats.kurtosis(r_exc.dropna()))   # excess kurtosis

    # Standard beta (redundant with loading but kept for clarity)
    beta = np.cov(r_exc, rm_exc)[0,1] / (rm_exc.var() + 1e-12)

    # Downside beta: beta on months where market < mean
    down_mask  = rm_exc < rm_exc.mean()
    r_down     = r_exc[down_mask]
    rm_down    = rm_exc[down_mask]
    if len(r_down) > 20:
        down_beta = np.cov(r_down, rm_down)[0,1] / (rm_down.var() + 1e-12)
    else:
        down_beta = np.nan

    # Upside beta: beta on months where market >= mean
    up_mask   = ~down_mask
    r_up      = r_exc[up_mask]
    rm_up     = rm_exc[up_mask]
    if len(r_up) > 20:
        up_beta = np.cov(r_up, rm_up)[0,1] / (rm_up.var() + 1e-12)
    else:
        up_beta = np.nan

    # Beta asymmetry: downside beta - upside beta (key higher-moment measure)
    beta_asym = (down_beta - up_beta) if (
        not np.isnan(down_beta) and not np.isnan(up_beta)) else np.nan

    # Coskewness: E[(r-μr)(rm-μm)²] / σm²  (Harvey & Siddique 2000)
    dr  = r_exc  - r_exc.mean()
    drm = rm_exc - rm_exc.mean()
    coskew = float(np.mean(dr * drm**2) / (rm_exc.std()**2 + 1e-12))

    # Cokurtosis: E[(r-μr)(rm-μm)³] / σm³
    cokurt = float(np.mean(dr * drm**3) / (rm_exc.std()**3 + 1e-12))

    # Value at Risk (5th percentile) — captures tail loss
    var_5 = float(np.percentile(r_exc.dropna(), 5))

    # Mean excess return (the thing we're trying to predict)
    mean_excess = float(r_exc.mean() * 12)   # annualised

    return {
        'label':       label,
        'mean_excess': mean_excess,
        'n_obs':       len(idx),
        # Factor loadings
        **loadings,
        'factor_r2':   factor_r2,
        # Distribution moments
        'sigma':       float(sigma),
        'skewness':    skew,
        'kurtosis':    kurt,
        # Higher-moment risk
        'beta':        float(beta),
        'down_beta':   float(down_beta) if not np.isnan(down_beta) else np.nan,
        'up_beta':     float(up_beta)   if not np.isnan(up_beta)   else np.nan,
        'beta_asym':   float(beta_asym) if not np.isnan(beta_asym) else np.nan,
        'coskewness':  coskew,
        'cokurtosis':  cokurt,
        'var_5pct':    var_5,
    }


def build_cross_section(factors_all, deciles, industries):
    """
    Build cross-sectional dataset: one row per portfolio,
    columns = mean excess return + factor loadings + distribution moments.
    """
    all_factors = factors_all.copy()
    rows = []

    # Decile portfolios
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_characteristics(s.loc[idx], all_factors.loc[idx],
                                          label=f'{fname}_{col}')
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)

    # Industry portfolios (independent test assets)
    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_characteristics(s.loc[idx], all_factors.loc[idx],
                                      label=f'ind_{col}')
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)

    df = pd.DataFrame(rows)
    print(f"\nCross-section: {len(df)} portfolios "
          f"({(df.portfolio_type=='decile').sum()} decile, "
          f"{(df.portfolio_type=='industry').sum()} industry)")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 3.  CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML','load_RMW','load_CMA','load_MOM']
MOMENT_VARS = ['sigma','skewness','kurtosis','down_beta','beta_asym',
               'coskewness','cokurtosis','var_5pct']

def run_cross_sectional(df, label='All portfolios'):
    """
    Run three models and report coefficient shrinkage and R² comparison.
    """
    sub = df.dropna(subset=['mean_excess'] + FACTOR_VARS + MOMENT_VARS)
    y   = sub['mean_excess']

    print(f"\n{'='*65}")
    print(f"Cross-sectional regressions: {label}  (N={len(sub)})")
    print(f"{'='*65}")

    # Model A: factor loadings only
    Xa = sm.add_constant(sub[FACTOR_VARS])
    ra = sm.OLS(y, Xa).fit()

    # Model B: distribution moments only
    Xb = sm.add_constant(sub[MOMENT_VARS])
    rb = sm.OLS(y, Xb).fit()

    # Model C: loadings + moments
    Xc = sm.add_constant(sub[FACTOR_VARS + MOMENT_VARS])
    rc = sm.OLS(y, Xc).fit()

    # ── R² comparison ─────────────────────────────────────────────────────────
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  Model A (factors only):            R² = {ra.rsquared:.4f}")
    print(f"  Model B (moments only):            R² = {rb.rsquared:.4f}")
    print(f"  Model C (factors + moments):       R² = {rc.rsquared:.4f}")
    pct_captured = rb.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
    print(f"\n  Moments capture {pct_captured:.1f}% of factors' R²")
    print(f"  (100% → distribution fully explains what factors explain)")

    # ── Factor coefficient shrinkage ──────────────────────────────────────────
    print(f"\n── Factor Coefficient Shrinkage: A → C ──────────────────────────")
    print(f"  {'Variable':<14} {'Model A coef':>13} {'Model C coef':>13} "
          f"{'Shrinkage':>10} {'A t-stat':>9} {'C t-stat':>9}")
    print("  " + "-" * 72)
    for v in FACTOR_VARS:
        ca  = ra.params.get(v, np.nan)
        cc  = rc.params.get(v, np.nan)
        ta  = ra.tvalues.get(v, np.nan)
        tc  = rc.tvalues.get(v, np.nan)
        shrink = (1 - abs(cc)/abs(ca))*100 if abs(ca) > 1e-10 else np.nan
        sig_a = '*' if abs(ta) > 2 else ' '
        sig_c = '*' if abs(tc) > 2 else ' '
        print(f"  {v:<14} {ca:>+13.4f} {cc:>+13.4f} "
              f"{shrink:>9.1f}% {ta:>+8.2f}{sig_a} {tc:>+8.2f}{sig_c}")

    # ── Moment coefficients in Model C ────────────────────────────────────────
    print(f"\n── Distribution Moment Coefficients (Model C) ───────────────────")
    print(f"  {'Variable':<14} {'Coef':>10} {'t-stat':>8}  Significant?")
    print("  " + "-" * 46)
    for v in MOMENT_VARS:
        c = rc.params.get(v, np.nan)
        t = rc.tvalues.get(v, np.nan)
        sig = '*** yes' if abs(t) > 3 else ('*   yes' if abs(t) > 2 else '    no')
        print(f"  {v:<14} {c:>+10.4f} {t:>+8.2f}  {sig}")

    # ── Incremental F-test: do moments add over factors? ─────────────────────
    print(f"\n── Incremental F-test: Do moments add over factors? ─────────────")
    delta_r2  = rc.rsquared - ra.rsquared
    n, k_c, k_a = len(sub), len(rc.params), len(ra.params)
    f_stat = (delta_r2 / (k_c - k_a)) / ((1 - rc.rsquared) / (n - k_c))
    from scipy.stats import f as f_dist
    p_val = 1 - f_dist.cdf(f_stat, k_c - k_a, n - k_c)
    print(f"  ΔR² = {delta_r2:.4f}  F = {f_stat:.2f}  p = {p_val:.4f}")
    if p_val < 0.01:
        print("  → Moments add significant explanatory power over factors alone")
    else:
        print("  → Moments do not add significantly over factors alone")

    # ── Incremental F-test: do factors add over moments? ─────────────────────
    print(f"\n── Incremental F-test: Do factors add over moments? ─────────────")
    delta_r2b = rc.rsquared - rb.rsquared
    k_b = len(rb.params)
    f_stat_b = (delta_r2b / (k_c - k_b)) / ((1 - rc.rsquared) / (n - k_c))
    p_val_b = 1 - f_dist.cdf(f_stat_b, k_c - k_b, n - k_c)
    print(f"  ΔR² = {delta_r2b:.4f}  F = {f_stat_b:.2f}  p = {p_val_b:.4f}")
    if p_val_b < 0.01:
        print("  → Factors retain significant power beyond distribution moments")
        print("    (factors are NOT fully absorbed by distribution shape)")
    else:
        print("  → Factors add nothing beyond distribution moments")
        print("    (factors ARE fully absorbed by distribution shape)")

    return ra, rb, rc, sub


# ══════════════════════════════════════════════════════════════════════════════
# 4.  ROLLING WINDOW VERSION (time-varying)
# ══════════════════════════════════════════════════════════════════════════════

def rolling_shrinkage(factors_all, deciles, industries,
                      window_years=10, step_years=5):
    """
    Repeat the cross-sectional test in rolling windows to check
    whether the shrinkage is stable over time.
    """
    print(f"\n── Rolling Shrinkage Analysis ({window_years}yr windows) ─────────────────")
    print(f"  {'Window end':>12}  {'A R²':>7}  {'B R²':>7}  {'C R²':>7}  "
          f"{'B/A %':>7}  {'F add?':>6}")
    print("  " + "-" * 60)

    all_factors = factors_all.copy()
    start_date = all_factors.index.min()
    end_date   = all_factors.index.max()

    current = start_date + pd.DateOffset(years=window_years)
    rows = []

    while current <= end_date:
        win_start = current - pd.DateOffset(years=window_years)

        # Slice all data to window
        f_win = all_factors.loc[win_start:current]
        d_win = {k: v.loc[win_start:current] for k,v in deciles.items()}
        i_win = industries.loc[win_start:current]

        # Build cross-section for this window
        sub_rows = []
        for fname, ddf in d_win.items():
            for col in ddf.columns:
                s = ddf[col].dropna()
                idx = s.index.intersection(f_win.index)
                if len(idx) < 36: continue
                row = compute_characteristics(s.loc[idx], f_win.loc[idx],
                                              label=f'{fname}_{col}')
                if row:
                    sub_rows.append(row)

        for col in i_win.columns:
            s = i_win[col].dropna()
            idx = s.index.intersection(f_win.index)
            if len(idx) < 36: continue
            row = compute_characteristics(s.loc[idx], f_win.loc[idx],
                                          label=f'ind_{col}')
            if row:
                sub_rows.append(row)

        if len(sub_rows) < 20:
            current += pd.DateOffset(years=step_years)
            continue

        df_win = pd.DataFrame(sub_rows).dropna(
            subset=['mean_excess'] + FACTOR_VARS + MOMENT_VARS)

        if len(df_win) < 15:
            current += pd.DateOffset(years=step_years)
            continue

        y   = df_win['mean_excess']
        ra  = sm.OLS(y, sm.add_constant(df_win[FACTOR_VARS])).fit()
        rb  = sm.OLS(y, sm.add_constant(df_win[MOMENT_VARS])).fit()
        rc  = sm.OLS(y, sm.add_constant(
                        df_win[FACTOR_VARS + MOMENT_VARS])).fit()

        pct = rb.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0

        # F-test: do factors add over moments?
        n, k_c, k_b = len(df_win), len(rc.params), len(rb.params)
        dr  = rc.rsquared - rb.rsquared
        f   = (dr/(k_c-k_b)) / ((1-rc.rsquared)/(n-k_c))
        p   = 1 - stats.f.cdf(f, k_c-k_b, n-k_c)
        sig = '  no' if p > 0.05 else ' yes'

        print(f"  {str(current.date()):>12}  {ra.rsquared:>7.4f}  "
              f"{rb.rsquared:>7.4f}  {rc.rsquared:>7.4f}  "
              f"{pct:>6.1f}%  {sig}")

        rows.append({
            'window_end': current,
            'r2_factors': ra.rsquared,
            'r2_moments': rb.rsquared,
            'r2_full':    rc.rsquared,
            'pct_captured': pct,
            'f_stat': f, 'p_val': p,
        })

        current += pd.DateOffset(years=step_years)

    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df_all, ra, rb, rc, roll_df, outpath='distribution_vs_factors.png'):
    sub = df_all.dropna(subset=['mean_excess'] + FACTOR_VARS + MOMENT_VARS)
    y   = sub['mean_excess']

    fig = plt.figure(figsize=(16, 14))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.35)

    colors = {'decile': 'steelblue', 'industry': 'darkorange'}

    # 1. Factors fitted vs actual
    ax1 = fig.add_subplot(gs[0, 0])
    yhat_a = ra.fittedvalues
    for ptype, grp in sub.groupby('portfolio_type'):
        ax1.scatter(yhat_a.loc[grp.index]*100, grp['mean_excess']*100,
                    alpha=0.5, s=20, label=ptype, color=colors[ptype])
    mn, mx = yhat_a.min()*100-1, yhat_a.max()*100+1
    ax1.plot([mn,mx],[mn,mx],'k--',lw=1,alpha=0.4)
    ax1.set_title('Model A: Factors Only')
    ax1.set_xlabel('Fitted (%)'); ax1.set_ylabel('Realised (%)')
    ax1.legend(fontsize=7)
    ax1.text(0.05, 0.92, f'R²={ra.rsquared:.3f}', transform=ax1.transAxes,
             fontsize=8, color='navy')

    # 2. Moments fitted vs actual
    ax2 = fig.add_subplot(gs[0, 1])
    yhat_b = rb.fittedvalues
    for ptype, grp in sub.groupby('portfolio_type'):
        ax2.scatter(yhat_b.loc[grp.index]*100, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[ptype])
    mn, mx = yhat_b.min()*100-1, yhat_b.max()*100+1
    ax2.plot([mn,mx],[mn,mx],'k--',lw=1,alpha=0.4)
    ax2.set_title('Model B: Moments Only')
    ax2.set_xlabel('Fitted (%)'); ax2.set_ylabel('Realised (%)')
    ax2.text(0.05, 0.92, f'R²={rb.rsquared:.3f}', transform=ax2.transAxes,
             fontsize=8, color='navy')

    # 3. Full model fitted vs actual
    ax3 = fig.add_subplot(gs[0, 2])
    yhat_c = rc.fittedvalues
    for ptype, grp in sub.groupby('portfolio_type'):
        ax3.scatter(yhat_c.loc[grp.index]*100, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[ptype])
    mn, mx = yhat_c.min()*100-1, yhat_c.max()*100+1
    ax3.plot([mn,mx],[mn,mx],'k--',lw=1,alpha=0.4)
    ax3.set_title('Model C: Factors + Moments')
    ax3.set_xlabel('Fitted (%)'); ax3.set_ylabel('Realised (%)')
    ax3.text(0.05, 0.92, f'R²={rc.rsquared:.3f}', transform=ax3.transAxes,
             fontsize=8, color='navy')

    # 4. Coefficient shrinkage bar chart
    ax4 = fig.add_subplot(gs[1, :2])
    factor_labels = [v.replace('load_','') for v in FACTOR_VARS]
    coef_a = [ra.params.get(v, 0) for v in FACTOR_VARS]
    coef_c = [rc.params.get(v, 0) for v in FACTOR_VARS]
    x = np.arange(len(FACTOR_VARS))
    w = 0.35
    bars_a = ax4.bar(x - w/2, coef_a, w, label='Model A (factors only)',
                     color='steelblue', alpha=0.8)
    bars_c = ax4.bar(x + w/2, coef_c, w, label='Model C (factors + moments)',
                     color='coral', alpha=0.8)
    ax4.axhline(0, color='black', lw=0.5)
    ax4.set_xticks(x); ax4.set_xticklabels(factor_labels)
    ax4.set_title('Factor Coefficient Shrinkage: Model A → C')
    ax4.set_ylabel('Coefficient')
    ax4.legend(fontsize=8)

    # 5. Moment coefficients (Model C)
    ax5 = fig.add_subplot(gs[1, 2])
    moment_coefs = [rc.params.get(v, 0) for v in MOMENT_VARS]
    moment_tvals = [rc.tvalues.get(v, 0) for v in MOMENT_VARS]
    moment_colors = ['green' if abs(t) > 2 else 'lightgray' for t in moment_tvals]
    ax5.barh(MOMENT_VARS, moment_coefs, color=moment_colors, alpha=0.8)
    ax5.axvline(0, color='black', lw=0.5)
    ax5.set_title('Moment Coefficients (Model C)\n(green = significant)')
    ax5.set_xlabel('Coefficient')

    # 6. Rolling R² comparison
    if not roll_df.empty:
        ax6 = fig.add_subplot(gs[2, :2])
        ax6.plot(roll_df['window_end'], roll_df['r2_factors']*100,
                 label='Factors only (A)', color='steelblue', lw=2)
        ax6.plot(roll_df['window_end'], roll_df['r2_moments']*100,
                 label='Moments only (B)', color='darkorange', lw=2)
        ax6.plot(roll_df['window_end'], roll_df['r2_full']*100,
                 label='Factors + Moments (C)', color='green', lw=2, ls='--')
        ax6.set_title('Rolling R² Over Time')
        ax6.set_ylabel('R² (%)')
        ax6.legend(fontsize=8)

        ax7 = fig.add_subplot(gs[2, 2])
        ax7.plot(roll_df['window_end'], roll_df['pct_captured'],
                 color='purple', lw=2)
        ax7.axhline(100, color='gray', ls='--', lw=1)
        ax7.set_title('% of Factor R² Captured by Moments')
        ax7.set_ylabel('%')
        ax7.set_ylim(0, max(150, roll_df['pct_captured'].max() + 10))

    fig.suptitle('Do Return Distribution Moments Absorb Factor Premia?',
                 fontsize=13, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 65)
    print("Distribution vs Factors Test")
    print("Do return distribution moments absorb FF factor premia?")
    print("=" * 65)

    factors, mom, deciles, industries = fetch_data()

    # Merge momentum into factors df
    all_factors = factors.join(mom, how='left').fillna(0)

    # Build full cross-section
    df_all = build_cross_section(all_factors, deciles, industries)

    # Main test: all portfolios
    ra, rb, rc, sub = run_cross_sectional(df_all, label='All portfolios')

    # Separate test on industry portfolios only (cleanest test)
    ind_df = df_all[df_all['portfolio_type'] == 'industry']
    if len(ind_df) > 20:
        run_cross_sectional(ind_df, label='Industry portfolios only (unbiased)')

    # Rolling analysis
    roll_df = rolling_shrinkage(all_factors, deciles, industries,
                                window_years=10, step_years=5)

    # Plots
    print("\nGenerating plots...")
    make_plots(df_all, ra, rb, rc, roll_df)

    # Summary
    pct = rb.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
    print("\n" + "=" * 65)
    print("SUMMARY")
    print("=" * 65)
    print(f"  Factors-only R²:   {ra.rsquared:.4f}")
    print(f"  Moments-only R²:   {rb.rsquared:.4f}  ({pct:.1f}% of factor R²)")
    print(f"  Combined R²:       {rc.rsquared:.4f}")
    print()
    if pct > 80:
        print("  RESULT: Distribution moments capture >80% of factor explanatory")
        print("  power. Strong support for the unified beta / utility curve theory.")
    elif pct > 50:
        print("  RESULT: Moments capture majority of factor power but not all.")
        print("  Partial support — factors contain information beyond distribution shape.")
    else:
        print("  RESULT: Moments capture <50% of factor power.")
        print("  Factors retain substantial independent explanatory power.")
    print("=" * 65)
    print("\nDone.")


if __name__ == '__main__':
    main()
