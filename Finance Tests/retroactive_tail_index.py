"""
Retroactive Tail Index Test
============================
Cleanest possible test: does realised full-sample systematic tail index
explain cross-sectional variation in realised full-sample mean returns,
and does it mediate FF5 factor explanatory power?

No rolling windows. No forward prediction. Just:
  - Full sample (1963-2026) tail index for each portfolio
  - Full sample mean excess return for each portfolio
  - Cross-sectional regression

Key questions:
  1. What % of cross-sectional return variation does tail index explain?
  2. Does tail index outperform sys_var and sys_tail?
  3. Does tail index absorb factor explanatory power?
     (how much does each factor coefficient shrink?)
  4. Does tail index plus sys_var and sys_tail together
     explain more than any alone? (are they complementary?)
  5. What is the implied relative pricing of each risk dimension?

Test assets: FF5 decile portfolios + 49 industry portfolios
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
from sklearn.preprocessing import StandardScaler
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
# 2.  HILL ESTIMATOR
# ══════════════════════════════════════════════════════════════════════════════

def hill_estimator(losses, k_fraction=0.10, min_k=10):
    """
    Hill estimator for tail index α.
    Applied to portfolio losses in market tail months.
    Lower α = fatter systematic tail = riskier.
    """
    losses = np.asarray(losses, dtype=float)
    losses = losses[losses > 0]
    losses = np.sort(losses)[::-1]
    n = len(losses)
    if n < min_k:
        return np.nan, 0
    k = max(min_k, int(n * k_fraction))
    k = min(k, n - 1)
    log_ratios = np.log(losses[:k] / losses[k])
    if np.sum(log_ratios) <= 0:
        return np.nan, 0
    return float(k / np.sum(log_ratios)), k


# ══════════════════════════════════════════════════════════════════════════════
# 3.  PORTFOLIO CHARACTERISTICS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def compute_chars(ret_series, factors_df):
    """Full-sample characteristics for one portfolio."""
    idx = ret_series.index.intersection(factors_df.index)
    ret = ret_series.loc[idx].dropna() / 100
    idx = ret.index.intersection(factors_df.index)
    if len(idx) < 60:
        return None

    r   = ret.loc[idx]
    rf  = factors_df.loc[idx,'RF']  / 100
    mkt = factors_df.loc[idx,'Mkt-RF'] / 100
    smb = factors_df.loc[idx,'SMB'] / 100
    hml = factors_df.loc[idx,'HML'] / 100
    rmw = factors_df.loc[idx,'RMW'] / 100
    cma = factors_df.loc[idx,'CMA'] / 100
    mom_s = factors_df.loc[idx,'MOM'] / 100 \
            if 'MOM' in factors_df.columns \
            else pd.Series(0.0, index=idx)

    r_exc  = r - rf
    rm_exc = mkt

    # Factor loadings
    Xf  = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt,'SMB': smb,'HML': hml,
        'RMW': rmw,'CMA': cma,'MOM': mom_s}))
    reg  = sm.OLS(r_exc, Xf).fit()
    beta = float(reg.params['Mkt-RF'])
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    # Systematic variance
    sys_var = float(beta**2 * rm_exc.var())

    # Tail measures at multiple thresholds
    tail_results = {}
    for q, ql in [(0.05,'q5'),(0.10,'q10'),(0.20,'q20')]:
        thresh    = float(np.percentile(rm_exc.dropna(), q*100))
        tail_mask = rm_exc <= thresh
        r_tail    = r_exc[tail_mask]
        rm_tail   = rm_exc[tail_mask]

        # sys_tail: mean return in market tail months
        sys_tail = float(r_tail.mean()) if len(r_tail) > 3 else np.nan

        # Tail index: Hill estimator on losses in market tail months
        losses   = -r_tail.values
        alpha, n_used = hill_estimator(losses, k_fraction=0.5,
                                        min_k=max(5, len(losses)//3))

        # Tail beta
        if len(r_tail) > 5 and rm_tail.var() > 1e-12:
            tail_beta = float(np.cov(r_tail, rm_tail)[0,1] / rm_tail.var())
        else:
            tail_beta = np.nan

        tail_results[f'sys_tail_{ql}']   = sys_tail
        tail_results[f'tail_alpha_{ql}'] = alpha
        tail_results[f'neg_alpha_{ql}']  = -alpha if not np.isnan(alpha) else np.nan
        tail_results[f'tail_beta_{ql}']  = tail_beta
        tail_results[f'n_tail_{ql}']     = n_used

    # Standalone moments
    sigma  = float(r_exc.std())
    skew   = float(stats.skew(r_exc.dropna()))
    kurt   = float(stats.kurtosis(r_exc.dropna()))
    var_5  = float(np.percentile(r_exc.dropna(), 5))

    # Mean excess return (annualised)
    mean_excess = float(r_exc.mean() * 12)

    return {
        'mean_excess': mean_excess,
        'n_obs':       len(idx),
        **loadings,
        'beta':        beta,
        'sys_var':     sys_var,
        'sigma':       sigma,
        'skewness':    skew,
        'kurtosis':    kurt,
        'var_5':       var_5,
        **tail_results,
    }


def build_cross_section(all_factors, deciles, industries):
    print("\nBuilding full-sample cross-section...")
    rows = []
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s   = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_chars(s.loc[idx], all_factors.loc[idx])
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)
    for col in industries.columns:
        s   = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_chars(s.loc[idx], all_factors.loc[idx])
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios  "
          f"({(df.portfolio_type=='decile').sum()} decile, "
          f"{(df.portfolio_type=='industry').sum()} industry)")

    # Report tail index summary
    print(f"\n  Tail index summary (full sample, ~{int(df.n_obs.mean())} months):")
    for ql in ['q5','q10','q20']:
        col = f'tail_alpha_{ql}'
        v   = df[col].dropna()
        n   = df[f'n_tail_{ql}'].mean()
        print(f"    {ql}: α mean={v.mean():.2f}  std={v.std():.2f}  "
              f"min={v.min():.2f}  max={v.max():.2f}  "
              f"(avg {n:.0f} tail obs)")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 4.  CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

def run_cross_section(df, label='All portfolios'):
    req = (FACTOR_VARS +
           ['mean_excess','sys_var',
            'sys_tail_q5','sys_tail_q10','sys_tail_q20',
            'neg_alpha_q5','neg_alpha_q10','neg_alpha_q20',
            'sigma','var_5'])
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Retroactive Tail Index Test: {label}  (N={n})")
    print(f"{'='*65}")

    # Models
    models = {
        'A  FF5 factors':                      FACTOR_VARS,
        'B  sys_var only':                     ['sys_var'],
        'C  sys_tail (q10) only':              ['sys_tail_q10'],
        'D  neg_alpha (q10) only':             ['neg_alpha_q10'],
        'E  sys_var + sys_tail [2D]':          ['sys_var','sys_tail_q10'],
        'F  sys_var + neg_alpha':              ['sys_var','neg_alpha_q10'],
        'G  sys_tail + neg_alpha':             ['sys_tail_q10','neg_alpha_q10'],
        'H  3D: var + tail + alpha':           ['sys_var','sys_tail_q10',
                                                'neg_alpha_q10'],
        'I  alpha at q5':                      ['neg_alpha_q5'],
        'J  alpha at q20':                     ['neg_alpha_q20'],
        'K  3D at q5':                         ['sys_var','sys_tail_q5',
                                                'neg_alpha_q5'],
        'L  3D at q20':                        ['sys_var','sys_tail_q20',
                                                'neg_alpha_q20'],
        'M  FF5 + neg_alpha':                  FACTOR_VARS + ['neg_alpha_q10'],
        'N  FF5 + 2D risk':                    FACTOR_VARS + ['sys_var',
                                                               'sys_tail_q10'],
        'O  FF5 + 3D risk':                    FACTOR_VARS + ['sys_var',
                                                'sys_tail_q10','neg_alpha_q10'],
    }

    regs = {}
    ra   = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra

    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<42} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*60)
    print(f"  {'A  FF5 factors':<42} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<42} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # ── Standardised coefficients ─────────────────────────────────────────────
    risk_vars = ['sys_var','sys_tail_q10','neg_alpha_q10',
                 'neg_alpha_q5','neg_alpha_q20']
    scaler    = StandardScaler()
    sub_std   = sub.copy()
    sub_std[risk_vars] = scaler.fit_transform(sub[risk_vars])
    stds = sub[risk_vars].std()

    rh_std = sm.OLS(y, sm.add_constant(
        sub_std[['sys_var','sys_tail_q10','neg_alpha_q10']])).fit()

    print(f"\n── Standardised 3D Risk Coefficients ────────────────────────────")
    print(f"  Each coef = annualised % return per 1-SD increase")
    print(f"  {'Variable':<20} {'1-SD':>10} {'Std coef':>10} "
          f"{'t-stat':>8}  Theory  Sig?")
    print("  " + "-"*64)
    for v, theory in [('sys_var','+'),('sys_tail_q10','+'),
                       ('neg_alpha_q10','+')]:
        c  = rh_std.params.get(v, np.nan)
        t  = rh_std.tvalues.get(v, np.nan)
        sd = stds.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        match = '✓' if (c>0)==(theory=='+') else '✗'
        print(f"  {v:<20} {sd:>+10.5f} {c*100:>+9.3f}%  "
              f"{t:>+8.2f}  {theory}  {match}  {sig}")

    # ── Does alpha add over 2D? ───────────────────────────────────────────────
    print(f"\n── Does Tail Index Add Over 2D Risk? ────────────────────────────")
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f<=k_r: return np.nan, np.nan
        fs = ((r2_f-r2_r)/(k_f-k_r))/((1-r2_f)/(n-k_f))
        return fs, 1-f_dist.cdf(fs,k_f-k_r,n-k_f)

    tests = [
        ('neg_alpha adds over sys_var alone',
         regs['B'], regs['F'], 1, 2),
        ('neg_alpha adds over sys_tail alone',
         regs['C'], regs['G'], 1, 2),
        ('neg_alpha adds over 2D (var+tail)',
         regs['E'], regs['H'], 2, 3),
        ('3D risk adds over FF5',
         regs['A'], regs['O'], len(FACTOR_VARS), len(FACTOR_VARS)+3),
        ('FF5 adds over 3D risk',
         regs['H'], regs['O'], 3, len(FACTOR_VARS)+3),
        ('2D risk adds over FF5',
         regs['A'], regs['N'], len(FACTOR_VARS), len(FACTOR_VARS)+2),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    # ── Factor shrinkage under 3D risk ────────────────────────────────────────
    print(f"\n── Factor Coefficient Shrinkage A → O (FF5 + 3D risk) ───────────")
    ro = regs['O']
    print(f"  {'Factor':<14} {'A coef':>10} {'O coef':>10} "
          f"{'Shrink':>8}  {'A t':>6}  {'O t':>6}")
    print("  " + "-"*58)
    for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        co = ro.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        to = ro.tvalues.get(v, np.nan)
        sh = (1-abs(co)/abs(ca))*100 if abs(ca)>1e-10 else np.nan
        sa = '*' if abs(ta)>2 else ' '
        so = '*' if abs(to)>2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {co:>+10.4f} "
              f"{sh:>7.1f}%  {ta:>+5.2f}{sa}  {to:>+5.2f}{so}")

    # ── Threshold robustness ──────────────────────────────────────────────────
    print(f"\n── Tail Index Robustness Across Thresholds ──────────────────────")
    print(f"  {'Threshold':<12} {'α R²':>8} {'α alone t':>10} "
          f"{'adds over 2D?':>14} {'2D+α R²':>9}")
    print("  " + "-"*58)
    for ql, q in [('q5',0.05),('q10',0.10),('q20',0.20)]:
        na_col  = f'neg_alpha_{ql}'
        st_col  = f'sys_tail_{ql}'
        req_q   = ['mean_excess','sys_var', st_col, na_col]
        sub_q   = sub.dropna(subset=req_q)
        y_q     = sub_q['mean_excess']
        r_na    = sm.OLS(y_q, sm.add_constant(sub_q[[na_col]])).fit()
        r_2d    = sm.OLS(y_q, sm.add_constant(sub_q[['sys_var',st_col]])).fit()
        r_3d    = sm.OLS(y_q, sm.add_constant(
                    sub_q[['sys_var',st_col,na_col]])).fit()
        t_na    = r_na.tvalues.get(na_col, np.nan)
        fs, p   = ft(r_2d.rsquared, r_3d.rsquared,
                     len(sub_q), 4, 3)
        sig     = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no')
        print(f"  {ql:<12} {r_na.rsquared:>8.4f} {t_na:>+10.2f} "
              f"{sig:>14}  {r_3d.rsquared:>9.4f}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs_all, regs_ind, outpath='retroactive_tail_index.png'):
    req = (FACTOR_VARS + ['mean_excess','sys_var','sys_tail_q10',
                           'neg_alpha_q10','tail_alpha_q10'])
    sub = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16, 12))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.38)

    def scatter(ax, reg, title, sub_=None):
        if sub_ is None: sub_ = sub
        yhat = reg.fittedvalues
        for pt, grp in sub_.groupby('portfolio_type'):
            ax.scatter(yhat.loc[grp.index]*100, grp['mean_excess']*100,
                       alpha=0.5, s=20, color=colors[pt], label=pt)
        lo = min(yhat.min(), sub_['mean_excess'].min())*100-0.3
        hi = max(yhat.max(), sub_['mean_excess'].max())*100+0.3
        ax.plot([lo,hi],[lo,hi],'k--',lw=1,alpha=0.4)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel('Fitted (%)'); ax.set_ylabel('Realised (%)')
        ax.text(0.05,0.92,f'R²={reg.rsquared:.3f}',
                transform=ax.transAxes, fontsize=8, color='navy')

    ax1 = fig.add_subplot(gs[0,0])
    scatter(ax1, regs_all['A'], 'A: FF5 Factors')
    ax1.legend(fontsize=6)

    ax2 = fig.add_subplot(gs[0,1])
    if 'H' in regs_all:
        scatter(ax2, regs_all['H'], 'H: 3D Risk (var+tail+α)')

    ax3 = fig.add_subplot(gs[0,2])
    if 'O' in regs_all:
        scatter(ax3, regs_all['O'], 'O: FF5 + 3D Risk')

    # Tail alpha vs return
    ax4 = fig.add_subplot(gs[1,0])
    for pt, grp in sub.groupby('portfolio_type'):
        ax4.scatter(grp['tail_alpha_q10'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax4.set_xlabel('Tail Index α (10%)')
    ax4.set_ylabel('Mean Excess Return (%)')
    ax4.set_title('Tail Index vs Return\n(lower α = fatter tail = higher return)')
    corr = sub['tail_alpha_q10'].corr(sub['mean_excess'])
    ax4.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax4.transAxes, fontsize=8, color='navy')

    # sys_tail vs neg_alpha (how correlated?)
    ax5 = fig.add_subplot(gs[1,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax5.scatter(grp['sys_tail_q10']*100, grp['neg_alpha_q10'],
                    alpha=0.5, s=20, color=colors[pt])
    ax5.set_xlabel('sys_tail (%)')
    ax5.set_ylabel('neg_alpha (= −tail index)')
    ax5.set_title('sys_tail vs Tail Index\n(orthogonal → independent dimensions)')
    corr = sub['sys_tail_q10'].corr(sub['neg_alpha_q10'])
    ax5.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax5.transAxes, fontsize=8, color='navy')

    # R² bar chart
    ax6 = fig.add_subplot(gs[1,2])
    mkeys = ['A','B','C','D','E','F','G','H','M','N','O']
    mlabs = ['FF5','var','tail','α','var\n+tail','var\n+α',
             'tail\n+α','3D','FF5\n+α','FF5\n+2D','FF5\n+3D']
    r2_all = [regs_all.get(k,type('',(),{'rsquared':0})()).rsquared
              for k in mkeys]
    r2_ind = [regs_ind.get(k,type('',(),{'rsquared':0})()).rsquared
              if regs_ind else 0 for k in mkeys]
    x = np.arange(len(mkeys))
    ax6.bar(x-0.2, r2_all, 0.35, label='All', color='steelblue', alpha=0.8)
    ax6.bar(x+0.2, r2_ind, 0.35, label='Industry', color='darkorange', alpha=0.8)
    ax6.set_xticks(x); ax6.set_xticklabels(mlabs, fontsize=7)
    ax6.set_ylabel('R²'); ax6.set_title('R² by Model')
    ax6.legend(fontsize=7)

    # Factor shrinkage
    ax7 = fig.add_subplot(gs[2,:2])
    fnames = [v.replace('load_','') for v in FACTOR_VARS]
    coef_a = [regs_all['A'].params.get(v,0) for v in FACTOR_VARS]
    coef_o = [regs_all['O'].params.get(v,0) for v in FACTOR_VARS] \
              if 'O' in regs_all else [0]*len(FACTOR_VARS)
    x2 = np.arange(len(FACTOR_VARS))
    ax7.bar(x2-0.2, coef_a, 0.35, label='FF5 alone (A)',
            color='steelblue', alpha=0.8)
    if 'O' in regs_all:
        ax7.bar(x2+0.2, coef_o, 0.35, label='FF5+3D risk (O)',
                color='coral', alpha=0.8)
    ax7.axhline(0, color='black', lw=0.5)
    ax7.set_xticks(x2); ax7.set_xticklabels(fnames)
    ax7.set_title('Factor Coefficient Shrinkage: A → O')
    ax7.legend(fontsize=8)

    # Tail index distribution
    ax8 = fig.add_subplot(gs[2,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax8.hist(grp['tail_alpha_q10'].dropna(), bins=12, alpha=0.6,
                 label=pt, color=colors[pt])
    ax8.axvline(2, color='red', ls='--', lw=1, label='α=2')
    ax8.axvline(3, color='orange', ls='--', lw=1, label='α=3')
    ax8.set_xlabel('Tail Index α'); ax8.set_title('Distribution of α Estimates')
    ax8.legend(fontsize=7)

    fig.suptitle('Retroactive Tail Index Test: Does α Explain Cross-Sectional Returns?',
                 fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Retroactive Tail Index Test")
    print("Full-sample α vs full-sample returns — cleanest possible test")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    df = build_cross_section(all_factors, deciles, industries)

    # All portfolios
    regs_all, sub_all = run_cross_section(df, 'All portfolios')

    # Industry only
    ind_df  = df[df['portfolio_type']=='industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_cross_section(ind_df, 'Industry portfolios only')

    # Plots
    print("\nGenerating plots...")
    make_plots(df, regs_all, regs_ind)

    # Summary
    ra = regs_all['A']
    rd = regs_all.get('D')
    rh = regs_all.get('H')
    ro = regs_all.get('O')

    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    print(f"  N portfolios:              {len(sub_all)}")
    print(f"  FF5 factors R²:            {ra.rsquared:.4f}")
    if rd:
        print(f"  neg_alpha alone R²:        {rd.rsquared:.4f}  "
              f"({rd.rsquared/ra.rsquared*100:.1f}% of FF5)")
    if rh:
        print(f"  3D risk (var+tail+α) R²:   {rh.rsquared:.4f}  "
              f"({rh.rsquared/ra.rsquared*100:.1f}% of FF5)")
    if ro:
        print(f"  FF5 + 3D risk R²:          {ro.rsquared:.4f}")

    # Key finding: does α add over 2D?
    re = regs_all.get('E')
    if re and rh:
        delta = rh.rsquared - re.rsquared
        t_a   = rh.tvalues.get('neg_alpha_q10', np.nan)
        print(f"\n  Does tail index add over 2D risk?")
        print(f"    ΔR² = {delta:.4f}  t(neg_alpha) = {t_a:+.2f}")
        if abs(t_a) > 2:
            print(f"    YES — power law shape is independently priced")
        else:
            print(f"    NO  — 2D risk is sufficient; α adds nothing")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()
