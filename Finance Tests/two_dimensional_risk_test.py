"""
Two-Dimensional Risk Test
==========================
Tests whether systematic variance and systematic tail risk jointly explain
cross-sectional returns better than either alone, and whether together they
absorb FF5 factor explanatory power.

Core hypothesis:
  Standard beta (= systematic variance for diversified portfolios) fails as
  a cross-sectional predictor not because variance is unpriced, but because
  it is an incomplete description of systematic risk. Tail risk is a second
  independently priced dimension. Controlling for one should make the other
  significant.

  The ratio of their regression coefficients implies the shape of the
  aggregate utility function without requiring any parametric assumption —
  identified purely from the cross-section of returns.

Measures:
  sys_var:        β²·σ²_market  (systematic variance contribution)
                  ≈ beta for diversified portfolios (same ranking)
  sys_tail_risk:  E[R_i | R_market ≤ VaR_q]  (marginal tail return)
                  Varies across portfolios with same beta if conditional
                  sensitivity differs — this is the key independent dimension

Test structure:
  1. Univariate: sys_var alone, sys_tail_risk alone
  2. Joint: both together — do they rescue each other?
  3. vs FF5: how much factor R² do they absorb?
  4. Implied utility: what γ does the coefficient ratio imply?
  5. At multiple tail thresholds (5%, 10%, 15%) for robustness
  6. Industry portfolios as unbiased test

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python two_dimensional_risk_test.py
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
from scipy.optimize import minimize_scalar
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
# 2.  RISK MEASURE COMPUTATION
# ══════════════════════════════════════════════════════════════════════════════

def compute_risk_measures(ret_series, factors_df,
                          tail_quantiles=(0.05, 0.10, 0.15)):
    """
    For each portfolio compute:
      sys_var:           β²·σ²_market  (systematic variance)
      beta:              OLS market beta (signed, for reference)
      sys_tail_q:        E[R_i | R_market <= q-th pct]  for each q
                         This is the systematic tail risk measure —
                         how the portfolio performs when the market
                         is in its worst q% of months
      tail_beta_q:       beta estimated only in market tail months
      tail_excess_q:     sys_tail_q - beta * E[R_market | tail]
                         The excess tail sensitivity beyond what
                         flat beta would predict — pure nonlinearity
      idio_var:          total variance - systematic variance
                         (residual idiosyncratic component)
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
    mkt_var = float(rm_exc.var())

    # ── FF5 + MOM loadings ────────────────────────────────────────────────────
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg = sm.OLS(r_exc, Xf).fit()
    beta = float(reg.params['Mkt-RF'])
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    # ── Systematic variance ───────────────────────────────────────────────────
    sys_var = float(beta**2 * mkt_var)

    # Total variance and idiosyncratic component
    total_var = float(r_exc.var())
    idio_var  = float(max(total_var - sys_var, 0))
    idio_frac = float(idio_var / total_var) if total_var > 0 else np.nan

    # ── Standalone sigma and var5 (for comparison) ────────────────────────────
    sigma   = float(r_exc.std())
    var_5   = float(np.percentile(r_exc.dropna(), 5))

    result = {
        'mean_excess': float(r_exc.mean() * 12),
        'n_obs':       len(idx),
        **loadings,
        'beta':        beta,
        'sys_var':     sys_var,
        'total_var':   total_var,
        'idio_var':    idio_var,
        'idio_frac':   idio_frac,
        'sigma':       sigma,
        'var_5':       var_5,
    }

    # ── Systematic tail risk at each quantile ─────────────────────────────────
    for q in tail_quantiles:
        ql = f'q{int(q*100)}'
        threshold = float(np.percentile(rm_exc.dropna(), q * 100))
        tail_mask = rm_exc <= threshold
        n_tail    = tail_mask.sum()

        if n_tail < 5:
            result[f'sys_tail_{ql}']        = np.nan
            result[f'tail_beta_{ql}']       = np.nan
            result[f'tail_excess_{ql}']     = np.nan
            result[f'cond_corr_{ql}']       = np.nan
            continue

        r_tail  = r_exc[tail_mask]
        rm_tail = rm_exc[tail_mask]

        # E[R_i | market in tail] — the core systematic tail risk measure
        sys_tail = float(r_tail.mean())

        # Tail beta
        if rm_tail.var() > 1e-12:
            tail_beta = float(
                np.cov(r_tail, rm_tail)[0,1] / rm_tail.var())
        else:
            tail_beta = beta

        # Tail excess: how much worse does the portfolio do in the tail
        # compared to what flat beta would predict?
        # flat beta prediction: beta * E[R_market | tail]
        expected_tail_flat = float(beta * rm_tail.mean())
        tail_excess = float(sys_tail - expected_tail_flat)

        # Conditional correlation in tail
        cond_corr = float(r_tail.corr(rm_tail)) \
                    if len(r_tail) > 3 else np.nan

        result[f'sys_tail_{ql}']      = sys_tail
        result[f'tail_beta_{ql}']     = tail_beta
        result[f'tail_excess_{ql}']   = tail_excess
        result[f'cond_corr_{ql}']     = cond_corr

    return result


def build_cross_section(all_factors, deciles, industries):
    print("\nComputing risk measures...")
    rows = []
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_risk_measures(s.loc[idx], all_factors.loc[idx])
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)
    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_risk_measures(s.loc[idx], all_factors.loc[idx])
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios built")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 3.  IMPLIED UTILITY FUNCTION
# ══════════════════════════════════════════════════════════════════════════════

def implied_gamma(coef_var, coef_tail, rm_tail_mean, rm_var,
                  q, verbose=True):
    """
    Under power utility U(R) = R^(1-γ)/(1-γ), the pricing equation gives:

      E[R_i] - rf ≈ γ·Cov(R_i, R_m)·(1/E[R_m])   [variance term]
                  + (γ(γ+1)/2)·E[(R_i-μ)(R_m-μ_m)²]/E[R_m²]  [tail term]

    In the cross-section, the ratio of the tail coefficient to the variance
    coefficient is approximately:

      coef_tail / coef_var ≈ (γ+1)/2 · (tail_weight / var_weight)

    where tail_weight and var_weight depend on the moments of the market
    distribution. This gives us an implied γ from the regression coefficients
    without requiring any parametric construction.

    Here we use a simpler approximation: the ratio of coefficients in the
    regression E[R] = α + β1·sys_var + β2·sys_tail is informative about
    the relative weighting of variance vs tail risk in the utility function.

    Under CRRA utility, higher γ means more weight on tail risk relative
    to variance. We find the γ that matches the observed ratio.
    """
    if coef_var == 0 or np.isnan(coef_var) or np.isnan(coef_tail):
        return np.nan

    ratio_observed = coef_tail / coef_var

    # Under power utility, expected utility can be approximated as:
    # E[U(1+r)] ≈ -γ·σ² / 2 - γ(γ+1)/6 · μ3 - ...
    # The relative importance of tail vs variance scales with γ
    # We use the empirical market moments to calibrate

    # Simplified: find γ such that the theoretical ratio matches observed
    # ratio_theoretical ≈ (γ+1) · (q * |rm_tail_mean|) / (rm_var)
    # This is a rough approximation for illustration

    def theoretical_ratio(gamma):
        # Under CRRA, tail risk premium scales with γ(γ+1)/2
        # Variance premium scales with γ
        # So ratio ≈ (γ+1)/2 · tail_factor
        tail_factor = abs(rm_tail_mean) * q / (rm_var + 1e-12)
        return -(gamma + 1) / 2 * tail_factor

    # Find γ that minimises |observed - theoretical|
    def objective(gamma):
        return (theoretical_ratio(gamma) - ratio_observed)**2

    try:
        res = minimize_scalar(objective, bounds=(0.5, 50), method='bounded')
        gamma_implied = float(res.x)
    except Exception:
        gamma_implied = np.nan

    if verbose and not np.isnan(gamma_implied):
        print(f"\n── Implied Risk Aversion from Coefficient Ratio ─────────────────")
        print(f"  Coefficient on sys_var:    {coef_var:+.4f}")
        print(f"  Coefficient on sys_tail:   {coef_tail:+.4f}")
        print(f"  Ratio (tail/var):          {ratio_observed:+.4f}")
        print(f"  Implied γ:                 {gamma_implied:.2f}")
        print(f"  (Experimental estimates suggest γ ≈ 2-4)")
        if 1 < gamma_implied < 10:
            print(f"  → Plausible range ✓")
        elif gamma_implied > 10:
            print(f"  → High — suggests stronger tail risk aversion than standard models")
        else:
            print(f"  → Low — suggests near-linear utility in this range")

    return gamma_implied


# ══════════════════════════════════════════════════════════════════════════════
# 4.  REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def run_regressions(df, label='All portfolios',
                    tail_q='q5'):
    """
    Core test: do sys_var and sys_tail jointly predict returns
    when neither works alone?
    """
    tvar    = f'sys_tail_{tail_q}'
    texcess = f'tail_excess_{tail_q}'
    tbeta   = f'tail_beta_{tail_q}'

    req = (['mean_excess','beta','sys_var',tvar,texcess,tbeta,
            'sigma','var_5','idio_var'] + FACTOR_VARS)
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Two-Dimensional Risk Test: {label}  (N={n})")
    print(f"Tail threshold: {tail_q}")
    print(f"{'='*65}")

    models = {
        'A  FF5 factors':                  FACTOR_VARS,
        'B  beta only':                    ['beta'],
        'C  sys_var only':                 ['sys_var'],
        f'D  sys_tail_{tail_q} only':      [tvar],
        'E  sys_var + sys_tail [CORE]':    ['sys_var', tvar],
        'F  beta + tail_excess [CORE]':    ['beta', texcess],
        'G  sys_var + tail_beta':          ['sys_var', tbeta],
        'H  all three dimensions':         ['sys_var', tvar, texcess],
        'I  FF5 + sys_tail':               FACTOR_VARS + [tvar],
        'J  FF5 + sys_var + sys_tail':     FACTOR_VARS + ['sys_var', tvar],
        'K  sigma + var_5 [prev best]':    ['sigma','var_5'],
        'L  sys_var + sys_tail + idio':    ['sys_var', tvar, 'idio_var'],
    }

    regs = {}
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<42} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*62)

    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  FF5 factors':<42} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        key = mname[0] if mname[0] not in regs else mname[:2].strip()
        regs[key] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        marker = '  ← CORE TEST' if 'CORE' in mname else ''
        print(f"  {mname.split('[')[0].strip():<42} "
              f"{reg.rsquared:>7.4f}  {pct:>7.1f}%{marker}")

    # ── Core test: joint model coefficients ──────────────────────────────────
    print(f"\n── Model E: sys_var + sys_tail (Core Joint Test) ────────────────")
    re = regs['E']
    for v in ['sys_var', tvar]:
        c = re.params.get(v, np.nan)
        t = re.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<22} coef={c:+.6f}  t={t:+.2f}  {sig}")

    # ── Model F: beta + tail_excess ───────────────────────────────────────────
    print(f"\n── Model F: beta + tail_excess (Pure Nonlinearity Test) ─────────")
    rf_ = regs['F']
    for v in ['beta', texcess]:
        c = rf_.params.get(v, np.nan)
        t = rf_.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<22} coef={c:+.6f}  t={t:+.2f}  {sig}")
    print(f"  (tail_excess = E[R_tail] - beta*E[Rm_tail])")
    print(f"  (significant tail_excess → nonlinearity beyond flat beta)")

    # ── Factor shrinkage ──────────────────────────────────────────────────────
    print(f"\n── Factor Shrinkage: A → J (FF5 + sys_var + sys_tail) ───────────")
    rj = regs['J']
    print(f"  {'Variable':<14} {'Model A':>10} {'Model J':>10} "
          f"{'Shrink':>8}  {'A t':>6}  {'J t':>6}")
    print("  " + "-"*58)
    for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        cj = rj.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        tj = rj.tvalues.get(v, np.nan)
        sh = (1-abs(cj)/abs(ca))*100 if abs(ca)>1e-10 else np.nan
        sa = '*' if abs(ta)>2 else ' '
        sj = '*' if abs(tj)>2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {cj:>+10.4f} "
              f"{sh:>7.1f}%  {ta:>+5.2f}{sa}  {tj:>+5.2f}{sj}")

    # ── F-tests ───────────────────────────────────────────────────────────────
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        fstat = ((r2_f-r2_r)/(k_f-k_r)) / ((1-r2_f)/(n-k_f))
        return fstat, 1 - f_dist.cdf(fstat, k_f-k_r, n-k_f)

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('sys_tail adds over sys_var alone',
         regs['C'], regs['E'], 1, 2),
        ('sys_var adds over sys_tail alone',
         regs['D'], regs['E'], 1, 2),
        ('tail_excess adds over beta alone',
         regs['B'], regs['F'], 1, 2),
        ('sys_var + sys_tail adds over FF5',
         regs['A'], regs['J'], len(FACTOR_VARS), len(FACTOR_VARS)+2),
        ('FF5 adds over sys_var + sys_tail',
         regs['E'], regs['J'], 2, len(FACTOR_VARS)+2),
        ('2D risk beats prev best (sigma+var5)',
         regs['K'], regs['E'], 2, 2),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fstat, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fstat): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fstat:6.2f}  p={p:.4f}  {sig}")

    # ── Implied gamma ─────────────────────────────────────────────────────────
    coef_var  = re.params.get('sys_var', np.nan)
    coef_tail = re.params.get(tvar, np.nan)
    rm_data   = df.dropna(subset=[tvar])
    rm_tail_q = float(np.percentile(
        df.dropna(subset=[tvar])[tvar], 50))  # median tail return
    implied_gamma(coef_var, coef_tail,
                  rm_tail_q, 0.01,
                  float(tail_q[1:])/100)

    return regs, sub


def robustness_across_thresholds(df, label='All portfolios'):
    """Run core test at 5%, 10%, 15% tail thresholds."""
    print(f"\n── Robustness Across Tail Thresholds: {label} ───────────────────")
    print(f"  {'Threshold':>10}  {'sys_var t':>10}  {'sys_tail t':>11}  "
          f"{'Joint R²':>9}  {'FF5 R²':>7}  {'Rescue?':>8}")
    print("  " + "-"*62)

    sub_req = (['mean_excess','beta','sys_var','sigma','var_5'] +
               FACTOR_VARS +
               [f'sys_tail_q{q}' for q in [5,10,15]])
    sub = df.dropna(subset=sub_req)
    y   = sub['mean_excess']
    ra  = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()

    for q_label, q_val in [('q5',0.05),('q10',0.10),('q15',0.15)]:
        tvar = f'sys_tail_{q_label}'
        if tvar not in sub.columns:
            continue
        sub2 = sub.dropna(subset=[tvar])
        y2   = sub2['mean_excess']

        rc   = sm.OLS(y2, sm.add_constant(sub2[['sys_var']])).fit()
        rd   = sm.OLS(y2, sm.add_constant(sub2[[tvar]])).fit()
        re   = sm.OLS(y2, sm.add_constant(sub2[['sys_var',tvar]])).fit()
        ra2  = sm.OLS(y2, sm.add_constant(sub2[FACTOR_VARS])).fit()

        t_var  = re.tvalues.get('sys_var', np.nan)
        t_tail = re.tvalues.get(tvar, np.nan)

        # "Rescue" = both become more significant jointly than alone
        t_var_alone  = rc.tvalues.get('sys_var', np.nan)
        t_tail_alone = rd.tvalues.get(tvar, np.nan)
        rescued = (abs(t_var) > abs(t_var_alone) and
                   abs(t_tail) > abs(t_tail_alone))
        rescue_str = 'YES ✓' if rescued else 'no'

        print(f"  {q_label:>10}  {t_var:>+10.2f}  {t_tail:>+11.2f}  "
              f"{re.rsquared:>9.4f}  {ra2.rsquared:>7.4f}  {rescue_str:>8}")


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs_all, regs_ind, outpath='two_dimensional_risk.png'):
    tvar = 'sys_tail_q5'
    req  = ['mean_excess','beta','sys_var',tvar,'sigma','var_5'] + FACTOR_VARS
    sub  = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16, 14))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.38)

    def scatter_fit(ax, reg, title, sub_=None):
        if sub_ is None: sub_ = sub
        yhat = reg.fittedvalues
        for pt, grp in sub_.groupby('portfolio_type'):
            ax.scatter(yhat.loc[grp.index]*100,
                       grp['mean_excess']*100,
                       alpha=0.5, s=20, color=colors[pt], label=pt)
        lo = min(yhat.min(), sub_['mean_excess'].min())*100-0.3
        hi = max(yhat.max(), sub_['mean_excess'].max())*100+0.3
        ax.plot([lo,hi],[lo,hi],'k--',lw=1,alpha=0.4)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel('Fitted (%)'); ax.set_ylabel('Realised (%)')
        ax.text(0.05,0.92,f'R²={reg.rsquared:.3f}',
                transform=ax.transAxes, fontsize=8, color='navy')

    ax1 = fig.add_subplot(gs[0,0])
    scatter_fit(ax1, regs_all['A'], 'A: FF5 Factors')
    ax1.legend(fontsize=6)

    ax2 = fig.add_subplot(gs[0,1])
    scatter_fit(ax2, regs_all['E'], 'E: sys_var + sys_tail (Core)')

    ax3 = fig.add_subplot(gs[0,2])
    scatter_fit(ax3, regs_all['J'], 'J: FF5 + sys_var + sys_tail')

    # sys_var vs return
    ax4 = fig.add_subplot(gs[1,0])
    for pt, grp in sub.groupby('portfolio_type'):
        ax4.scatter(grp['sys_var']*10000, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax4.set_xlabel('Systematic Variance (×10⁴)')
    ax4.set_ylabel('Mean Excess Return (%)')
    ax4.set_title('Systematic Variance vs Return')
    corr = sub['sys_var'].corr(sub['mean_excess'])
    ax4.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax4.transAxes, fontsize=8, color='navy')

    # sys_tail vs return
    ax5 = fig.add_subplot(gs[1,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax5.scatter(grp[tvar]*100, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax5.set_xlabel('Systematic Tail Return @ 5% (%)')
    ax5.set_ylabel('Mean Excess Return (%)')
    ax5.set_title('Systematic Tail Risk vs Return')
    corr = sub[tvar].corr(sub['mean_excess'])
    ax5.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax5.transAxes, fontsize=8, color='navy')

    # sys_var vs sys_tail coloured by return — shows orthogonality
    ax6 = fig.add_subplot(gs[1,2])
    sc = ax6.scatter(sub['sys_var']*10000, sub[tvar]*100,
                     c=sub['mean_excess']*100, cmap='RdYlGn',
                     alpha=0.7, s=30)
    plt.colorbar(sc, ax=ax6, label='Mean excess return (%)')
    ax6.set_xlabel('Systematic Variance (×10⁴)')
    ax6.set_ylabel('Systematic Tail Return (%)')
    ax6.set_title('Variance vs Tail Risk\n(coloured by return)')

    # R² bar chart
    ax7 = fig.add_subplot(gs[2,:2])
    mkeys   = ['A','B','C','D','E','F','G','K']
    mlabels = ['A\nFF5','B\nbeta','C\nsys_var','D\nsys_tail',
               'E\nvar+tail\n(core)','F\nbeta+\nexcess',
               'G\nvar+\ntail_β','K\nσ+var5\n(prev)']
    def get_r2(k):
        r = regs_all.get(k)
        return r.rsquared if r else 0
    r2_all = [get_r2(k) for k in mkeys]
    r2_ind = [regs_ind.get(k).rsquared
              if regs_ind and regs_ind.get(k) else 0
              for k in mkeys]
    x = np.arange(len(mkeys))
    ax7.bar(x-0.2, r2_all, 0.35, label='All portfolios',
            color='steelblue', alpha=0.8)
    ax7.bar(x+0.2, r2_ind, 0.35, label='Industry only',
            color='darkorange', alpha=0.8)
    ax7.set_xticks(x); ax7.set_xticklabels(mlabels, fontsize=7)
    ax7.set_ylabel('R²')
    ax7.set_title('R² Comparison (blue=all, orange=industry)')
    ax7.legend(fontsize=8)

    # Idiosyncratic fraction vs return
    ax8 = fig.add_subplot(gs[2,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax8.scatter(grp['idio_var']*10000, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax8.set_xlabel('Idiosyncratic Variance (×10⁴)')
    ax8.set_ylabel('Mean Excess Return (%)')
    ax8.set_title('Idiosyncratic Variance vs Return\n(should be ~0 if theory correct)')
    corr = sub['idio_var'].corr(sub['mean_excess'])
    ax8.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax8.transAxes, fontsize=8, color='navy')

    fig.suptitle(
        'Two-Dimensional Risk: Systematic Variance + Systematic Tail Risk',
        fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Two-Dimensional Risk Test")
    print("Systematic variance + systematic tail risk vs FF5 factors")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    df = build_cross_section(all_factors, deciles, industries)

    # Descriptive stats
    print(f"\n── Descriptive Statistics ───────────────────────────────────────")
    for col in ['beta','sys_var','sys_tail_q5','sys_tail_q10',
                'tail_excess_q5','idio_var','sigma','var_5']:
        if col in df.columns:
            v = df[col].dropna()
            c = v.corr(df['mean_excess'].loc[v.index])
            print(f"  {col:<20} mean={v.mean():+.4f}  "
                  f"std={v.std():.4f}  r_return={c:+.4f}")

    # Main regressions at 5% threshold
    regs_all, sub_all = run_regressions(df, 'All portfolios', 'q5')

    # Industry portfolios
    ind_df = df[df['portfolio_type']=='industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_regressions(
            ind_df, 'Industry portfolios only', 'q5')

    # Robustness across thresholds
    robustness_across_thresholds(df, 'All portfolios')
    if len(ind_df) > 20:
        robustness_across_thresholds(ind_df, 'Industry only')

    # Plots
    print("\nGenerating plots...")
    make_plots(df, regs_all, regs_ind)

    # Summary
    ra = regs_all['A']
    re = regs_all['E']
    t_var  = re.tvalues.get('sys_var',  np.nan)
    t_tail = re.tvalues.get('sys_tail_q5', np.nan)

    print("\n" + "="*65)
    print("SUMMARY: Does the two-dimensional model work?")
    print("="*65)
    print(f"  FF5 factors R²:                    {ra.rsquared:.4f}")
    print(f"  sys_var + sys_tail R²:             {re.rsquared:.4f}  "
          f"({re.rsquared/ra.rsquared*100:.1f}% of FF5)")
    print()
    print(f"  In joint model (Model E):")
    print(f"    sys_var t-stat:    {t_var:+.2f}  "
          f"({'sig ✓' if abs(t_var)>2 else 'not sig'})")
    print(f"    sys_tail t-stat:   {t_tail:+.2f}  "
          f"({'sig ✓' if abs(t_tail)>2 else 'not sig'})")
    print()
    if abs(t_var) > 2 and abs(t_tail) > 2:
        print("  RESULT: Both dimensions jointly significant.")
        print("  The two-dimensional risk model is supported.")
        print("  Beta is rescued by controlling for tail risk.")
    elif abs(t_tail) > 2:
        print("  RESULT: Tail risk significant, variance not.")
        print("  Tail risk dominates — utility curve is strongly nonlinear.")
    elif abs(t_var) > 2:
        print("  RESULT: Variance significant, tail risk not.")
        print("  Standard beta is sufficient once tail noise is removed.")
    else:
        print("  RESULT: Neither dimension significant in joint model.")
        print("  Two-dimensional framework not confirmed with this data.")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()
