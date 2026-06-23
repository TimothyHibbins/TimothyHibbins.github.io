"""
Tail Index Test
================
Tests whether the systematic tail index — the power law decay rate of the
joint tail distribution of portfolio and market returns — explains
cross-sectional returns and mediates FF5 factor explanatory power.

Motivation:
  CAPM uses variance to measure systematic risk, justified by assuming
  normal distributions. But equity returns have fat power law tails.
  For power law distributions, the tail index α characterises the entire
  tail: P(loss > x) ~ x^{-α}. Lower α = fatter tail = more extreme events.
  
  If returns are power law distributed, tail index is the correct
  single-parameter summary of tail risk — analogous to sigma for normals.
  
  Hypothesis: tail index of the SYSTEMATIC component (estimated from
  joint tail of portfolio and market returns) predicts cross-sectional
  returns, and mediates factor explanatory power better than sys_var or
  sys_tail alone.

Estimation:
  Hill estimator applied to portfolio losses in market tail months:
    α̂ = k / Σᵢ log(loss_i / loss_k)
  where loss_i are the k largest portfolio losses in market tail months,
  sorted descending.
  
  Lower α̂ = fatter systematic tail = higher predicted return premium.

Test structure:
  1. Retroactive: full-sample tail index vs full-sample mean return
     — does tail index explain contemporaneous returns?
     — does it absorb factor explanatory power?
     — does it outperform sys_var and sys_tail?
  
  2. Rolling mediation (expanding window): does tail index measured
     up to time t predict returns from t to t+k?
     — are factors mediating through tail index?

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python tail_index_test.py
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
# 2.  TAIL INDEX ESTIMATION
# ══════════════════════════════════════════════════════════════════════════════

def hill_estimator(losses, k=None, k_fraction=0.10):
    """
    Hill estimator for tail index α of a power law distribution.
    Applied to LOSSES (positive values) in market tail months.

    P(loss > x) ~ x^{-α}
    Lower α = fatter tail = more extreme events = higher systematic tail risk

    Parameters:
        losses: array of positive loss values (portfolio losses in tail months)
        k: number of top order statistics to use (if None, use k_fraction)
        k_fraction: fraction of observations to use as tail

    Returns:
        alpha: estimated tail index
        n_used: number of observations used
    """
    losses = np.asarray(losses, dtype=float)
    losses = losses[losses > 0]  # only positive losses
    losses = np.sort(losses)[::-1]  # sort descending

    n = len(losses)
    if n < 5:
        return np.nan, 0

    if k is None:
        k = max(5, int(n * k_fraction))
    k = min(k, n - 1)

    # Hill estimator
    log_ratios = np.log(losses[:k] / losses[k])
    if np.any(np.isnan(log_ratios)) or np.sum(log_ratios) <= 0:
        return np.nan, 0

    alpha = k / np.sum(log_ratios)
    return float(alpha), k


def optimal_k_hill(losses, k_range=None):
    """
    Select optimal k for Hill estimator using the minimum variance criterion.
    Tests a range of k values and selects the most stable region of the
    Hill plot — where the estimate is approximately constant.
    """
    losses = np.asarray(losses, dtype=float)
    losses = losses[losses > 0]
    losses = np.sort(losses)[::-1]
    n = len(losses)

    if n < 10:
        return max(5, n // 3)

    if k_range is None:
        k_range = range(5, min(n - 1, max(10, n // 2)))

    alphas = []
    for k in k_range:
        log_ratios = np.log(losses[:k] / losses[k])
        if np.sum(log_ratios) > 0:
            alphas.append(k / np.sum(log_ratios))
        else:
            alphas.append(np.nan)

    alphas = np.array(alphas)
    # Find most stable region: minimum rolling variance
    if len(alphas) < 5:
        return list(k_range)[0]
    window = min(5, len(alphas) // 3)
    rolling_var = pd.Series(alphas).rolling(window).var()
    best_k_idx = rolling_var.idxmin()
    return list(k_range)[int(best_k_idx)]


def compute_systematic_tail_index(r_exc, rm_exc, tail_q=0.10,
                                   k_method='fraction'):
    """
    Estimate the tail index of the SYSTEMATIC component:
    — identify market tail months (worst q% of market returns)
    — extract portfolio losses in those months
    — apply Hill estimator to those losses

    Returns:
        tail_index: α̂ (lower = fatter systematic tail = riskier)
        n_tail_obs: number of tail observations used
        sys_tail_mean: mean portfolio return in tail months (for comparison)
    """
    # Market tail threshold
    threshold = float(np.percentile(rm_exc.dropna(), tail_q * 100))
    tail_mask = rm_exc <= threshold

    r_tail  = r_exc[tail_mask]
    n_tail  = tail_mask.sum()

    if n_tail < 5:
        return np.nan, 0, np.nan

    # Convert to losses (negate returns, keep positive losses)
    # We look at losses relative to the risk-free rate
    losses = -r_tail.values  # losses are positive when returns are negative
    # Keep all values — even small positive returns in tail months
    # represent "less bad" outcomes that inform the tail shape
    losses_positive = losses[losses > 0]

    if len(losses_positive) < 5:
        return np.nan, 0, float(r_tail.mean())

    # Estimate tail index
    if k_method == 'optimal':
        k = optimal_k_hill(losses_positive)
    else:
        k = None  # use k_fraction default

    alpha, k_used = hill_estimator(losses_positive, k=k)
    sys_tail_mean = float(r_tail.mean())

    return alpha, k_used, sys_tail_mean


# ══════════════════════════════════════════════════════════════════════════════
# 3.  FULL-SAMPLE CHARACTERISTICS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def compute_full_sample_chars(ret_series, factors_df, tail_q=0.10):
    """
    Compute full-sample characteristics for the retroactive test.
    Uses all available data to estimate tail index and other measures.
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

    # Factor loadings
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg    = sm.OLS(r_exc, Xf).fit()
    beta   = float(reg.params['Mkt-RF'])
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    # Systematic variance
    sys_var = float(beta**2 * rm_exc.var())

    # Systematic tail (mean return in worst q% market months)
    threshold = float(np.percentile(rm_exc.dropna(), tail_q * 100))
    tail_mask = rm_exc <= threshold
    sys_tail  = float(r_exc[tail_mask].mean()) if tail_mask.sum() > 3 else np.nan

    # Tail index at multiple thresholds
    alpha_10, n_10, _ = compute_systematic_tail_index(
        r_exc, rm_exc, tail_q=0.10)
    alpha_20, n_20, _ = compute_systematic_tail_index(
        r_exc, rm_exc, tail_q=0.20)
    alpha_05, n_05, _ = compute_systematic_tail_index(
        r_exc, rm_exc, tail_q=0.05)

    # Mean excess return (annualised)
    mean_excess = float(r_exc.mean() * 12)

    # Standalone sigma and var5 for comparison
    sigma = float(r_exc.std())
    var_5 = float(np.percentile(r_exc.dropna(), 5))

    return {
        'mean_excess':  mean_excess,
        'n_obs':        len(idx),
        **loadings,
        'beta':         beta,
        'sys_var':      sys_var,
        'sys_tail':     sys_tail,
        # Tail index (lower = fatter tail = riskier)
        'tail_alpha_10': alpha_10,
        'tail_alpha_20': alpha_20,
        'tail_alpha_05': alpha_05,
        'n_tail_10':     n_10,
        'n_tail_20':     n_20,
        # Neg tail index so positive = more risk (easier to interpret)
        'neg_alpha_10': -alpha_10 if not np.isnan(alpha_10) else np.nan,
        'neg_alpha_20': -alpha_20 if not np.isnan(alpha_20) else np.nan,
        # Standalone
        'sigma':        sigma,
        'var_5':        var_5,
    }


def build_full_sample_cross_section(all_factors, deciles, industries):
    print("\nComputing full-sample tail indices...")
    rows = []
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_full_sample_chars(s.loc[idx], all_factors.loc[idx])
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)
    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_full_sample_chars(s.loc[idx], all_factors.loc[idx])
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios")
    print(f"  Mean tail obs (10% threshold): {df['n_tail_10'].mean():.0f}")
    print(f"  Mean tail alpha (10%):         {df['tail_alpha_10'].mean():.3f}")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 4.  RETROACTIVE CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

def run_retroactive(df, label='All portfolios'):
    """
    Full-sample cross-sectional test:
    Does tail index explain mean returns and absorb factor R²?
    """
    req = FACTOR_VARS + ['mean_excess','sys_var','sys_tail',
                          'neg_alpha_10','neg_alpha_20','sigma','var_5']
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Retroactive Tail Index Test: {label}  (N={n})")
    print(f"{'='*65}")

    from sklearn.preprocessing import StandardScaler
    scaler  = StandardScaler()
    risk_vars = ['sys_var','sys_tail','neg_alpha_10','neg_alpha_20',
                 'sigma','var_5']
    sub_std = sub.copy()
    sub_std[risk_vars] = scaler.fit_transform(sub[risk_vars])
    stds = sub[risk_vars].std()

    models = {
        'A  FF5 factors':                  FACTOR_VARS,
        'B  sys_var only':                 ['sys_var'],
        'C  sys_tail only':                ['sys_tail'],
        'D  neg_alpha (10%) only':         ['neg_alpha_10'],
        'E  neg_alpha (20%) only':         ['neg_alpha_20'],
        'F  sys_var + sys_tail [2D]':      ['sys_var','sys_tail'],
        'G  sys_var + neg_alpha_10':       ['sys_var','neg_alpha_10'],
        'H  sys_tail + neg_alpha_10':      ['sys_tail','neg_alpha_10'],
        'I  2D + neg_alpha [3D]':          ['sys_var','sys_tail','neg_alpha_10'],
        'J  FF5 + neg_alpha_10':           FACTOR_VARS + ['neg_alpha_10'],
        'K  FF5 + 2D risk':                FACTOR_VARS + ['sys_var','sys_tail'],
        'L  FF5 + 3D risk':                FACTOR_VARS + ['sys_var','sys_tail',
                                                           'neg_alpha_10'],
    }

    regs = {}
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<40} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*58)
    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  FF5 factors':<40} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<40} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # Standardised coefficients for risk measures
    print(f"\n── Standardised Coefficients (full distribution model I) ────────")
    print(f"  Each coef = annualised % return per 1-SD increase")
    print(f"  {'Variable':<16} {'1-SD':>10} {'Std coef':>10} {'t-stat':>8}  Sig?")
    print("  " + "-"*52)
    ri_std = sm.OLS(y, sm.add_constant(
        sub_std[['sys_var','sys_tail','neg_alpha_10']])).fit()
    for v in ['sys_var','sys_tail','neg_alpha_10']:
        c = ri_std.params.get(v, np.nan)
        t = ri_std.tvalues.get(v, np.nan)
        sd = stds.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<16} {sd:>+10.5f} {c*100:>+9.3f}%  {t:>+8.2f}  {sig}")

    # Does tail index add over 2D risk?
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        fs = ((r2_f-r2_r)/(k_f-k_r)) / ((1-r2_f)/(n-k_f))
        return fs, 1 - f_dist.cdf(fs, k_f-k_r, n-k_f)

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('tail_alpha adds over sys_var alone',
         regs['B'], regs['G'], 1, 2),
        ('tail_alpha adds over sys_tail alone',
         regs['C'], regs['H'], 1, 2),
        ('tail_alpha adds over 2D risk (var+tail)',
         regs['F'], regs['I'], 2, 3),
        ('3D risk adds over FF5',
         regs['A'], regs['L'], len(FACTOR_VARS), len(FACTOR_VARS)+3),
        ('FF5 adds over 3D risk',
         regs['I'], regs['L'], 3, len(FACTOR_VARS)+3),
        ('tail_alpha adds over FF5',
         regs['A'], regs['J'], len(FACTOR_VARS), len(FACTOR_VARS)+1),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    # Factor shrinkage when tail index added
    print(f"\n── Factor Shrinkage: A → L (FF5 + 3D risk) ─────────────────────")
    rl = regs['L']
    print(f"  {'Factor':<14} {'A coef':>10} {'L coef':>10} "
          f"{'Shrink':>8}  {'A t':>6}  {'L t':>6}")
    print("  " + "-"*58)
    for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        cl = rl.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        tl = rl.tvalues.get(v, np.nan)
        sh = (1-abs(cl)/abs(ca))*100 if abs(ca)>1e-10 else np.nan
        sa = '*' if abs(ta)>2 else ' '
        sl = '*' if abs(tl)>2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {cl:>+10.4f} "
              f"{sh:>7.1f}%  {ta:>+5.2f}{sa}  {tl:>+5.2f}{sl}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 5.  ROLLING MEDIATION WITH TAIL INDEX
# ══════════════════════════════════════════════════════════════════════════════

def compute_rolling_tail_index(ret_series, factors_df,
                                lookback_years=10, tail_q=0.10):
    """
    Estimate tail index from an expanding or fixed lookback window.
    Returns tail index and other distribution measures for that window.
    """
    idx = ret_series.index.intersection(factors_df.index)
    ret_series = ret_series.loc[idx].dropna()
    idx = ret_series.index.intersection(factors_df.index)
    if len(idx) < 36:
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

    # Factor loadings
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg  = sm.OLS(r_exc, Xf).fit()
    beta = float(reg.params['Mkt-RF'])
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    sys_var  = float(beta**2 * rm_exc.var())
    threshold = float(np.percentile(rm_exc.dropna(), tail_q * 100))
    tail_mask = rm_exc <= threshold
    sys_tail  = float(r_exc[tail_mask].mean()) if tail_mask.sum() > 3 else np.nan

    alpha, n_used, _ = compute_systematic_tail_index(
        r_exc, rm_exc, tail_q=tail_q)
    neg_alpha = -alpha if not np.isnan(alpha) else np.nan

    return {
        **loadings,
        'beta':       beta,
        'sys_var':    sys_var,
        'sys_tail':   sys_tail,
        'tail_alpha': alpha,
        'neg_alpha':  neg_alpha,
        'n_tail_obs': n_used,
    }


def build_rolling_mediation_panel(all_factors, deciles, industries,
                                   lookback_years=10,
                                   forward_years_list=(3, 5),
                                   tail_q=0.10):
    """
    Rolling panel where tail index is estimated from lookback window
    and forward returns measured in subsequent non-overlapping window.
    Uses longer lookback (10y) to get reliable tail index estimates.
    """
    # Normalise portfolios
    port_series = {}
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            port_series[f'{fname}_{col}'] = ddf[col]
    for col in industries.columns:
        port_series[f'ind_{col}'] = industries[col]

    print(f"\nBuilding rolling tail index panel "
          f"(lookback={lookback_years}y, non-overlapping)...")

    panels = {fwd: [] for fwd in forward_years_list}
    start  = all_factors.index.min() + pd.DateOffset(years=lookback_years)
    end    = all_factors.index.max() - pd.DateOffset(years=max(forward_years_list))

    t = start
    while t <= end:
        lookback_start = t - pd.DateOffset(years=lookback_years)
        f_back = all_factors.loc[lookback_start:t]

        for port_name, s_raw in port_series.items():
            s  = s_raw.dropna() / 100
            rf = all_factors['RF'] / 100

            r_back_idx = s.index.intersection(f_back.index)
            if len(r_back_idx) < 36:
                continue
            r_back = s.loc[r_back_idx] - rf.loc[r_back_idx]

            chars = compute_rolling_tail_index(
                s_raw.loc[r_back_idx], f_back.loc[r_back_idx],
                tail_q=tail_q)
            if chars is None:
                continue

            factor_group = '_'.join(port_name.split('_')[:-1]) \
                           if port_name.startswith(tuple(deciles.keys())) \
                           else 'industry'

            for fwd_years in forward_years_list:
                fwd_end    = t + pd.DateOffset(years=fwd_years)
                f_fwd      = all_factors.loc[t:fwd_end]
                r_fwd_idx  = s.index.intersection(f_fwd.index)
                if len(r_fwd_idx) < 12:
                    continue
                r_fwd      = s.loc[r_fwd_idx]
                rf_fwd     = rf.loc[r_fwd_idx]
                r_exc_fwd  = r_fwd - rf_fwd
                fwd_return = float(r_exc_fwd.mean() * 12)

                panels[fwd_years].append({
                    'date':         t,
                    'portfolio':    port_name,
                    'factor_group': factor_group,
                    'fwd_years':    fwd_years,
                    'fwd_return':   fwd_return,
                    **chars,
                })

        # Step forward by forward_years (non-overlapping)
        t += pd.DateOffset(years=min(forward_years_list))

    result = {}
    for fwd in forward_years_list:
        df = pd.DataFrame(panels[fwd])
        result[fwd] = df
        if len(df) > 0:
            n_ports = df['portfolio'].nunique()
            n_times = df['date'].nunique()
            print(f"  {fwd}y forward: {len(df)} obs "
                  f"({n_ports} portfolios × {n_times} time points)")
    return result


def run_rolling_mediation(panels, fwd_years=5):
    """Test whether tail index mediates factor → return in rolling panel."""
    df  = panels.get(fwd_years, pd.DataFrame())
    req = FACTOR_VARS + ['fwd_return','sys_var','sys_tail','neg_alpha']
    sub = df.dropna(subset=req)
    if len(sub) < 30:
        print(f"  Insufficient data for {fwd_years}y forward")
        return
    y = sub['fwd_return']
    n = len(sub)

    print(f"\n{'='*65}")
    print(f"Rolling Mediation with Tail Index ({fwd_years}y forward, N={n})")
    print(f"{'='*65}")

    models = {
        'A  FF5 factors':               FACTOR_VARS,
        'B  2D risk (var+tail)':        ['sys_var','sys_tail'],
        'C  neg_alpha only':            ['neg_alpha'],
        'D  3D risk (var+tail+alpha)':  ['sys_var','sys_tail','neg_alpha'],
        'E  FF5 + 2D risk':             FACTOR_VARS + ['sys_var','sys_tail'],
        'F  FF5 + 3D risk':             FACTOR_VARS + ['sys_var','sys_tail',
                                                        'neg_alpha'],
    }

    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<40} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*58)
    regs = {}
    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  FF5 factors':<40} {ra.rsquared:>7.4f}  {'100.0%':>8}")
    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<40} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    print(f"\n── 3D Risk Coefficients (Model D) ───────────────────────────────")
    rd = regs['D']
    for v in ['sys_var','sys_tail','neg_alpha']:
        c = rd.params.get(v, np.nan)
        t = rd.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<16} coef={c:+.6f}  t={t:+.2f}  {sig}")

    # Does alpha add over 2D?
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        fs = ((r2_f-r2_r)/(k_f-k_r))/((1-r2_f)/(n-k_f))
        return fs, 1 - f_dist.cdf(fs, k_f-k_r, n-k_f)

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('neg_alpha adds over 2D risk',      regs['B'], regs['D'], 2, 3),
        ('3D risk adds over FF5',             regs['A'], regs['F'],
         len(FACTOR_VARS), len(FACTOR_VARS)+3),
        ('FF5 adds over 3D risk',             regs['D'], regs['F'],
         3, len(FACTOR_VARS)+3),
        ('2D rescue: tail adds over var',
         sm.OLS(y, sm.add_constant(sub[['sys_var']])).fit(),
         regs['B'], 1, 2),
        ('2D rescue: var adds over tail',
         sm.OLS(y, sm.add_constant(sub[['sys_tail']])).fit(),
         regs['B'], 1, 2),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    return regs


# ══════════════════════════════════════════════════════════════════════════════
# 6.  HILL PLOT DIAGNOSTIC
# ══════════════════════════════════════════════════════════════════════════════

def hill_plot_diagnostic(df):
    """
    Show Hill plot for a sample of portfolios to verify power law behaviour
    and stability of tail index estimates across k.
    """
    print(f"\n── Tail Index Distribution Across Portfolios ────────────────────")
    for col in ['tail_alpha_10','tail_alpha_20']:
        if col not in df.columns: continue
        v = df[col].dropna()
        print(f"  {col}: mean={v.mean():.3f}  std={v.std():.3f}  "
              f"min={v.min():.3f}  max={v.max():.3f}")
        print(f"    Interpretation: α<2 (very fat), α=2-3 (fat), "
              f"α=3-5 (moderate), α>5 (near-normal)")

    # Correlation of tail alpha with other measures
    print(f"\n── Correlations with Mean Excess Return ─────────────────────────")
    for col in ['tail_alpha_10','neg_alpha_10','sys_var','sys_tail','beta']:
        if col not in df.columns: continue
        c = df[col].corr(df['mean_excess'])
        theory = '−' if col == 'tail_alpha_10' else '+'
        match  = '✓' if (c < 0 and theory == '−') or \
                        (c > 0 and theory == '+') else '✗'
        print(f"  {col:<20}: r={c:+.4f}  (theory: {theory})  {match}")


# ══════════════════════════════════════════════════════════════════════════════
# 7.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs, outpath='tail_index_test.png'):
    req = FACTOR_VARS + ['mean_excess','sys_var','sys_tail',
                          'neg_alpha_10','tail_alpha_10']
    sub = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16, 12))
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
    scatter_fit(ax1, regs['A'], 'A: FF5 Factors')
    ax1.legend(fontsize=6)

    ax2 = fig.add_subplot(gs[0,1])
    if 'F' in regs:
        scatter_fit(ax2, regs['F'], 'F: sys_var+sys_tail')
    elif 'D' in regs:
        scatter_fit(ax2, regs['D'], 'D: 2D risk')

    ax3 = fig.add_subplot(gs[0,2])
    if 'I' in regs:
        scatter_fit(ax3, regs['I'], 'I: 3D risk (var+tail+α)')

    # Tail alpha vs return
    ax4 = fig.add_subplot(gs[1,0])
    for pt, grp in sub.groupby('portfolio_type'):
        ax4.scatter(grp['tail_alpha_10'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax4.set_xlabel('Tail Index α (10% threshold)')
    ax4.set_ylabel('Mean Excess Return (%)')
    ax4.set_title('Tail Index vs Return\n(lower α = fatter tail = higher return)')
    corr = sub['tail_alpha_10'].corr(sub['mean_excess'])
    ax4.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax4.transAxes, fontsize=8, color='navy')

    # Tail alpha distribution
    ax5 = fig.add_subplot(gs[1,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax5.hist(grp['tail_alpha_10'].dropna(), bins=15, alpha=0.6,
                 label=pt, color=colors[pt])
    ax5.axvline(2, color='red', ls='--', lw=1, label='α=2 (fat)')
    ax5.axvline(3, color='orange', ls='--', lw=1, label='α=3 (moderate)')
    ax5.set_xlabel('Tail Index α')
    ax5.set_title('Distribution of Tail Indices')
    ax5.legend(fontsize=7)

    # neg_alpha vs sys_tail (how correlated are they?)
    ax6 = fig.add_subplot(gs[1,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax6.scatter(grp['sys_tail']*100, grp['neg_alpha_10'],
                    alpha=0.5, s=20, color=colors[pt])
    ax6.set_xlabel('sys_tail (%)')
    ax6.set_ylabel('neg_alpha (= -tail index)')
    ax6.set_title('sys_tail vs Tail Index\n(correlation check)')
    corr = sub['sys_tail'].corr(sub['neg_alpha_10'])
    ax6.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax6.transAxes, fontsize=8, color='navy')

    # R² bar chart
    ax7 = fig.add_subplot(gs[2,:])
    mkeys   = ['A','B','C','D','F','G','H','I','J','K','L']
    mlabels = ['A\nFF5','B\nvar','C\ntail','D\nα',
               'F\nvar+tail','G\nvar+α','H\ntail+α','I\n3D',
               'J\nFF5+α','K\nFF5+2D','L\nFF5+3D']
    r2_vals = []
    for k in mkeys:
        r = regs.get(k)
        r2_vals.append(r.rsquared if r else 0)
    bar_colors = ['steelblue' if k=='A' else
                  'darkorange' if k in ['B','C','D','F','G','H','I'] else
                  'green' for k in mkeys]
    x = np.arange(len(mkeys))
    bars = ax7.bar(x, r2_vals, color=bar_colors, alpha=0.8)
    ax7.set_xticks(x); ax7.set_xticklabels(mlabels, fontsize=7)
    ax7.set_ylabel('R²')
    ax7.set_title('R² by Model  (blue=factors, orange=risk measures, green=combined)')
    for i, v in enumerate(r2_vals):
        if v > 0.01:
            ax7.text(i, v+0.002, f'{v:.3f}', ha='center', fontsize=6)

    fig.suptitle('Tail Index Test: Power Law Tail Risk vs FF5 Factors',
                 fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 8.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Tail Index Test")
    print("Does power law tail index explain cross-sectional returns?")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    # Full-sample cross-section (retroactive test)
    df = build_full_sample_cross_section(all_factors, deciles, industries)

    # Diagnostic
    hill_plot_diagnostic(df)

    # Retroactive regressions — all portfolios
    regs_all, sub_all = run_retroactive(df, 'All portfolios')

    # Industry only (unbiased)
    ind_df = df[df['portfolio_type']=='industry']
    if len(ind_df) > 20:
        run_retroactive(ind_df, 'Industry portfolios only')

    # Rolling mediation (predictive)
    roll_panels = build_rolling_mediation_panel(
        all_factors, deciles, industries,
        lookback_years=10,
        forward_years_list=(3, 5),
        tail_q=0.10)

    for fwd in [3, 5]:
        run_rolling_mediation(roll_panels, fwd_years=fwd)

    # Plots
    print("\nGenerating plots...")
    make_plots(df, regs_all)

    # Summary
    ra = regs_all['A']
    rd = regs_all.get('D', regs_all.get('C'))
    ri = regs_all.get('I')
    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    print(f"  FF5 factors R²:              {ra.rsquared:.4f}")
    if rd:
        print(f"  neg_alpha alone R²:          {rd.rsquared:.4f}  "
              f"({rd.rsquared/ra.rsquared*100:.1f}% of FF5)")
    if ri:
        print(f"  3D risk (var+tail+α) R²:     {ri.rsquared:.4f}  "
              f"({ri.rsquared/ra.rsquared*100:.1f}% of FF5)")

    # Key question: does tail index add over sys_tail?
    rf_reg = regs_all.get('F')
    ri_reg = regs_all.get('I')
    if rf_reg and ri_reg:
        delta = ri_reg.rsquared - rf_reg.rsquared
        t_alpha = ri_reg.tvalues.get('neg_alpha_10', np.nan)
        print(f"\n  Does tail index add over sys_var + sys_tail?")
        print(f"    ΔR² = {delta:.4f}  t(neg_alpha) = {t_alpha:+.2f}")
        if abs(t_alpha) > 2:
            print(f"    → YES: tail index adds independent information")
            print(f"    → Power law shape matters beyond mean tail performance")
        else:
            print(f"    → NO: sys_tail already captures what tail index measures")
            print(f"    → Mean tail performance subsumes tail shape information")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()
