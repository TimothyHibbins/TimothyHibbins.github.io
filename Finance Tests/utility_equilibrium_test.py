"""
Utility Equilibrium Test
=========================
Tests whether the power utility equilibrium condition explains
cross-sectional returns better than FF5 factors, using only the
*systematic* (undiversifiable) component of each portfolio's returns.

Theory:
  In equilibrium: E[U*(R_systematic_i)] = U*(rf) for all assets.
  Assets where the systematic component has low expected utility
  must offer high expected returns to compensate.

  The systematic component is: R_sys = beta_i * R_market
  (the part of returns that cannot be diversified away)

Pipeline:
  Stage 1: Isolate systematic return component for each portfolio
  Stage 2: Estimate gamma (risk aversion) that minimises cross-sectional
           dispersion of E[U*(R_sys)] — implied aggregate utility function
  Stage 3: Test whether E[U*(R_sys; gamma)] predicts mean excess returns
           cross-sectionally, vs FF5 factors, vs moments of R_sys
  Stage 4: Out-of-sample validation — estimate gamma in-sample,
           test predictive power out-of-sample

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python utility_equilibrium_test.py
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
from scipy.optimize import minimize_scalar, minimize
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
# 2.  UTILITY FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def power_utility(r, gamma):
    """
    Power utility: U(1+r) = (1+r)^(1-gamma) / (1-gamma)
    Special case gamma=1: log utility U(1+r) = log(1+r)
    Returns NaN for invalid inputs (1+r <= 0).
    """
    gross = 1.0 + r
    if np.isscalar(gross):
        if gross <= 0:
            return np.nan
        if abs(gamma - 1.0) < 1e-6:
            return np.log(gross)
        return gross ** (1 - gamma) / (1 - gamma)
    else:
        gross = np.asarray(gross, dtype=float)
        result = np.full_like(gross, np.nan)
        valid = gross > 0
        if abs(gamma - 1.0) < 1e-6:
            result[valid] = np.log(gross[valid])
        else:
            result[valid] = gross[valid] ** (1 - gamma) / (1 - gamma)
        return result

def expected_utility(r_series, gamma):
    """Mean power utility of a return series."""
    u = power_utility(np.asarray(r_series, dtype=float), gamma)
    valid = u[~np.isnan(u)]
    return float(np.mean(valid)) if len(valid) > 0 else np.nan

def utility_of_rf(rf_mean, gamma):
    """Utility of the risk-free rate (certain payoff)."""
    return float(power_utility(rf_mean, gamma))


# ══════════════════════════════════════════════════════════════════════════════
# 3.  SYSTEMATIC COMPONENT + PORTFOLIO CHARACTERISTICS
# ══════════════════════════════════════════════════════════════════════════════

def poly_systematic(r_exc, rm_exc, degree=3):
    """
    Fit a polynomial regression R_stock = f(R_mkt) of degree `degree`.
    The fitted values are the systematic component — a smooth curve
    through the (R_mkt, R_stock) scatter, using all observations.

    Coefficient interpretation:
      b1 (linear):    standard beta
      b2 (quadratic): coskewness proxy — responds more to large moves
      b3 (cubic):     cokurtosis proxy — asymmetry between tails

    Returns coeffs, r_sys (fitted values), beta_fn (slope function), metrics.
    """
    rm = rm_exc.values
    r  = r_exc.values

    col_names = ['const'] + [f'rm_p{k}' for k in range(1, degree + 1)]
    X_poly = np.column_stack([np.ones(len(rm))] +
                              [rm**k for k in range(1, degree + 1)])
    reg    = sm.OLS(r, X_poly).fit()
    coeffs = reg.params

    r_sys = pd.Series(reg.fittedvalues, index=rm_exc.index)

    def beta_fn(x):
        deriv = 0.0
        for k in range(1, degree + 1):
            deriv += k * coeffs[k] * (x ** (k - 1))
        return deriv

    b1 = float(coeffs[1]) if len(coeffs) > 1 else np.nan
    b2 = float(coeffs[2]) if len(coeffs) > 2 else np.nan
    b3 = float(coeffs[3]) if len(coeffs) > 3 else np.nan

    rm_p5  = float(np.percentile(rm, 5))
    rm_p95 = float(np.percentile(rm, 95))
    beta_tail = beta_fn(rm_p5)
    beta_boom = beta_fn(rm_p95)
    beta_asym = float(beta_tail - beta_boom)

    reg_lin        = sm.OLS(r, np.column_stack([np.ones(len(rm)), rm])).fit()
    nonlin_r2_gain = float(reg.rsquared - reg_lin.rsquared)

    metrics = {
        'poly_b1':        b1,
        'poly_b2':        b2,
        'poly_b3':        b3,
        'beta_at_tail':   float(beta_tail),
        'beta_at_boom':   float(beta_boom),
        'beta_asym_poly': beta_asym,
        'nonlin_r2_gain': nonlin_r2_gain,
    }
    return coeffs, r_sys, beta_fn, metrics


def compute_portfolio_chars(ret_series, factors_df, gamma,
                            tail_q=(0.05, 0.10)):
    """
    For a single portfolio:
      1. Estimate beta via OLS on FF5+MOM
      2. Estimate conditional beta β(x) per market-return quintile
      3. Construct R_sys_t = β(bin_t)*R_market_t month-by-month
      3. Compute:
         a. E[U*(R_sys; gamma)]  — the utility equilibrium measure
         b. Moments of R_sys     — systematic variance, skew, kurt
         c. Tail measures of R_sys — systematic tail VaR, tail beta
         d. Utility residual     — E[U*(R_sys)] - U*(rf)
            (negative = asset is utility-costly = should earn premium)
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
    rm_exc.name = 'Mkt-RF'
    rf_mean = float(rf.mean())

    # ── Factor loadings ───────────────────────────────────────────────────────
    Xf  = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt, 'SMB': smb, 'HML': hml,
        'RMW': rmw, 'CMA': cma, 'MOM': mom_s
    }))
    reg = sm.OLS(r_exc, Xf).fit()
    beta_mkt = float(reg.params['Mkt-RF'])   # average beta (reference only)
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    # ── Polynomial systematic component: f(R_mkt) via poly regression ──────────
    # R_sys_t = f(R_mkt_t) where f is a smooth cubic fit through the scatter
    # No binning — uses all observations, smooth conditional beta curve
    _, r_sys, beta_fn, poly_metrics = poly_systematic(r_exc, rm_exc, degree=3)

    beta_asym_cond = poly_metrics['beta_asym_poly']
    cond_beta_dict = poly_metrics   # all poly metrics stored

    # ── Utility measures on systematic component ──────────────────────────────
    # Add back rf to get gross return for utility calculation
    r_sys_gross = r_sys + rf    # systematic gross return

    eu_sys   = expected_utility(r_sys_gross, gamma)
    u_rf     = utility_of_rf(rf_mean, gamma)
    # Utility residual: negative means asset is costly in utility terms
    # → should predict positive excess return
    util_residual = eu_sys - u_rf  if not np.isnan(eu_sys) else np.nan
    # Negated: higher value = more utility-costly = higher predicted premium
    util_cost = -util_residual     if not np.isnan(util_residual) else np.nan

    # ── Moments of systematic component ──────────────────────────────────────
    sys_sigma = float(r_sys.std())
    sys_skew  = float(stats.skew(r_sys.dropna()))
    sys_kurt  = float(stats.kurtosis(r_sys.dropna()))
    sys_var5  = float(np.percentile(r_sys.dropna(), 5))
    # Systematic variance: beta² * market_variance
    sys_var   = float(beta_mkt**2 * rm_exc.var())

    # ── Tail measures of systematic component ────────────────────────────────
    tail_measures = {}
    for q in tail_q:
        q_label = f'q{int(q*100)}'
        mkt_threshold = float(np.percentile(rm_exc.dropna(), q * 100))
        tail_mask = rm_exc <= mkt_threshold
        r_sys_tail = r_sys[tail_mask]
        rm_tail    = rm_exc[tail_mask]

        if len(r_sys_tail) < 5:
            tail_measures[f'sys_mvar_{q_label}']      = np.nan
            tail_measures[f'sys_tail_beta_{q_label}'] = np.nan
            tail_measures[f'util_tail_{q_label}']     = np.nan
            continue

        # Systematic marginal VaR: mean of R_sys in market tail
        sys_mvar = float(r_sys_tail.mean())

        # Tail beta of systematic component
        if rm_tail.var() > 1e-12:
            sys_tail_beta = float(
                np.cov(r_sys_tail, rm_tail)[0,1] / rm_tail.var())
        else:
            sys_tail_beta = np.nan

        # Utility of systematic component in tail months
        r_sys_tail_gross = r_sys_tail + rf.loc[r_sys_tail.index]
        util_tail = expected_utility(r_sys_tail_gross, gamma)

        tail_measures[f'sys_mvar_{q_label}']      = sys_mvar
        tail_measures[f'sys_tail_beta_{q_label}'] = sys_tail_beta
        tail_measures[f'util_tail_{q_label}']     = float(util_tail) \
            if not np.isnan(util_tail) else np.nan

    # ── Standalone moments for comparison ────────────────────────────────────
    standalone_sigma = float(r_exc.std())
    standalone_var5  = float(np.percentile(r_exc.dropna(), 5))

    return {
        'mean_excess':     float(r_exc.mean() * 12),
        'n_obs':           len(idx),
        'beta_mkt':        beta_mkt,
        'beta_asym_cond':  beta_asym_cond,
        **{k: v for k,v in cond_beta_dict.items()
           if k in ['poly_b1','poly_b2','poly_b3',
                    'beta_at_tail','beta_at_boom',
                    'beta_asym_poly','nonlin_r2_gain']},
        **loadings,
        # Utility measures (systematic)
        'eu_systematic':   eu_sys,
        'u_rf':            u_rf,
        'util_residual':   util_residual,
        'util_cost':       util_cost,   # higher = more utility-costly = higher predicted premium
        # Moments of systematic component
        'sys_sigma':       sys_sigma,
        'sys_variance':    sys_var,
        'sys_skewness':    sys_skew,
        'sys_kurtosis':    sys_kurt,
        'sys_var5':        sys_var5,
        # Standalone for comparison
        'standalone_sigma': standalone_sigma,
        'standalone_var5':  standalone_var5,
        **tail_measures,
    }


def build_cross_section(all_factors, deciles, industries, gamma):
    print(f"\nComputing characteristics (gamma={gamma:.2f})...")
    rows = []

    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_portfolio_chars(
                s.loc[idx], all_factors.loc[idx], gamma)
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)

    for col in industries.columns:
        s = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_portfolio_chars(
            s.loc[idx], all_factors.loc[idx], gamma)
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)

    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios built")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 4.  GAMMA ESTIMATION
# ══════════════════════════════════════════════════════════════════════════════

def estimate_gamma(all_factors, deciles, industries,
                   gamma_grid=None, verbose=True):
    """
    Find gamma that minimises cross-sectional dispersion of E[U*(R_sys)].
    In equilibrium all assets should have equal expected utility,
    so the gamma that makes this most nearly true is the implied
    aggregate risk aversion.

    Also find gamma that maximises cross-sectional R² of
    util_cost predicting mean_excess — the predictive gamma.
    """
    if gamma_grid is None:
        gamma_grid = np.concatenate([
            np.linspace(0.5, 3, 10),
            np.linspace(3,  10, 10),
            np.linspace(10, 30, 8),
        ])

    if verbose:
        print("\nEstimating gamma...")
        print(f"  {'Gamma':>7}  {'EU dispersion':>14}  {'Pred R²':>9}")
        print("  " + "-" * 36)

    results = []
    for gamma in gamma_grid:
        df = build_cross_section(all_factors, deciles, industries, gamma)
        df = df.dropna(subset=['eu_systematic','mean_excess'])

        # Dispersion of expected utility across assets
        eu_disp = float(df['eu_systematic'].std())

        # Predictive R²: does util_cost predict mean_excess?
        sub = df.dropna(subset=['util_cost'])
        if len(sub) > 10:
            reg = sm.OLS(sub['mean_excess'],
                         sm.add_constant(sub['util_cost'])).fit()
            pred_r2 = reg.rsquared
        else:
            pred_r2 = np.nan

        results.append({
            'gamma':    gamma,
            'eu_disp':  eu_disp,
            'pred_r2':  pred_r2,
        })
        if verbose:
            print(f"  {gamma:>7.2f}  {eu_disp:>14.6f}  "
                  f"{pred_r2:>9.4f}" if not np.isnan(pred_r2)
                  else f"  {gamma:>7.2f}  {eu_disp:>14.6f}  {'N/A':>9}")

    res_df = pd.DataFrame(results)

    # Gamma that minimises EU dispersion (equilibrium gamma)
    gamma_eq = float(res_df.loc[res_df['eu_disp'].idxmin(), 'gamma'])

    # Gamma that maximises predictive R² (predictive gamma)
    valid = res_df.dropna(subset=['pred_r2'])
    gamma_pred = float(valid.loc[valid['pred_r2'].idxmax(), 'gamma']) \
                 if len(valid) > 0 else gamma_eq

    print(f"\n  Equilibrium gamma  (min EU dispersion): {gamma_eq:.2f}")
    print(f"  Predictive gamma   (max pred R²):       {gamma_pred:.2f}")

    return gamma_eq, gamma_pred, res_df


# ══════════════════════════════════════════════════════════════════════════════
# 5.  CROSS-SECTIONAL REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS   = ['load_Mkt-RF','load_SMB','load_HML',
                 'load_RMW','load_CMA','load_MOM']
SYS_MOM_VARS  = ['sys_sigma','sys_skewness','sys_kurtosis','sys_var5',
                 'beta_asym_cond',   # polynomial beta asymmetry
                 'poly_b2',          # quadratic term (coskewness proxy)
                 'poly_b3']          # cubic term (cokurtosis proxy)
UTIL_VAR      = ['util_cost']
TAIL_VARS_Q5  = ['sys_mvar_q5','sys_tail_beta_q5']
TAIL_VARS_Q10 = ['sys_mvar_q10','sys_tail_beta_q10']

def run_regressions(df, label='All portfolios'):
    req_cols = (['mean_excess'] + FACTOR_VARS + SYS_MOM_VARS +
                UTIL_VAR + TAIL_VARS_Q5 + TAIL_VARS_Q10)
    sub = df.dropna(subset=req_cols)
    y   = sub['mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Utility Equilibrium Test: {label}  (N={n})")
    print(f"{'='*65}")

    # All models
    models = {
        'A  Factors only':               FACTOR_VARS,
        'B  Sys moments only':           SYS_MOM_VARS,
        'C  Utility cost only':          UTIL_VAR,
        'D  Sys moments + utility':      SYS_MOM_VARS + UTIL_VAR,
        'E  Tail measures q5':           TAIL_VARS_Q5,
        'F  Tail measures q10':          TAIL_VARS_Q10,
        'G  Utility + tail q5':          UTIL_VAR + TAIL_VARS_Q5,
        'H  Utility + tail q10':         UTIL_VAR + TAIL_VARS_Q10,
        'I  Full sys (moments+util+tail)':
            SYS_MOM_VARS + UTIL_VAR + TAIL_VARS_Q5,
        'J  Factors + full sys':
            FACTOR_VARS + SYS_MOM_VARS + UTIL_VAR + TAIL_VARS_Q5,
        'K  Beta asymmetry only':        ['beta_asym_cond'],
    }

    regs = {}
    model_K_label = 'K'
    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<38} {'R²':>7}  {'% of A':>8}")
    print("  " + "-" * 58)

    ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra
    print(f"  {'A  Factors only':<38} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        regs[mname[0]] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<38} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # ── Utility cost coefficients ─────────────────────────────────────────────
    print(f"\n── Utility Cost: Does E[U*(R_sys)] predict returns? ─────────────")
    rc = regs['C']
    coef = rc.params.get('util_cost', np.nan)
    tval = rc.tvalues.get('util_cost', np.nan)
    print(f"  Coef = {coef:+.4f}  t = {tval:+.2f}")
    print(f"  (Positive t → utility-costly assets earn higher returns ✓)")

    # ── Systematic moments significance ───────────────────────────────────────
    print(f"\n── Systematic Moment Coefficients (Model B) ─────────────────────")
    rb = regs['B']
    print(f"  {'Variable':<16} {'Coef':>10} {'t-stat':>8}  Sig?")
    print("  " + "-" * 44)
    for v in SYS_MOM_VARS:
        c = rb.params.get(v, np.nan)
        t = rb.tvalues.get(v, np.nan)
        sig = '***' if abs(t) > 3 else ('*' if abs(t) > 2 else '  ')
        print(f"  {v:<16} {c:>+10.4f} {t:>+8.2f}  {sig}")

    # ── Factor shrinkage when systematic measures added ────────────────────────
    print(f"\n── Factor Shrinkage: A → J (factors + full systematic) ──────────")
    rj = regs['J']
    print(f"  {'Variable':<14} {'Model A':>10} {'Model J':>10} "
          f"{'Shrink':>8}  {'A t':>6}  {'J t':>6}")
    print("  " + "-" * 58)
    for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        cj = rj.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        tj = rj.tvalues.get(v, np.nan)
        sh = (1 - abs(cj)/abs(ca))*100 if abs(ca) > 1e-10 else np.nan
        sa = '*' if abs(ta) > 2 else ' '
        sj = '*' if abs(tj) > 2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {cj:>+10.4f} "
              f"{sh:>7.1f}%  {ta:>+5.2f}{sa}  {tj:>+5.2f}{sj}")

    # ── Key F-tests ───────────────────────────────────────────────────────────
    from scipy.stats import f as f_dist

    def f_test(r2_r, r2_f, n, k_f, k_r):
        if k_f <= k_r: return np.nan, np.nan
        f = ((r2_f - r2_r)/(k_f - k_r)) / ((1 - r2_f)/(n - k_f))
        p = 1 - f_dist.cdf(f, k_f - k_r, n - k_f)
        return f, p

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    tests = [
        ('Sys measures add over factors',
         ra, regs['I'], FACTOR_VARS,
         FACTOR_VARS + SYS_MOM_VARS + UTIL_VAR + TAIL_VARS_Q5),
        ('Factors add over sys measures',
         regs['I'], regs['J'],
         SYS_MOM_VARS + UTIL_VAR + TAIL_VARS_Q5,
         FACTOR_VARS + SYS_MOM_VARS + UTIL_VAR + TAIL_VARS_Q5),
        ('Utility adds over sys moments alone',
         regs['B'], regs['D'],
         SYS_MOM_VARS, SYS_MOM_VARS + UTIL_VAR),
        ('Tail adds over utility alone',
         regs['C'], regs['G'],
         UTIL_VAR, UTIL_VAR + TAIL_VARS_Q5),
    ]
    for desc, r_restr, r_full, vars_r, vars_f in tests:
        f, p = f_test(r_restr.rsquared, r_full.rsquared, n,
                      len(vars_f) + 1, len(vars_r) + 1)
        if np.isnan(f):
            continue
        sig = 'YES ***' if p < 0.01 else ('yes *' if p < 0.05 else 'no')
        print(f"  {desc:<42} F={f:6.2f}  p={p:.4f}  {sig}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 6.  FIXED GAMMA SENSITIVITY
# ══════════════════════════════════════════════════════════════════════════════

def gamma_sensitivity(all_factors, deciles, industries,
                      gammas=(1, 2, 5, 10, 20)):
    """
    For fixed theoretically motivated gamma values, test predictive power
    of utility cost. Shows how sensitive results are to utility assumption.
    """
    print(f"\n── Gamma Sensitivity (fixed values) ─────────────────────────────")
    print(f"  {'Gamma':>7}  {'Util R²':>8}  {'Sys mom R²':>11}  "
          f"{'Combined R²':>12}  {'Util t-stat':>12}")
    print("  " + "-" * 58)

    rows = []
    for gamma in gammas:
        df = build_cross_section(all_factors, deciles, industries, gamma)
        req = ['mean_excess'] + UTIL_VAR + SYS_MOM_VARS
        sub = df.dropna(subset=req)
        y   = sub['mean_excess']

        ru  = sm.OLS(y, sm.add_constant(sub[UTIL_VAR])).fit()
        rm  = sm.OLS(y, sm.add_constant(sub[SYS_MOM_VARS])).fit()
        rc  = sm.OLS(y, sm.add_constant(
                        sub[UTIL_VAR + SYS_MOM_VARS])).fit()
        t_util = ru.tvalues.get('util_cost', np.nan)

        print(f"  {gamma:>7.1f}  {ru.rsquared:>8.4f}  "
              f"{rm.rsquared:>11.4f}  {rc.rsquared:>12.4f}  "
              f"{t_util:>+12.3f}")
        rows.append({'gamma': gamma, 'util_r2': ru.rsquared,
                     'mom_r2': rm.rsquared, 'comb_r2': rc.rsquared,
                     'util_t': t_util})

    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════════════════════
# 7.  OUT-OF-SAMPLE VALIDATION
# ══════════════════════════════════════════════════════════════════════════════

def out_of_sample_test(factors_all, deciles, industries,
                       split_year=1990):
    """
    Estimate gamma on pre-split data, test on post-split data.
    Checks whether the utility framework is genuinely predictive
    or just in-sample curve fitting.
    """
    print(f"\n── Out-of-Sample Validation (split: {split_year}) ───────────────")

    split_date = pd.Timestamp(f'{split_year}-01-01')

    # In-sample: estimate gamma
    f_in  = {k: v.loc[:split_date] for k,v in
             {'factors': factors_all}.items()}
    f_in  = factors_all.loc[:split_date]
    d_in  = {k: v.loc[:split_date] for k,v in deciles.items()}
    i_in  = industries.loc[:split_date]

    print(f"  In-sample:  {factors_all.index[0].year}–{split_year} "
          f"({len(f_in)} months)")

    # Estimate equilibrium gamma in-sample
    gamma_grid = np.linspace(0.5, 20, 20)
    best_gamma, _, _ = estimate_gamma(f_in, d_in, i_in,
                                      gamma_grid=gamma_grid,
                                      verbose=False)
    print(f"  In-sample gamma: {best_gamma:.2f}")

    # Out-of-sample: test
    f_out = factors_all.loc[split_date:]
    d_out = {k: v.loc[split_date:] for k,v in deciles.items()}
    i_out = industries.loc[split_date:]

    print(f"  Out-of-sample: {split_year}–{factors_all.index[-1].year} "
          f"({len(f_out)} months)")

    # Test at estimated gamma and at gamma=2 (theoretical)
    for gamma, label in [(best_gamma, 'estimated γ'),
                         (2.0, 'fixed γ=2'),
                         (5.0, 'fixed γ=5')]:
        df_out = build_cross_section(f_out, d_out, i_out, gamma)
        req    = ['mean_excess'] + UTIL_VAR + FACTOR_VARS
        sub    = df_out.dropna(subset=req)
        if len(sub) < 10:
            continue
        y = sub['mean_excess']
        ru = sm.OLS(y, sm.add_constant(sub[UTIL_VAR])).fit()
        ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
        t  = ru.tvalues.get('util_cost', np.nan)
        print(f"  {label}: util R²={ru.rsquared:.4f} "
              f"(t={t:+.2f})  factor R²={ra.rsquared:.4f}")

    return best_gamma


# ══════════════════════════════════════════════════════════════════════════════
# 8.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs, gamma_df, sens_df, outpath='utility_equilibrium.png'):
    req = (['mean_excess'] + FACTOR_VARS + SYS_MOM_VARS +
           UTIL_VAR + TAIL_VARS_Q5)
    sub = df.dropna(subset=req)
    y   = sub['mean_excess']

    fig = plt.figure(figsize=(16, 14))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.38)
    colors = {'decile': 'steelblue', 'industry': 'darkorange'}

    def scatter_fit(ax, reg, title):
        yhat = reg.fittedvalues
        for ptype, grp in sub.groupby('portfolio_type'):
            ax.scatter(yhat.loc[grp.index]*100,
                       grp['mean_excess']*100,
                       alpha=0.5, s=20, color=colors[ptype],
                       label=ptype)
        mn = min(yhat.min(), sub['mean_excess'].min())*100 - 0.3
        mx = max(yhat.max(), sub['mean_excess'].max())*100 + 0.3
        ax.plot([mn,mx],[mn,mx],'k--',lw=1,alpha=0.4)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel('Fitted (%)'); ax.set_ylabel('Realised (%)')
        ax.text(0.05, 0.92, f'R²={reg.rsquared:.3f}',
                transform=ax.transAxes, fontsize=8, color='navy')

    ax1 = fig.add_subplot(gs[0,0])
    scatter_fit(ax1, regs['A'], 'Model A: Factors Only')
    ax1.legend(fontsize=6)

    ax2 = fig.add_subplot(gs[0,1])
    scatter_fit(ax2, regs['C'], 'Model C: Utility Cost Only')

    ax3 = fig.add_subplot(gs[0,2])
    scatter_fit(ax3, regs['I'], 'Model I: Full Systematic')

    # Utility cost vs mean excess return
    ax4 = fig.add_subplot(gs[1,0])
    for ptype, grp in sub.groupby('portfolio_type'):
        ax4.scatter(grp['util_cost'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[ptype])
    ax4.set_xlabel('Utility Cost E[U*(R_sys)]')
    ax4.set_ylabel('Mean Excess Return (%)')
    ax4.set_title('Utility Cost vs Realised Return')
    corr = sub['util_cost'].corr(sub['mean_excess'])
    ax4.text(0.05, 0.92, f'r={corr:.3f}',
             transform=ax4.transAxes, fontsize=8, color='navy')

    # Gamma search: EU dispersion
    ax5 = fig.add_subplot(gs[1,1])
    ax5.plot(gamma_df['gamma'], gamma_df['eu_disp'],
             color='steelblue', lw=2, label='EU dispersion')
    ax5_r = ax5.twinx()
    ax5_r.plot(gamma_df['gamma'], gamma_df['pred_r2'],
               color='darkorange', lw=2, ls='--', label='Pred R²')
    ax5.set_xlabel('Gamma (risk aversion)')
    ax5.set_ylabel('EU dispersion', color='steelblue')
    ax5_r.set_ylabel('Predictive R²', color='darkorange')
    ax5.set_title('Gamma Estimation')
    lines1, labels1 = ax5.get_legend_handles_labels()
    lines2, labels2 = ax5_r.get_legend_handles_labels()
    ax5.legend(lines1+lines2, labels1+labels2, fontsize=7)

    # Gamma sensitivity: R² by gamma
    ax6 = fig.add_subplot(gs[1,2])
    ax6.plot(sens_df['gamma'], sens_df['util_r2'],
             marker='o', label='Utility only', color='steelblue')
    ax6.plot(sens_df['gamma'], sens_df['mom_r2'],
             marker='s', label='Sys moments', color='darkorange')
    ax6.plot(sens_df['gamma'], sens_df['comb_r2'],
             marker='^', label='Combined', color='green')
    ax6.set_xlabel('Gamma'); ax6.set_ylabel('R²')
    ax6.set_title('Predictive R² by Gamma Value')
    ax6.legend(fontsize=7)

    # R² bar chart: all models
    ax7 = fig.add_subplot(gs[2,:2])
    model_keys = ['A','B','C','D','E','G','I','J']
    model_labels = ['A\nFactors', 'B\nSysMom', 'C\nUtil',
                    'D\nMom+Util', 'E\nTail q5',
                    'G\nUtil+Tail', 'I\nFullSys', 'J\nF+Sys']
    r2_vals = [regs[k].rsquared if k in regs else 0
               for k in model_keys]
    bar_colors = ['steelblue' if k == 'A' else
                  'darkorange' if k in ['B','C','D','E','G','I'] else
                  'green'
                  for k in model_keys]
    ax7.bar(model_labels, r2_vals, color=bar_colors, alpha=0.8)
    ax7.set_ylabel('R²')
    ax7.set_title('R² Across Models  '
                  '(blue=factors, orange=systematic, green=combined)')
    for i, v in enumerate(r2_vals):
        ax7.text(i, v + 0.005, f'{v:.3f}', ha='center', fontsize=7)

    # Systematic sigma vs mean excess
    ax8 = fig.add_subplot(gs[2,2])
    for ptype, grp in sub.groupby('portfolio_type'):
        ax8.scatter(grp['sys_sigma']*100, grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[ptype])
    ax8.set_xlabel('Systematic Sigma (%)')
    ax8.set_ylabel('Mean Excess Return (%)')
    ax8.set_title('Systematic Volatility vs Return')
    corr = sub['sys_sigma'].corr(sub['mean_excess'])
    ax8.text(0.05, 0.92, f'r={corr:.3f}',
             transform=ax8.transAxes, fontsize=8, color='navy')

    fig.suptitle(
        'Utility Equilibrium Test: E[U*(R_systematic)] vs Factor Premia',
        fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 9.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def nonlinearity_diagnostic(df, label='All portfolios'):
    """
    Test whether polynomial nonlinearity coefficients are consistently
    signed across portfolios.

    If b2 and b3 are genuine systematic features of the stock-market
    relationship, they should be consistently signed across all portfolios
    — most portfolios should have the same sign, and the mean should be
    significantly different from zero (one-sample t-test).

    If they are random noise from overfitting, signs should be roughly
    50/50 and the mean indistinguishable from zero.

    Also checks whether nonlin_r2_gain is plausibly small (genuine
    nonlinearity adds a few % R² to the stock-market scatter) vs large
    (polynomial is chasing idiosyncratic noise).
    """
    print(f"\n{'='*65}")
    print(f"Nonlinearity Diagnostic: {label}")
    print(f"{'='*65}")

    for col, name in [
        ('poly_b2', 'Quadratic term b2 (coskewness proxy)'),
        ('poly_b3', 'Cubic term b3    (cokurtosis proxy)'),
        ('beta_asym_poly', 'Beta asymmetry   (tail - boom beta)'),
        ('nonlin_r2_gain', 'Nonlinear R² gain over linear beta'),
    ]:
        if col not in df.columns:
            continue
        vals = df[col].dropna()
        if len(vals) == 0:
            continue

        mean   = float(vals.mean())
        std    = float(vals.std())
        se     = std / np.sqrt(len(vals))
        t_stat = mean / se if se > 0 else np.nan
        pct_pos = float((vals > 0).mean() * 100)
        pct_neg = float((vals < 0).mean() * 100)

        # Two-sided t-test against zero
        from scipy.stats import ttest_1samp
        _, p_val = ttest_1samp(vals.dropna(), 0)

        sig = '***' if p_val < 0.01 else ('*' if p_val < 0.05 else '  ')
        consistent = 'CONSISTENT' if max(pct_pos, pct_neg) > 70 else (
                     'MODERATE'   if max(pct_pos, pct_neg) > 60 else
                     'MIXED — likely noise')

        print(f"\n  {name}")
        print(f"    Mean={mean:+.5f}  Std={std:.5f}  t={t_stat:+.2f}{sig}  p={p_val:.4f}")
        print(f"    Positive: {pct_pos:.1f}%   Negative: {pct_neg:.1f}%")
        print(f"    Sign consistency: {consistent}")

    # Distribution of nonlin_r2_gain specifically
    if 'nonlin_r2_gain' in df.columns:
        gains = df['nonlin_r2_gain'].dropna()
        print(f"\n  Nonlinear R² gain distribution:")
        print(f"    Median={gains.median():.4f}  "
              f"Mean={gains.mean():.4f}  "
              f"Max={gains.max():.4f}")
        print(f"    Portfolios with gain > 0.05: "
              f"{(gains > 0.05).sum()} of {len(gains)}")
        print(f"    Portfolios with gain > 0.10: "
              f"{(gains > 0.10).sum()} of {len(gains)}")
        print(f"    (Genuine nonlinearity: expect median ~0.01-0.03)")
        print(f"    (Overfitting:          expect median > 0.05)")

    # Cross-portfolio correlation of b2 and b3 with mean_excess
    print(f"\n  Correlation with mean excess return:")
    for col in ['poly_b2','poly_b3','beta_asym_poly']:
        if col in df.columns:
            c = df[col].corr(df['mean_excess'])
            print(f"    {col:<20}: r = {c:+.4f}")

    print(f"\n  Interpretation:")
    print(f"  If b2/b3 are consistently signed and significantly != 0,")
    print(f"  the nonlinearity is a genuine systematic feature and the")
    print(f"  polynomial systematic component is theoretically valid.")
    print(f"  If mixed signs and nonlin_r2_gain is large, the polynomial")
    print(f"  is overfitting idiosyncratic noise — revert to linear beta")
    print(f"  and use b2/b3 only as additional cross-sectional predictors.")


def main():
    print("=" * 65)
    print("Utility Equilibrium Test")
    print("Does E[U*(R_systematic)] explain cross-sectional returns?")
    print("=" * 65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    # Step 1: Estimate gamma from data
    gamma_eq, gamma_pred, gamma_df = estimate_gamma(
        all_factors, deciles, industries)

    # Step 2: Build cross-section at estimated gamma
    print(f"\nBuilding cross-section at equilibrium gamma={gamma_eq:.2f}...")
    df_main = build_cross_section(
        all_factors, deciles, industries, gamma_eq)

    # Step 2b: Nonlinearity diagnostic
    nonlinearity_diagnostic(df_main, 'All portfolios')
    ind_diag = df_main[df_main['portfolio_type']=='industry']
    if len(ind_diag) > 20:
        nonlinearity_diagnostic(ind_diag, 'Industry portfolios only')

    # Step 3: Main regressions
    regs_all, sub_all = run_regressions(df_main, 'All portfolios')

    # Industry portfolios only
    ind_df = df_main[df_main['portfolio_type'] == 'industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_regressions(ind_df,
                                      'Industry portfolios only (unbiased)')

    # Step 4: Fixed gamma sensitivity
    sens_df = gamma_sensitivity(all_factors, deciles, industries,
                                gammas=[1, 2, 5, 10, 20])

    # Step 5: Out-of-sample validation
    oos_gamma = out_of_sample_test(all_factors, deciles, industries,
                                   split_year=1990)

    # Step 6: Plots
    print("\nGenerating plots...")
    make_plots(df_main, regs_all, gamma_df, sens_df)

    # Summary
    ra = regs_all['A']
    rc = regs_all['C']
    ri = regs_all['I']
    print("\n" + "=" * 65)
    print("SUMMARY")
    print("=" * 65)
    print(f"  Estimated equilibrium gamma:     {gamma_eq:.2f}")
    print(f"  Estimated predictive gamma:      {gamma_pred:.2f}")
    print()
    print(f"  Factors only R²:                 {ra.rsquared:.4f}")
    print(f"  Utility cost only R²:            {rc.rsquared:.4f}  "
          f"({rc.rsquared/ra.rsquared*100:.1f}% of factor R²)")
    print(f"  Full systematic R²:              {ri.rsquared:.4f}  "
          f"({ri.rsquared/ra.rsquared*100:.1f}% of factor R²)")
    print()
    t_util = rc.tvalues.get('util_cost', np.nan)
    if not np.isnan(t_util) and abs(t_util) > 2:
        print(f"  Utility cost is significant (t={t_util:+.2f})")
        print("  → Equilibrium condition E[U*(R_sys)] = U*(rf) is supported")
    else:
        print(f"  Utility cost is not significant (t={t_util:+.2f})")
        print("  → Equilibrium condition not confirmed at this gamma")
    print("=" * 65)
    print("\nDone.")


if __name__ == '__main__':
    main()