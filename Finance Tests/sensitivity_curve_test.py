"""
Sensitivity Curve Test (High Resolution)
==========================================
Extends the conditional sensitivity test by characterising the full
shape of each portfolio's market sensitivity curve using quintile bins,
then testing whether specific shape features predict returns.

Key insight from low-resolution test: the sensitivity curve peaks at Q3
(moderate bad markets) rather than Q1 (worst markets), suggesting the
relevant nonlinearity may be convexity — stocks are more sensitive to
extreme market moves generally — rather than simple bad/good asymmetry.

New measures beyond low-resolution test:
  tail_sensitivity:  beta_q1 - beta_q3   (crash amplification vs normal)
  boom_sensitivity:  beta_q5 - beta_q3   (boom amplification vs normal)
  tail_asymmetry:    tail_sensitivity - boom_sensitivity  (pure directional asym)
  curve_convexity:   (beta_q1 + beta_q5)/2 - beta_q3  (U-shape = both tails amplify)
  curve_slope:       OLS slope of beta_qi on quintile rank (overall trend)

Theory predictions:
  tail_asymmetry > 0 and priced → concave utility prices directional asymmetry
  curve_convexity > 0 and priced → kurtosis/fat-tail utility prices both tails
  If convexity > asymmetry → pricing curve is symmetric around zero (kurtosis story)
  If asymmetry > convexity → pricing curve is asymmetric (skewness/loss aversion story)

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python sensitivity_curve_test.py
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
# 2.  SENSITIVITY CURVE ESTIMATION
# ══════════════════════════════════════════════════════════════════════════════

def regime_beta(r_exc, rm_exc, mask, fallback_beta, min_obs=10):
    """OLS beta in regime defined by mask, with fallback."""
    r_, rm_ = r_exc[mask], rm_exc[mask]
    if len(r_) < min_obs or rm_.var() < 1e-12:
        return fallback_beta
    X = sm.add_constant(rm_.rename('x'))
    return float(sm.OLS(r_, X).fit().params['x'])


def compute_characteristics(ret_series, factors_df, n_bins=5):
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

    # ── FF5 + MOM loadings ────────────────────────────────────────────────────
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg = sm.OLS(r_exc, Xf).fit()
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}
    beta_avg = float(reg.params['Mkt-RF'])

    # ── Quintile sensitivity curve (5 bins) ───────────────────────────────────
    quantiles = np.linspace(0, 1, n_bins + 1)
    edges     = np.quantile(rm_exc.dropna(), quantiles)
    edges     = np.unique(edges)
    n_actual  = len(edges) - 1

    bin_betas = []
    bin_masks = []
    for i in range(n_actual):
        lo, hi = edges[i], edges[i+1]
        mask = (rm_exc >= lo) & (rm_exc <= hi) \
               if i == n_actual - 1 \
               else (rm_exc >= lo) & (rm_exc < hi)
        b = regime_beta(r_exc, rm_exc, mask, beta_avg)
        bin_betas.append(b)
        bin_masks.append(mask)

    # Pad to exactly 5 bins if needed
    while len(bin_betas) < 5:
        bin_betas.append(beta_avg)
    bin_betas = bin_betas[:5]

    bq1, bq2, bq3, bq4, bq5 = bin_betas

    # ── Shape measures ────────────────────────────────────────────────────────
    # Middle bin as reference point for normal market conditions
    b_mid = bq3

    # How much does the stock amplify in crashes vs normal?
    tail_sensitivity = bq1 - b_mid

    # How much does the stock amplify in booms vs normal?
    boom_sensitivity = bq5 - b_mid

    # Pure directional asymmetry: do crashes amplify MORE than booms?
    # Positive = crash amplification dominates (skewness/loss aversion story)
    tail_asymmetry = tail_sensitivity - boom_sensitivity

    # Convexity: do BOTH tails amplify relative to the middle?
    # Positive = U-shaped curve (kurtosis/fat-tail story)
    curve_convexity = (bq1 + bq5) / 2 - b_mid

    # Overall slope: OLS of bin_beta on bin_rank
    # Negative = higher beta in worse states overall
    ranks  = np.array([1,2,3,4,5], dtype=float)
    betas  = np.array(bin_betas, dtype=float)
    curve_slope = float(np.polyfit(ranks, betas, 1)[0]) \
                  if betas.std() > 1e-10 else 0.0

    # Simple bad/good asymmetry (from previous test, for comparison)
    beta_asym_simple = bq1 - bq5

    # Monotonicity: count of decreasing consecutive pairs (max 4)
    mono = sum(1 if betas[i] > betas[i+1] else 0
               for i in range(4))

    # ── Standalone moments ────────────────────────────────────────────────────
    sigma    = float(r_exc.std())
    skewness = float(stats.skew(r_exc.dropna()))
    kurtosis = float(stats.kurtosis(r_exc.dropna()))
    var_5    = float(np.percentile(r_exc.dropna(), 5))

    return {
        'mean_excess':      float(r_exc.mean() * 12),
        'n_obs':            len(idx),
        **loadings,
        'beta_avg':         beta_avg,
        # Quintile betas
        'beta_q1':          bq1,
        'beta_q2':          bq2,
        'beta_q3':          bq3,
        'beta_q4':          bq4,
        'beta_q5':          bq5,
        # Shape measures
        'tail_sensitivity': tail_sensitivity,
        'boom_sensitivity': boom_sensitivity,
        'tail_asymmetry':   tail_asymmetry,
        'curve_convexity':  curve_convexity,
        'curve_slope':      curve_slope,
        'beta_asym_simple': beta_asym_simple,
        'mono_score':       float(mono),
        # Standalone moments
        'sigma':            sigma,
        'skewness':         skewness,
        'kurtosis':         kurtosis,
        'var_5pct':         var_5,
    }


def build_cross_section(all_factors, deciles, industries, n_bins=5):
    print(f"\nComputing sensitivity curves ({n_bins} bins)...")
    rows = []
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_characteristics(
                s.loc[idx], all_factors.loc[idx], n_bins)
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)
    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_characteristics(
            s.loc[idx], all_factors.loc[idx], n_bins)
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios built")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 3.  SHAPE DIAGNOSTIC
# ══════════════════════════════════════════════════════════════════════════════

SHAPE_VARS = ['tail_sensitivity','boom_sensitivity','tail_asymmetry',
              'curve_convexity','curve_slope','beta_asym_simple']
FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def shape_diagnostic(df):
    print("\n" + "="*65)
    print("Sensitivity Curve Shape Diagnostic")
    print("="*65)

    # Mean quintile betas
    print("\n── Mean Beta by Market Quintile (all portfolios) ────────────────")
    print(f"  {'Bin':<6} {'Mean beta':>10} {'Std':>8} {'% > avg':>8}")
    print("  " + "-"*38)
    beta_avg_mean = df['beta_avg'].mean()
    for i in range(1, 6):
        col = f'beta_q{i}'
        v   = df[col].dropna()
        pct_above = (v > beta_avg_mean).mean() * 100
        label = ['worst 20%','20-40%','40-60%','60-80%','best 20%'][i-1]
        print(f"  Q{i} {label:<10} {v.mean():>+10.4f} {v.std():>8.4f} "
              f"{pct_above:>7.1f}%")

    # Shape measure distributions
    print(f"\n── Shape Measure Summary ────────────────────────────────────────")
    print(f"  {'Measure':<22} {'Mean':>8} {'Std':>8} {'t vs 0':>8} "
          f"{'p':>7} {'%>0':>6}")
    print("  " + "-"*62)
    for col in SHAPE_VARS:
        if col not in df.columns: continue
        v  = df[col].dropna()
        t, p = stats.ttest_1samp(v, 0)
        pct_pos = (v > 0).mean() * 100
        sig = '***' if p < 0.001 else ('*' if p < 0.05 else '   ')
        print(f"  {col:<22} {v.mean():>+8.4f} {v.std():>8.4f} "
              f"{t:>+8.2f}{sig} {p:>7.4f} {pct_pos:>5.1f}%")

    # Key theoretical test: is convexity or asymmetry larger?
    print(f"\n── Convexity vs Asymmetry ───────────────────────────────────────")
    conv = df['curve_convexity'].mean()
    asym = df['tail_asymmetry'].mean()
    print(f"  Mean convexity:  {conv:+.4f}  "
          f"(U-shape: both tails amplify)")
    print(f"  Mean asymmetry:  {asym:+.4f}  "
          f"(crash amplifies more than boom)")
    if abs(conv) > abs(asym):
        print(f"  → CONVEXITY DOMINATES: kurtosis/fat-tail story more relevant")
        print(f"    Stocks amplify extreme moves in BOTH directions")
    elif abs(asym) > abs(conv):
        print(f"  → ASYMMETRY DOMINATES: skewness/loss-aversion story more relevant")
        print(f"    Stocks specifically amplify crashes more than booms")
    else:
        print(f"  → ROUGHLY EQUAL: both effects present")

    # Correlation with returns
    print(f"\n── Shape Measure Correlations with Mean Excess Return ───────────")
    print(f"  {'Measure':<22} {'All':>7} {'Decile':>8} {'Industry':>10}")
    print("  " + "-"*50)
    dec = df[df.portfolio_type=='decile']
    ind = df[df.portfolio_type=='industry']
    for col in SHAPE_VARS:
        if col not in df.columns: continue
        r_all = df[col].corr(df['mean_excess'])
        r_dec = dec[col].corr(dec['mean_excess'])
        r_ind = ind[col].corr(ind['mean_excess'])
        print(f"  {col:<22} {r_all:>+7.4f} {r_dec:>+8.4f} {r_ind:>+10.4f}")

    print(f"\n  Theory predictions:")
    print(f"  tail_asymmetry: + (crash amplification costly under loss aversion)")
    print(f"  curve_convexity: + (fat-tail amplification costly under kurtosis aversion)")
    print(f"  curve_slope: - (steeper downward slope = more costly)")
    print(f"  boom_sensitivity: - (boom amplification is beneficial, reduces premium)")


# ══════════════════════════════════════════════════════════════════════════════
# 4.  CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

def run_regressions(df, label='All portfolios'):
    req = (['mean_excess','beta_avg'] + SHAPE_VARS + FACTOR_VARS +
           ['sigma','var_5pct'])
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Cross-sectional Regressions: {label}  (N={n})")
    print(f"{'='*65}")

    models = {
        'A  FF5 factors':                    FACTOR_VARS,
        'B  beta_avg only':                  ['beta_avg'],
        'C  tail_asymmetry only':            ['tail_asymmetry'],
        'D  curve_convexity only':           ['curve_convexity'],
        'E  beta_avg + tail_asymmetry':      ['beta_avg','tail_asymmetry'],
        'F  beta_avg + curve_convexity':     ['beta_avg','curve_convexity'],
        'G  beta_avg + asym + convexity':    ['beta_avg','tail_asymmetry',
                                              'curve_convexity'],
        'H  all shape measures':             ['beta_avg'] + SHAPE_VARS,
        'I  FF5 + tail_asymmetry':           FACTOR_VARS + ['tail_asymmetry'],
        'J  FF5 + curve_convexity':          FACTOR_VARS + ['curve_convexity'],
        'K  FF5 + asym + convexity':         FACTOR_VARS + ['tail_asymmetry',
                                              'curve_convexity'],
        'L  standalone moments':             ['sigma','var_5pct'],
        'M  moments + asym + convexity':     ['sigma','var_5pct',
                                              'tail_asymmetry',
                                              'curve_convexity'],
    }

    regs = {}
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<40} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*60)

    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  FF5 factors':<40} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<40} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # ── Key coefficient tables ────────────────────────────────────────────────
    print(f"\n── Model G: beta_avg + tail_asymmetry + curve_convexity ─────────")
    rg = regs['G']
    for v in ['beta_avg','tail_asymmetry','curve_convexity']:
        c = rg.params.get(v, np.nan)
        t = rg.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<22} coef={c:+.4f}  t={t:+.2f}  {sig}")

    print(f"\n── Model K: FF5 + tail_asymmetry + curve_convexity ──────────────")
    rk = regs['K']
    for v in FACTOR_VARS + ['tail_asymmetry','curve_convexity']:
        c  = rk.params.get(v, np.nan)
        ca = ra.params.get(v, np.nan)
        t  = rk.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        sh  = (f"({(1-abs(c)/abs(ca))*100:+.0f}% shrink)"
               if v in FACTOR_VARS and abs(ca)>1e-10 else '')
        print(f"  {v:<22} coef={c:+.6f}  t={t:+.2f}  {sig}  {sh}")

    # ── F-tests ───────────────────────────────────────────────────────────────
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        fstat = ((r2_f-r2_r)/(k_f-k_r)) / ((1-r2_f)/(n-k_f))
        return fstat, 1 - f_dist.cdf(fstat, k_f-k_r, n-k_f)

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('tail_asymmetry adds over beta_avg',
         regs['B'], regs['E'], 1, 2),
        ('curve_convexity adds over beta_avg',
         regs['B'], regs['F'], 1, 2),
        ('asym + convexity adds over beta_avg',
         regs['B'], regs['G'], 1, 3),
        ('tail_asymmetry adds over FF5',
         regs['A'], regs['I'], len(FACTOR_VARS), len(FACTOR_VARS)+1),
        ('curve_convexity adds over FF5',
         regs['A'], regs['J'], len(FACTOR_VARS), len(FACTOR_VARS)+1),
        ('asym + convexity adds over FF5',
         regs['A'], regs['K'], len(FACTOR_VARS), len(FACTOR_VARS)+2),
        ('shape adds over standalone moments',
         regs['L'], regs['M'], 2, 4),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fstat, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fstat): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<44} F={fstat:6.2f}  p={p:.4f}  {sig}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs_all, regs_ind, outpath='sensitivity_curve.png'):
    req = (['mean_excess','beta_avg'] + SHAPE_VARS + FACTOR_VARS)
    sub = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16, 14))
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
    scatter_fit(ax2, regs_all['G'], 'G: beta_avg + asym + convexity')

    ax3 = fig.add_subplot(gs[0,2])
    scatter_fit(ax3, regs_all['K'], 'K: FF5 + asym + convexity')

    # Mean sensitivity curves: decile vs industry
    ax4 = fig.add_subplot(gs[1,0])
    q_cols  = ['beta_q1','beta_q2','beta_q3','beta_q4','beta_q5']
    q_labels= ['Q1\nworst','Q2','Q3\nnormal','Q4','Q5\nbest']
    for pt, grp in sub.groupby('portfolio_type'):
        means = [grp[c].mean() for c in q_cols]
        stds  = [grp[c].std()  for c in q_cols]
        ax4.plot(range(1,6), means, marker='o', label=pt,
                 color=colors[pt], lw=2)
        ax4.fill_between(range(1,6),
                         [m-s for m,s in zip(means,stds)],
                         [m+s for m,s in zip(means,stds)],
                         alpha=0.15, color=colors[pt])
    ax4.set_xticks(range(1,6))
    ax4.set_xticklabels(q_labels, fontsize=8)
    ax4.set_ylabel('Beta')
    ax4.set_title('Mean Sensitivity Curve by Market Quintile\n(±1 std shaded)')
    ax4.legend(fontsize=8)
    ax4.axhline(sub['beta_avg'].mean(), ls='--', color='gray', lw=1,
                alpha=0.6, label='avg beta')

    # Tail asymmetry vs return
    ax5 = fig.add_subplot(gs[1,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax5.scatter(grp['tail_asymmetry'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax5.set_xlabel('Tail Asymmetry (crash amp - boom amp)')
    ax5.set_ylabel('Mean Excess Return (%)')
    ax5.set_title('Tail Asymmetry vs Return\n(+ = crashes harder than rallies)')
    corr = sub['tail_asymmetry'].corr(sub['mean_excess'])
    ax5.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax5.transAxes, fontsize=8, color='navy')

    # Curve convexity vs return
    ax6 = fig.add_subplot(gs[1,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax6.scatter(grp['curve_convexity'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax6.set_xlabel('Curve Convexity ((Q1+Q5)/2 - Q3)')
    ax6.set_ylabel('Mean Excess Return (%)')
    ax6.set_title('Curve Convexity vs Return\n(+ = amplifies both tails)')
    corr = sub['curve_convexity'].corr(sub['mean_excess'])
    ax6.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax6.transAxes, fontsize=8, color='navy')

    # Asymmetry vs convexity scatter coloured by return
    ax7 = fig.add_subplot(gs[2,0])
    sc = ax7.scatter(sub['tail_asymmetry'], sub['curve_convexity'],
                     c=sub['mean_excess']*100, cmap='RdYlGn',
                     alpha=0.7, s=30)
    plt.colorbar(sc, ax=ax7, label='Mean excess return (%)')
    ax7.axhline(0, color='gray', lw=0.5, ls='--')
    ax7.axvline(0, color='gray', lw=0.5, ls='--')
    ax7.set_xlabel('Tail Asymmetry')
    ax7.set_ylabel('Curve Convexity')
    ax7.set_title('Asymmetry vs Convexity\n(coloured by return)')

    # R² comparison bar chart
    ax8 = fig.add_subplot(gs[2,1:])
    mkeys   = ['A','B','C','D','E','F','G','H','I','J','K','L','M']
    mlabels = ['A\nFF5','B\nβavg','C\nasym','D\nconv','E\nβ+asym',
               'F\nβ+conv','G\nβ+a+c','H\nall','I\nF+asym',
               'J\nF+conv','K\nF+a+c','L\nmom','M\nm+a+c']
    r2_all = [regs_all.get(k, type('',(),{'rsquared':0})()).rsquared
              for k in mkeys]
    r2_ind = [regs_ind.get(k, type('',(),{'rsquared':0})()).rsquared
              if regs_ind else 0 for k in mkeys]
    x = np.arange(len(mkeys))
    ax8.bar(x-0.2, r2_all, 0.35, label='All portfolios',
            color='steelblue', alpha=0.8)
    ax8.bar(x+0.2, r2_ind, 0.35, label='Industry only',
            color='darkorange', alpha=0.8)
    ax8.set_xticks(x); ax8.set_xticklabels(mlabels, fontsize=7)
    ax8.set_ylabel('R²')
    ax8.set_title('R² Across Models (blue=all, orange=industry)')
    ax8.legend(fontsize=8)

    fig.suptitle(
        'Sensitivity Curve Test: Tail Asymmetry & Convexity vs Returns',
        fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Sensitivity Curve Test (High Resolution)")
    print("Tail asymmetry and curve convexity as pricing factors")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    df = build_cross_section(all_factors, deciles, industries, n_bins=5)

    shape_diagnostic(df)

    regs_all, sub_all = run_regressions(df, 'All portfolios')

    ind_df = df[df['portfolio_type']=='industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_regressions(
            ind_df, 'Industry portfolios only (unbiased)')

    print("\nGenerating plots...")
    make_plots(df, regs_all, regs_ind)

    # Summary
    ra = regs_all['A']
    rg = regs_all['G']
    rk = regs_all['K']
    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    asym_mean = df['tail_asymmetry'].mean()
    conv_mean = df['curve_convexity'].mean()
    dominant  = 'CONVEXITY' if abs(conv_mean)>abs(asym_mean) else 'ASYMMETRY'
    print(f"  Dominant nonlinearity: {dominant}")
    print(f"    mean tail_asymmetry:  {asym_mean:+.4f}")
    print(f"    mean curve_convexity: {conv_mean:+.4f}")
    print()
    print(f"  FF5 R²:                        {ra.rsquared:.4f}")
    print(f"  beta_avg + asym + convexity R²: {rg.rsquared:.4f}  "
          f"({rg.rsquared/ra.rsquared*100:.1f}% of FF5)")
    print(f"  FF5 + asym + convexity R²:      {rk.rsquared:.4f}")
    t_asym = rg.tvalues.get('tail_asymmetry', np.nan)
    t_conv = rg.tvalues.get('curve_convexity', np.nan)
    print()
    for name, t in [('tail_asymmetry', t_asym),
                    ('curve_convexity', t_conv)]:
        sig = 'significant' if abs(t) > 2 else 'not significant'
        sign = '✓' if t > 0 else '✗ (wrong sign)'
        print(f"  {name}: t={t:+.2f} — {sig} {sign if abs(t)>2 else ''}")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()
