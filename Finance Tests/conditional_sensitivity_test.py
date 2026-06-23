"""
Conditional Sensitivity Test
==============================
Tests whether the shape of a stock's market sensitivity curve —
specifically whether beta varies across different market return regimes —
predicts cross-sectional returns independently of average beta and FF5 factors.

Theory: if a stock has higher beta in bad market states than good states,
it is more costly to hold under any concave utility function. This asymmetric
sensitivity should command a premium beyond what average beta predicts.

Low-resolution version: splits market returns into terciles (bad/neutral/good)
and estimates a separate beta in each regime.

Key measures:
  beta_bad:   beta estimated in bottom third of market return months
  beta_neutral: beta in middle third
  beta_good:  beta in top third
  beta_asym:  beta_bad - beta_good  (positive = crashes harder than rallies)
  beta_avg:   full-sample OLS beta (standard CAPM measure)

Models tested:
  A: FF5 factors only (benchmark)
  B: beta_avg only (CAPM)
  C: beta_bad + beta_good (two-regime)
  D: beta_avg + beta_asym (average + shape)
  E: beta_bad + beta_neutral + beta_good (three-regime)
  F: FF5 + beta_asym (do factors absorb sensitivity shape?)
  G: beta_asym only (pure shape effect)

Test assets: FF5 decile portfolios + 49 industry portfolios

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python conditional_sensitivity_test.py
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
    industries = _make_df(rows,
                          ['Date'] + [f'Ind{i+1}' for i in range(49)])
    print("  ✓ 49 industry portfolios")

    return factors, mom, deciles, industries


# ══════════════════════════════════════════════════════════════════════════════
# 2.  CONDITIONAL BETA ESTIMATION
# ══════════════════════════════════════════════════════════════════════════════

def regime_beta(r_exc, rm_exc, mask, min_obs=10):
    """OLS beta of r_exc on rm_exc using only months where mask is True."""
    r_  = r_exc[mask]
    rm_ = rm_exc[mask]
    if len(r_) < min_obs or rm_.var() < 1e-12:
        # Fall back to full-sample beta
        return float(np.cov(r_exc, rm_exc)[0,1] /
                     (rm_exc.var() + 1e-12))
    X = sm.add_constant(rm_)
    return float(sm.OLS(r_, X).fit().params.iloc[1])


def compute_characteristics(ret_series, factors_df):
    """
    Compute standard and conditional beta measures for one portfolio.
    Market return terciles define the three regimes.
    """
    idx = ret_series.index.intersection(factors_df.index)
    ret_series = ret_series.loc[idx].dropna()
    idx = ret_series.index.intersection(factors_df.index)
    if len(idx) < 60:
        return None

    r   = ret_series.loc[idx] / 100
    rf  = factors_df.loc[idx, 'RF']  / 100
    mkt = factors_df.loc[idx, 'Mkt-RF'] / 100
    smb = factors_df.loc[idx, 'SMB'] / 100
    hml = factors_df.loc[idx, 'HML'] / 100
    rmw = factors_df.loc[idx, 'RMW'] / 100
    cma = factors_df.loc[idx, 'CMA'] / 100
    mom_s = factors_df.loc[idx, 'MOM'] / 100 \
            if 'MOM' in factors_df.columns \
            else pd.Series(0.0, index=idx)

    r_exc  = r - rf
    rm_exc = mkt

    # ── FF5 + MOM factor loadings ─────────────────────────────────────────────
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg = sm.OLS(r_exc, Xf).fit()
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}
    beta_avg = float(reg.params['Mkt-RF'])

    # ── Market return regime boundaries (terciles) ────────────────────────────
    t33 = float(np.percentile(rm_exc.dropna(), 33.3))
    t67 = float(np.percentile(rm_exc.dropna(), 66.7))

    bad_mask     = rm_exc <= t33
    neutral_mask = (rm_exc > t33) & (rm_exc <= t67)
    good_mask    = rm_exc > t67

    beta_bad     = regime_beta(r_exc, rm_exc, bad_mask)
    beta_neutral = regime_beta(r_exc, rm_exc, neutral_mask)
    beta_good    = regime_beta(r_exc, rm_exc, good_mask)

    # Core asymmetry measure
    beta_asym = float(beta_bad - beta_good)

    # Additional resolution: quintile betas
    q20 = float(np.percentile(rm_exc.dropna(), 20))
    q40 = float(np.percentile(rm_exc.dropna(), 40))
    q60 = float(np.percentile(rm_exc.dropna(), 60))
    q80 = float(np.percentile(rm_exc.dropna(), 80))

    beta_q1 = regime_beta(r_exc, rm_exc, rm_exc <= q20)
    beta_q2 = regime_beta(r_exc, rm_exc,
                          (rm_exc > q20) & (rm_exc <= q40))
    beta_q3 = regime_beta(r_exc, rm_exc,
                          (rm_exc > q40) & (rm_exc <= q60))
    beta_q4 = regime_beta(r_exc, rm_exc,
                          (rm_exc > q60) & (rm_exc <= q80))
    beta_q5 = regime_beta(r_exc, rm_exc, rm_exc > q80)

    # Monotonicity score: is the sensitivity curve monotonically
    # decreasing from bad to good states?
    # (would be -5 if perfectly decreasing, 0 if flat, +5 if increasing)
    quintile_betas = [beta_q1, beta_q2, beta_q3, beta_q4, beta_q5]
    mono_score = sum(
        1 if quintile_betas[i] > quintile_betas[i+1] else -1
        for i in range(len(quintile_betas)-1)
    )

    # Sensitivity curve slope: OLS of beta_qi on quintile rank
    # Negative slope = higher beta in worse states (the costly pattern)
    qranks = np.array([1,2,3,4,5], dtype=float)
    qbetas = np.array(quintile_betas, dtype=float)
    if qbetas.std() > 1e-10:
        curve_slope = float(np.polyfit(qranks, qbetas, 1)[0])
    else:
        curve_slope = 0.0

    # Standalone moments for comparison
    sigma      = float(r_exc.std())
    skewness   = float(stats.skew(r_exc.dropna()))
    kurtosis   = float(stats.kurtosis(r_exc.dropna()))
    var_5      = float(np.percentile(r_exc.dropna(), 5))

    return {
        'mean_excess':   float(r_exc.mean() * 12),
        'n_obs':         len(idx),
        **loadings,
        # Standard beta
        'beta_avg':      beta_avg,
        # Tercile regime betas
        'beta_bad':      beta_bad,
        'beta_neutral':  beta_neutral,
        'beta_good':     beta_good,
        # Core asymmetry
        'beta_asym':     beta_asym,
        # Quintile betas
        'beta_q1':       beta_q1,
        'beta_q2':       beta_q2,
        'beta_q3':       beta_q3,
        'beta_q4':       beta_q4,
        'beta_q5':       beta_q5,
        # Sensitivity curve summary
        'curve_slope':   curve_slope,
        'mono_score':    float(mono_score),
        # Standalone moments
        'sigma':         sigma,
        'skewness':      skewness,
        'kurtosis':      kurtosis,
        'var_5pct':      var_5,
    }


def build_cross_section(all_factors, deciles, industries):
    print("\nComputing conditional betas...")
    rows = []

    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_characteristics(s.loc[idx], all_factors.loc[idx])
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)

    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_characteristics(s.loc[idx], all_factors.loc[idx])
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)

    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios  "
          f"({(df.portfolio_type=='decile').sum()} decile, "
          f"{(df.portfolio_type=='industry').sum()} industry)")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 3.  SENSITIVITY CURVE DIAGNOSTIC
# ══════════════════════════════════════════════════════════════════════════════

def sensitivity_diagnostic(df):
    """
    Before running regressions, check whether the sensitivity curve
    is consistently shaped across portfolios.

    Key questions:
      1. Is beta_bad consistently higher than beta_good?
         (i.e. is beta_asym consistently positive?)
      2. Is the quintile beta curve monotonically decreasing
         from bad to good states for most portfolios?
      3. How large is the variation in beta_asym across portfolios?
         (determines whether there's enough signal to detect)
    """
    print("\n" + "="*65)
    print("Sensitivity Curve Diagnostic")
    print("="*65)

    # Beta asymmetry distribution
    asym = df['beta_asym'].dropna()
    t_stat, p_val = stats.ttest_1samp(asym, 0)
    pct_pos = (asym > 0).mean() * 100

    print(f"\n── Beta Asymmetry (beta_bad - beta_good) ────────────────────────")
    print(f"  Mean:     {asym.mean():+.4f}")
    print(f"  Std:      {asym.std():.4f}")
    print(f"  t vs 0:   {t_stat:+.2f}  p={p_val:.4f}")
    print(f"  % positive: {pct_pos:.1f}%")
    print(f"  Min: {asym.min():+.4f}  Max: {asym.max():+.4f}")

    if pct_pos > 70 and p_val < 0.05:
        print(f"  → CONSISTENT: most portfolios crash harder than they rally")
    elif pct_pos > 55:
        print(f"  → MODERATE: slight tendency to crash harder, not overwhelming")
    else:
        print(f"  → MIXED: no consistent asymmetry across portfolios")

    # Quintile beta profiles
    print(f"\n── Mean Beta by Market Return Quintile ──────────────────────────")
    print(f"  Q1=worst 20%  →  Q5=best 20%")
    q_means = [df[f'beta_q{i}'].mean() for i in range(1,6)]
    q_stds  = [df[f'beta_q{i}'].std()  for i in range(1,6)]
    for i, (m, s) in enumerate(zip(q_means, q_stds)):
        bar = '█' * int(abs(m) * 20)
        print(f"  Q{i+1}: {m:+.4f} ± {s:.4f}  {bar}")

    # Curve slope distribution
    slope = df['curve_slope'].dropna()
    t_s, p_s = stats.ttest_1samp(slope, 0)
    pct_neg_slope = (slope < 0).mean() * 100
    print(f"\n── Sensitivity Curve Slope (OLS of beta_qi on quintile rank) ────")
    print(f"  Mean slope: {slope.mean():+.4f}  (negative = crashes harder)")
    print(f"  t vs 0:     {t_s:+.2f}  p={p_s:.4f}")
    print(f"  % with negative slope: {pct_neg_slope:.1f}%")

    # Monotonicity
    mono = df['mono_score'].dropna()
    print(f"\n── Monotonicity Score (-4 to +4, negative = consistently decreasing) ──")
    for score in [-4,-3,-2,-1,0,1,2,3,4]:
        n = (mono == score).sum()
        if n > 0:
            bar = '█' * n
            print(f"  {score:+d}: {n:3d} portfolios  {bar}")

    # Correlation of beta_asym with mean excess return
    corr_all  = df['beta_asym'].corr(df['mean_excess'])
    corr_dec  = df[df.portfolio_type=='decile']['beta_asym'].corr(
                df[df.portfolio_type=='decile']['mean_excess'])
    corr_ind  = df[df.portfolio_type=='industry']['beta_asym'].corr(
                df[df.portfolio_type=='industry']['mean_excess'])
    print(f"\n── Correlation of beta_asym with Mean Excess Return ─────────────")
    print(f"  All portfolios:      r = {corr_all:+.4f}")
    print(f"  Decile portfolios:   r = {corr_dec:+.4f}")
    print(f"  Industry portfolios: r = {corr_ind:+.4f}")
    print(f"  (Theory predicts positive: more asymmetric → higher premium)")

    # Curve slope correlation
    corr_slope = df['curve_slope'].corr(df['mean_excess'])
    print(f"\n  Curve slope vs mean excess: r = {corr_slope:+.4f}")
    print(f"  (Theory predicts negative: steeper downward curve → higher premium)")


# ══════════════════════════════════════════════════════════════════════════════
# 4.  CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def run_regressions(df, label='All portfolios'):
    req = (['mean_excess','beta_avg','beta_bad','beta_neutral',
            'beta_good','beta_asym','curve_slope'] +
           FACTOR_VARS +
           ['sigma','var_5pct'])
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Cross-sectional Regressions: {label}  (N={n})")
    print(f"{'='*65}")

    models = {
        'A  FF5 factors':               FACTOR_VARS,
        'B  beta_avg only':             ['beta_avg'],
        'C  beta_bad + beta_good':      ['beta_bad','beta_good'],
        'D  beta_avg + beta_asym':      ['beta_avg','beta_asym'],
        'E  three-regime betas':        ['beta_bad','beta_neutral','beta_good'],
        'F  FF5 + beta_asym':           FACTOR_VARS + ['beta_asym'],
        'G  beta_asym only':            ['beta_asym'],
        'H  curve_slope only':          ['curve_slope'],
        'I  beta_avg + curve_slope':    ['beta_avg','curve_slope'],
        'J  FF5 + curve_slope':         FACTOR_VARS + ['curve_slope'],
        'K  standalone moments':        ['sigma','var_5pct'],
        'L  moments + beta_asym':       ['sigma','var_5pct','beta_asym'],
    }

    regs = {}
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<36} {'R²':>7}  {'% of A':>8}")
    print("  " + "-" * 56)

    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  FF5 factors':<36} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<36} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # ── Key coefficient tables ────────────────────────────────────────────────
    print(f"\n── Model D: beta_avg + beta_asym ────────────────────────────────")
    rd = regs['D']
    for v in ['beta_avg','beta_asym']:
        c = rd.params.get(v, np.nan)
        t = rd.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<16} coef={c:+.4f}  t={t:+.2f}  {sig}")

    print(f"\n── Model E: Three-regime betas ──────────────────────────────────")
    re = regs['E']
    for v in ['beta_bad','beta_neutral','beta_good']:
        c = re.params.get(v, np.nan)
        t = re.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<16} coef={c:+.4f}  t={t:+.2f}  {sig}")
    print(f"  Interpretation: if bad>neutral>good in coefficient size,")
    print(f"  bad-state beta is more heavily priced than good-state beta")

    print(f"\n── Model F: FF5 + beta_asym ─────────────────────────────────────")
    rf_ = regs['F']
    for v in FACTOR_VARS + ['beta_asym']:
        c  = rf_.params.get(v, np.nan)
        ca = ra.params.get(v, np.nan)
        t  = rf_.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        shrink = (f"({(1-abs(c)/abs(ca))*100:+.0f}% shrink)"
                  if v in FACTOR_VARS and abs(ca)>1e-10 else '')
        print(f"  {v:<14} coef={c:+.6f}  t={t:+.2f}  {sig}  {shrink}")

    # ── F-tests ───────────────────────────────────────────────────────────────
    from scipy.stats import f as f_dist
    def f_test(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        fstat = ((r2_f-r2_r)/(k_f-k_r)) / ((1-r2_f)/(n-k_f))
        p = 1 - f_dist.cdf(fstat, k_f-k_r, n-k_f)
        return fstat, p

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('beta_asym adds over beta_avg alone',
         regs['B'], regs['D'], 1, 2),
        ('beta_asym adds over FF5 factors',
         regs['A'], regs['F'], len(FACTOR_VARS), len(FACTOR_VARS)+1),
        ('three-regime beats beta_avg alone',
         regs['B'], regs['E'], 1, 3),
        ('curve_slope adds over beta_avg',
         regs['B'], regs['I'], 1, 2),
        ('curve_slope adds over FF5',
         regs['A'], regs['J'], len(FACTOR_VARS), len(FACTOR_VARS)+1),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fstat, p = f_test(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fstat): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no')
        print(f"  {desc:<44} F={fstat:6.2f}  p={p:.4f}  {sig}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs_all, regs_ind, outpath='conditional_sensitivity.png'):
    req = (['mean_excess','beta_avg','beta_bad','beta_good',
            'beta_asym','curve_slope'] + FACTOR_VARS + ['sigma','var_5pct'])
    sub = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16,14))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.38)

    def scatter_fit(ax, reg, title):
        yhat = reg.fittedvalues
        for pt, grp in sub.groupby('portfolio_type'):
            ax.scatter(yhat.loc[grp.index]*100,
                       grp['mean_excess']*100,
                       alpha=0.5, s=20, color=colors[pt], label=pt)
        lo = min(yhat.min(), sub['mean_excess'].min())*100 - 0.3
        hi = max(yhat.max(), sub['mean_excess'].max())*100 + 0.3
        ax.plot([lo,hi],[lo,hi],'k--',lw=1,alpha=0.4)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel('Fitted (%)'); ax.set_ylabel('Realised (%)')
        ax.text(0.05,0.92,f'R²={reg.rsquared:.3f}',
                transform=ax.transAxes, fontsize=8, color='navy')

    ax1 = fig.add_subplot(gs[0,0])
    scatter_fit(ax1, regs_all['A'], 'A: FF5 Factors')
    ax1.legend(fontsize=6)

    ax2 = fig.add_subplot(gs[0,1])
    scatter_fit(ax2, regs_all['D'], 'D: beta_avg + beta_asym')

    ax3 = fig.add_subplot(gs[0,2])
    scatter_fit(ax3, regs_all['E'], 'E: Three-regime betas')

    # Beta asymmetry vs mean excess return
    ax4 = fig.add_subplot(gs[1,0])
    for pt, grp in sub.groupby('portfolio_type'):
        ax4.scatter(grp['beta_asym'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax4.set_xlabel('Beta Asymmetry (bad - good)')
    ax4.set_ylabel('Mean Excess Return (%)')
    ax4.set_title('Beta Asymmetry vs Return')
    corr = sub['beta_asym'].corr(sub['mean_excess'])
    ax4.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax4.transAxes, fontsize=8, color='navy')

    # Mean sensitivity curve across all portfolios
    ax5 = fig.add_subplot(gs[1,1])
    q_cols = ['beta_q1','beta_q2','beta_q3','beta_q4','beta_q5']
    q_labels = ['Q1\n(worst)','Q2','Q3','Q4','Q5\n(best)']
    for pt, grp in sub.groupby('portfolio_type'):
        means = [grp[c].mean() for c in q_cols]
        ax5.plot(range(1,6), means, marker='o', label=pt,
                 color=colors[pt], lw=2)
    ax5.set_xticks(range(1,6))
    ax5.set_xticklabels(q_labels, fontsize=8)
    ax5.set_ylabel('Mean Beta')
    ax5.set_title('Mean Sensitivity Curve by Market Quintile')
    ax5.legend(fontsize=8)
    ax5.axhline(sub['beta_avg'].mean(), ls='--', color='gray',
                lw=1, label='avg beta')

    # Curve slope vs mean excess return
    ax6 = fig.add_subplot(gs[1,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax6.scatter(grp['curve_slope'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax6.set_xlabel('Sensitivity Curve Slope')
    ax6.set_ylabel('Mean Excess Return (%)')
    ax6.set_title('Curve Slope vs Return\n(negative slope = crashes harder)')
    corr = sub['curve_slope'].corr(sub['mean_excess'])
    ax6.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax6.transAxes, fontsize=8, color='navy')

    # R² bar chart
    ax7 = fig.add_subplot(gs[2,:2])
    mkeys  = ['A','B','C','D','E','F','G','H','I','K','L']
    mlabels= ['A\nFF5','B\nbeta','C\nbad+\ngood','D\navg+\nasym',
              'E\n3-reg','F\nFF5+\nasym','G\nasym','H\nslope',
              'I\navg+\nslope','K\nmom','L\nmom+\nasym']
    r2_all = [regs_all.get(k, type('',(),{'rsquared':0})()).rsquared
              for k in mkeys]
    r2_ind = [regs_ind.get(k, type('',(),{'rsquared':0})()).rsquared
              if regs_ind else 0 for k in mkeys]
    x = np.arange(len(mkeys))
    ax7.bar(x-0.2, r2_all, 0.35, label='All', color='steelblue', alpha=0.8)
    ax7.bar(x+0.2, r2_ind, 0.35, label='Industry', color='darkorange',
            alpha=0.8)
    ax7.set_xticks(x); ax7.set_xticklabels(mlabels, fontsize=7)
    ax7.set_ylabel('R²')
    ax7.set_title('R² Across Models')
    ax7.legend(fontsize=8)

    # Beta bad vs beta good scatter
    ax8 = fig.add_subplot(gs[2,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax8.scatter(grp['beta_good'], grp['beta_bad'],
                    alpha=0.5, s=20, color=colors[pt])
    lo = min(sub['beta_good'].min(), sub['beta_bad'].min()) - 0.1
    hi = max(sub['beta_good'].max(), sub['beta_bad'].max()) + 0.1
    ax8.plot([lo,hi],[lo,hi],'k--',lw=1,alpha=0.4,label='beta_bad=beta_good')
    ax8.set_xlabel('Beta (good markets)')
    ax8.set_ylabel('Beta (bad markets)')
    ax8.set_title('Bad vs Good Market Beta\n(above line = crashes harder)')
    pct_above = (sub['beta_bad'] > sub['beta_good']).mean()*100
    ax8.text(0.05,0.92,f'{pct_above:.0f}% above line',
             transform=ax8.transAxes, fontsize=8, color='navy')

    fig.suptitle(
        'Conditional Sensitivity Test: Does Beta Asymmetry Predict Returns?',
        fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Conditional Sensitivity Test")
    print("Does beta vary across market regimes, and is it priced?")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    df = build_cross_section(all_factors, deciles, industries)

    # Diagnostic first
    sensitivity_diagnostic(df)

    # All portfolios
    regs_all, sub_all = run_regressions(df, 'All portfolios')

    # Industry portfolios only
    ind_df = df[df['portfolio_type']=='industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_regressions(ind_df,
                                      'Industry portfolios only (unbiased)')

    # Plots
    print("\nGenerating plots...")
    make_plots(df, regs_all, regs_ind)

    # Summary
    ra  = regs_all['A']
    rd  = regs_all['D']
    re  = regs_all['E']
    rf_ = regs_all['F']

    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    print(f"  FF5 factors R²:              {ra.rsquared:.4f}")
    print(f"  beta_avg + beta_asym R²:     {rd.rsquared:.4f}  "
          f"({rd.rsquared/ra.rsquared*100:.1f}% of FF5)")
    print(f"  Three-regime betas R²:       {re.rsquared:.4f}  "
          f"({re.rsquared/ra.rsquared*100:.1f}% of FF5)")
    print(f"  FF5 + beta_asym R²:          {rf_.rsquared:.4f}")
    print()
    t_asym = rd.tvalues.get('beta_asym', np.nan)
    c_asym = rd.params.get('beta_asym', np.nan)
    if abs(t_asym) > 2:
        direction = "positive ✓" if c_asym > 0 else "negative ✗ (wrong sign)"
        print(f"  beta_asym significant: t={t_asym:+.2f}, "
              f"coef={c_asym:+.4f} ({direction})")
    else:
        print(f"  beta_asym not significant: t={t_asym:+.2f}")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()
