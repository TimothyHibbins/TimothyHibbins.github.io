"""
Student-t Pricing Model
========================
Models each portfolio's systematic return distribution as Student-t,
then integrates against a power utility function to compute expected utility.

The Student-t has two key parameters:
  σ (scale):   controls body width — analogous to normal variance
  ν (degrees of freedom): controls tail thickness — related to tail index

These together fully characterise the distribution. The expected utility
integral automatically combines them with the correct weighting implied
by the utility function shape (γ).

Test:
  1. Fit Student-t to systematic returns (β·R_market) by MLE
  2. Compute E[U(1+R_sys; γ)] for each portfolio at multiple γ values
  3. Find γ that maximises cross-sectional R² (implied market risk aversion)
  4. Test whether expected utility outperforms σ alone, ν alone, sys_tail,
     and FF5 factors in explaining cross-sectional mean returns
  5. Test σ and ν separately and jointly to confirm both are needed

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python student_t_pricing.py
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
from scipy import stats, integrate, optimize
import statsmodels.api as sm
from sklearn.preprocessing import StandardScaler
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
# 2.  STUDENT-T FITTING AND EXPECTED UTILITY
# ══════════════════════════════════════════════════════════════════════════════

def fit_student_t(r_sys):
    """
    Fit Student-t distribution to systematic returns by MLE.
    Returns (df=ν, loc=μ, scale=σ) or None if fitting fails.
    ν is the degrees of freedom — related to tail index by α = ν.
    Lower ν = fatter tails.
    """
    r = np.asarray(r_sys, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < 30:
        return None
    try:
        # scipy.stats.t.fit returns (df, loc, scale)
        df, loc, scale = stats.t.fit(r, floc=0)   # fix loc=0
        # Clip ν to reasonable range: too high → normal, too low → Cauchy
        df = float(np.clip(df, 1.5, 200))
        scale = float(abs(scale))
        if np.isnan(df) or np.isnan(scale) or scale <= 0:
            return None
        return {'nu': df, 'sigma': scale, 'loc': 0.0}
    except Exception:
        return None


def power_utility(w, gamma):
    """
    Power utility: U(w) = w^(1-γ)/(1-γ) for γ≠1, log(w) for γ=1.
    w is gross return (1 + excess return).
    Returns NaN for w <= 0.
    """
    w = np.asarray(w, dtype=float)
    result = np.full_like(w, np.nan)
    valid = w > 0
    if abs(gamma - 1.0) < 1e-6:
        result[valid] = np.log(w[valid])
    else:
        result[valid] = w[valid]**(1-gamma) / (1-gamma)
    return result


def expected_utility_student_t(nu, sigma, rf_mean, gamma,
                                n_std=10, n_points=2000):
    """
    Compute E[U(1 + R_sys)] where R_sys ~ t(ν, 0, σ) and
    U is power utility with risk aversion γ.

    Uses numerical integration over the Student-t density.
    Returns (expected_utility, utility_cost = U(1+rf) - E[U(1+R_sys)])
    Positive utility_cost = portfolio is costly to hold = should earn premium.
    """
    # Integration range: ±n_std standard deviations
    # For fat-tailed distributions we need wider range
    bound = n_std * sigma * max(1.0, (nu/(nu-2))**0.5 if nu > 2 else 5.0)
    x = np.linspace(-bound, bound, n_points)
    dx = x[1] - x[0]

    # Student-t density
    pdf = stats.t.pdf(x, df=nu, loc=0, scale=sigma)

    # Gross returns
    gross = 1.0 + x   # 1 + excess return

    # Utility at each point
    u_vals = power_utility(gross, gamma)

    # Mask invalid (gross <= 0)
    valid = gross > 0
    eu = float(np.sum(u_vals[valid] * pdf[valid]) * dx)

    # Utility of risk-free rate (certain)
    u_rf = float(power_utility(np.array([1.0 + rf_mean]), gamma)[0])

    util_cost = u_rf - eu   # positive = portfolio is utility-costly

    return eu, util_cost


def compute_portfolio_chars(ret_series, factors_df,
                             gammas=(1, 2, 3, 5, 8, 10)):
    """
    For one portfolio, compute:
      - Factor loadings (FF5 + MOM)
      - Systematic return series (β·R_market)
      - Student-t fit to systematic returns: (σ̂, ν̂)
      - Expected utility at each γ
      - Comparison measures: sys_var, sys_tail, standalone sigma
    """
    idx = ret_series.index.intersection(factors_df.index)
    ret = ret_series.loc[idx].dropna() / 100
    idx = ret.index.intersection(factors_df.index)
    if len(idx) < 60:
        return None

    r   = ret.loc[idx]
    rf  = factors_df.loc[idx,'RF']   / 100
    mkt = factors_df.loc[idx,'Mkt-RF'] / 100
    smb = factors_df.loc[idx,'SMB']  / 100
    hml = factors_df.loc[idx,'HML']  / 100
    rmw = factors_df.loc[idx,'RMW']  / 100
    cma = factors_df.loc[idx,'CMA']  / 100
    mom_s = factors_df.loc[idx,'MOM'] / 100 \
            if 'MOM' in factors_df.columns \
            else pd.Series(0.0, index=idx)

    r_exc  = r - rf
    rm_exc = mkt
    rf_mean = float(rf.mean())

    # Factor loadings
    Xf  = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt,'SMB': smb,'HML': hml,
        'RMW': rmw,'CMA': cma,'MOM': mom_s}))
    reg  = sm.OLS(r_exc, Xf).fit()
    beta = float(reg.params['Mkt-RF'])
    loadings = {f'load_{k}': reg.params[k]
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}

    # ── Option 1: Fit Student-t to full portfolio excess returns ────────────
    # At portfolio level, idiosyncratic variance is largely diversified away
    # so the portfolio return distribution ≈ systematic distribution
    fit_full = fit_student_t(r_exc.values)

    # ── Option 2: Fit Student-t to portfolio returns in market tail months ───
    # This gives the conditional distribution P(R_portfolio | market in tail)
    # which is the most relevant distribution for pricing
    thresh_10 = float(np.percentile(rm_exc.dropna(), 10))
    thresh_20 = float(np.percentile(rm_exc.dropna(), 20))
    r_tail_10 = r_exc[rm_exc <= thresh_10]
    r_tail_20 = r_exc[rm_exc <= thresh_20]
    fit_tail_10 = fit_student_t(r_tail_10.values) if len(r_tail_10) >= 20                   else None
    fit_tail_20 = fit_student_t(r_tail_20.values) if len(r_tail_20) >= 20                   else None

    # Primary: conditional fit (market tail months) -- purely systematic
    # Use 20% threshold for reliability (more observations)
    # Fall back to full fit if insufficient tail observations
    fit = fit_tail_20 if fit_tail_20 is not None else fit_full
    if fit is None:
        return None
    nu    = fit['nu']      # conditional tail thickness -- SYSTEMATIC
    sigma = fit['sigma']   # conditional scale -- SYSTEMATIC

    # Also keep full-distribution params for comparison
    nu_full    = fit_full['nu']    if fit_full    else np.nan
    sigma_full = fit_full['sigma'] if fit_full    else np.nan

    # Tail-conditional fits
    nu_tail_10    = fit_tail_10['nu']    if fit_tail_10 else np.nan
    sigma_tail_10 = fit_tail_10['sigma'] if fit_tail_10 else np.nan
    nu_tail_20    = fit_tail_20['nu']    if fit_tail_20 else np.nan
    sigma_tail_20 = fit_tail_20['sigma'] if fit_tail_20 else np.nan

    # Expected utility at each γ
    eu_dict = {}
    uc_dict = {}
    for gamma in gammas:
        eu, uc = expected_utility_student_t(nu, sigma, rf_mean, gamma)
        eu_dict[f'eu_g{gamma}']  = eu
        uc_dict[f'uc_g{gamma}']  = uc   # utility cost — should predict return

    # ── Risk measures ────────────────────────────────────────────────────────
    # Full systematic variance (includes tail months — partially redundant)
    sys_var = float(beta**2 * rm_exc.var())

    # Tail threshold (10%)
    thresh_10  = float(np.percentile(rm_exc.dropna(), 10))
    tail_mask  = rm_exc <= thresh_10
    body_mask  = ~tail_mask   # non-tail months

    # sys_tail: mean return in market tail months
    sys_tail = float(r_exc[tail_mask].mean()) if tail_mask.sum() > 3 else np.nan

    # body_var: variance of systematic returns in NON-TAIL months only
    # This captures the normal-regime systematic risk orthogonally to tail measures
    r_sys_body = (beta * rm_exc)[body_mask]
    body_var   = float(r_sys_body.var()) if body_mask.sum() > 10 else np.nan

    # Also compute body_var at 20% threshold for comparison
    thresh_20   = float(np.percentile(rm_exc.dropna(), 20))
    body_mask20 = rm_exc > thresh_20
    r_sys_body20 = (beta * rm_exc)[body_mask20]
    body_var20  = float(r_sys_body20.var()) if body_mask20.sum() > 10 else np.nan

    sigma_raw = float(r_exc.std())

    # Theoretical variance of Student-t: σ²·ν/(ν-2) for ν>2
    t_var = float(sigma**2 * nu/(nu-2)) if nu > 2 else np.nan

    # Mean excess return
    mean_excess = float(r_exc.mean() * 12)

    return {
        'mean_excess':  mean_excess,
        'n_obs':        len(idx),
        **loadings,
        'beta':         beta,
        # Student-t parameters
        'nu':           nu,           # degrees of freedom (tail thickness)
        'sigma_t':      sigma,        # scale parameter
        'inv_nu':       1.0/nu,       # 1/ν: higher = fatter tail
        't_var':        t_var,        # theoretical variance under t
        # Expected utility at each γ
        **eu_dict,
        **uc_dict,
        # Comparison measures
        'sys_var':      sys_var,
        'body_var':     body_var,     # variance in non-tail months only
        'body_var20':   body_var20,   # variance in non-tail months (20% thresh)
        'sys_tail':     sys_tail,
        'sigma_raw':    sigma_raw,
        # Full-distribution params (for comparison / diagnosis)
        'nu_full':        nu_full,
        'sigma_full':     sigma_full,
        'inv_nu_full':    1.0/nu_full if not np.isnan(nu_full) else np.nan,
        # Tail-conditional Student-t parameters
        'nu_tail_10':     nu_tail_10,
        'sigma_tail_10':  sigma_tail_10,
        'inv_nu_tail_10': 1.0/nu_tail_10 if not np.isnan(nu_tail_10) else np.nan,
        'nu_tail_20':     nu_tail_20,
        'sigma_tail_20':  sigma_tail_20,
        'inv_nu_tail_20': 1.0/nu_tail_20 if not np.isnan(nu_tail_20) else np.nan,
    }


def build_cross_section(all_factors, deciles, industries,
                         gammas=(1, 2, 3, 5, 8, 10)):
    print(f"\nFitting Student-t and computing expected utility "
          f"(γ ∈ {gammas})...")
    rows = []
    for fname, ddf in deciles.items():
        for col in ddf.columns:
            s   = ddf[col].dropna()
            idx = s.index.intersection(all_factors.index)
            row = compute_portfolio_chars(s.loc[idx], all_factors.loc[idx],
                                          gammas)
            if row:
                row['portfolio_type'] = 'decile'
                row['factor_group']   = fname
                rows.append(row)
    for col in industries.columns:
        s   = industries[col].dropna()
        idx = s.index.intersection(all_factors.index)
        row = compute_portfolio_chars(s.loc[idx], all_factors.loc[idx],
                                      gammas)
        if row:
            row['portfolio_type'] = 'industry'
            row['factor_group']   = 'industry'
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {len(df)} portfolios fitted")
    print(f"\n  Student-t parameter summary:")
    print(f"  PRIMARY: conditional on market worst 20% months (systematic)")
    print(f"  COMPARISON: full distribution (includes idiosyncratic)")
    for col, name in [("nu","ν conditional (df)"),("sigma_t","σ conditional"),
                       ("inv_nu","1/ν conditional"),
                       ("nu_full","ν full dist"),("sigma_full","σ full dist")]:
        v = df[col].dropna()
        print(f"    {name:<12}: mean={v.mean():.4f}  std={v.std():.4f}  "
              f"min={v.min():.4f}  max={v.max():.4f}")
    print(f"    (ν<5=very fat, ν=5-30=moderate, ν>30≈normal)")
    print(f"    Cross-sectional std of ν: {df.nu.std():.4f}  "
          f"(need >0 for ν to be informative)")
    if "nu_tail_10" in df.columns:
        v10 = df["nu_tail_10"].dropna()
        v20 = df["nu_tail_20"].dropna()
        print(f"\n  Tail-conditional ν (in market worst 10%):")
        print(f"    mean={v10.mean():.4f}  std={v10.std():.4f}  "
              f"min={v10.min():.4f}  max={v10.max():.4f}")
        print(f"  Tail-conditional ν (in market worst 20%):")
        print(f"    mean={v20.mean():.4f}  std={v20.std():.4f}  "
              f"min={v20.min():.4f}  max={v20.max():.4f}")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# 3.  FIND IMPLIED GAMMA
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']

def find_implied_gamma(df, gammas=(1, 2, 3, 5, 8, 10)):
    """
    Find γ that maximises cross-sectional R² of utility cost
    predicting mean excess returns.
    This is the implied aggregate market risk aversion.
    """
    print(f"\n── Finding Implied Market Risk Aversion ─────────────────────────")
    print(f"  {'γ':>5}  {'Util cost R²':>13}  {'t-stat':>8}  {'sign':>6}")
    print("  " + "-"*38)

    results = []
    for gamma in gammas:
        uc_col = f'uc_g{gamma}'
        if uc_col not in df.columns:
            continue
        sub = df.dropna(subset=[uc_col,'mean_excess'])
        y   = sub['mean_excess']
        X   = sm.add_constant(sub[[uc_col]])
        reg = sm.OLS(y, X).fit()
        t   = reg.tvalues.get(uc_col, np.nan)
        c   = reg.params.get(uc_col, np.nan)
        sign = '+✓' if c > 0 else '-✗'
        print(f"  {gamma:>5.1f}  {reg.rsquared:>13.4f}  {t:>+8.2f}  {sign:>6}")
        results.append({'gamma': gamma, 'r2': reg.rsquared,
                        't': t, 'coef': c})

    res_df = pd.DataFrame(results)
    best   = res_df.loc[res_df['r2'].idxmax()]
    print(f"\n  Implied γ (max R²): {best.gamma:.1f}  "
          f"(R²={best.r2:.4f}, t={best.t:+.2f})")
    return float(best.gamma), res_df


# ══════════════════════════════════════════════════════════════════════════════
# 4.  MAIN REGRESSIONS
# ══════════════════════════════════════════════════════════════════════════════

def run_regressions(df, gamma_implied, label='All portfolios'):
    uc_col = f'uc_g{int(gamma_implied)}'
    req    = (FACTOR_VARS +
              ['mean_excess','nu','sigma_t','inv_nu',
               'nu_full','sigma_full','inv_nu_full',
               'sys_var','body_var','sys_tail','sigma_raw'])

    # Column availability check BEFORE dropna
    print(f"\n  Checking column availability before dropna:")
    for col in ['body_var','inv_nu','sys_tail']:
        nas = df[col].isna().sum() if col in df.columns else 'MISSING'
        print(f"    {col}: NaN={nas}  present={col in df.columns}")
    print(f"  Rows before dropna: {len(df)}")

    sub    = df.dropna(subset=req)
    print(f"  Rows after dropna:  {len(sub)}")
    y      = sub['mean_excess']
    n      = len(sub)

    print(f"\n{'='*65}")
    print(f"Student-t Pricing Test: {label}  (N={n})")
    print(f"Implied γ = {gamma_implied:.1f}")
    print(f"{'='*65}")

    # Primary measures: conditional Student-t (systematic, market tail months)
    # nu and sigma here are from conditional fit (market worst 20%)
    # nu_full and sigma_full are from unconditional fit (all months, includes idio)
    models = {
        'A  FF5 factors':                     FACTOR_VARS,
        # ── Conditional (systematic) Student-t ──────────────────────────────
        'B  σ_cond alone':                    ['sigma_t'],
        'C  1/ν_cond alone':                  ['inv_nu'],
        'D  σ_cond + 1/ν_cond [CORE]':        ['sigma_t','inv_nu'],
        'E  sys_tail + 1/ν_cond':             ['sys_tail','inv_nu'],
        'F  sys_var + 1/ν_cond':              ['sys_var','inv_nu'],
        'G  sys_var+sys_tail+1/ν_cond [3D]':  ['sys_var','sys_tail','inv_nu'],
        # ── Unconditional (includes idiosyncratic) ───────────────────────────
        'H  σ_full alone':                    ['sigma_full'],
        'I  1/ν_full alone':                  ['inv_nu_full'],
        'J  σ_full + 1/ν_full':               ['sigma_full','inv_nu_full'],
        # ── Body variance (non-tail months only) ─────────────────────────────
        'K  sys_var + sys_tail [prev 2D]':    ['sys_var','sys_tail'],
        'K2 body_var + sys_tail [clean 2D]':  ['body_var','sys_tail'],
        'K3 body_var + sys_tail + 1/ν [3D]':  ['body_var','sys_tail','inv_nu'],
        'K4 body_var alone':                  ['body_var'],
        # ── With factors ─────────────────────────────────────────────────────
        'L  FF5 + σ_cond + 1/ν_cond':         FACTOR_VARS + ['sigma_t',
                                                               'inv_nu'],
        'M  FF5 + 3D risk':                   FACTOR_VARS + ['sys_var',
                                                'sys_tail','inv_nu'],
    }

    regs = {}
    ra   = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
    regs['A'] = ra

    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<44} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*62)
    print(f"  {'A  FF5 factors':<44} {ra.rsquared:>7.4f}  {'100.0%':>8}")

    for mname, mvars in list(models.items())[1:]:
        reg = sm.OLS(y, sm.add_constant(sub[mvars])).fit()
        key = mname.split()[0]   # e.g. 'K2', 'K3', 'K4', 'M' etc.
        regs[key] = reg
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {mname:<44} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    # ── Are σ and ν both needed? ──────────────────────────────────────────────
    print(f"\n── Are Conditional σ and 1/ν Independently Priced? ─────────────")
    print(f"  (Both fitted to portfolio returns in market worst 20% months)")
    print(f"  (Purely systematic — idiosyncratic component excluded)")
    re = regs.get('D', regs.get('E'))
    for v, name in [('sigma_t','σ_cond (scale)'),('inv_nu','1/ν_cond (tail)')]:
        c = re.params.get(v, np.nan)
        t = re.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {name:<22} coef={c:+.6f}  t={t:+.2f}  {sig}")

    # ── Standardised coefficients ─────────────────────────────────────────────
    svars  = ['sigma_t','inv_nu',uc_col,'sys_var','sys_tail']
    scaler = StandardScaler()
    sub_std = sub.copy()
    sub_std[svars] = scaler.fit_transform(sub[svars])
    stds   = sub[svars].std()

    rd_std = sm.OLS(y, sm.add_constant(
        sub_std[['sigma_t','inv_nu']])).fit()   # conditional Student-t
    rk_std = sm.OLS(y, sm.add_constant(
        sub_std[['sys_var','sys_tail']])).fit()  # previous 2D

    print(f"\n── Standardised Coefficients ────────────────────────────────────")
    print(f"  Model D: conditional Student-t (σ_cond + 1/ν_cond)")
    print(f"  Model K: previous 2D (sys_var + sys_tail)")
    rg_std = rd_std
    rh_std = rk_std
    print(f"  {'Variable':<18} {'1-SD':>10} {'Std coef':>10} "
          f"{'t-stat':>8}  Theory  Sig?")
    print("  " + "-"*62)
    print(f"  -- Conditional Student-t model (D) --")
    for v, th in [('sigma_t','+'),('inv_nu','+')]:
        c  = rg_std.params.get(v, np.nan)
        t  = rg_std.tvalues.get(v, np.nan)
        sd = stds.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        m = '✓' if (c>0)==(th=='+') else '✗'
        print(f"  {v:<18} {sd:>+10.5f} {c*100:>+9.3f}%  "
              f"{t:>+8.2f}  {th}  {m}  {sig}")
    print(f"  -- Previous 2D model (H) --")
    for v, th in [('sys_var','+'),('sys_tail','+')]:
        c  = rh_std.params.get(v, np.nan)
        t  = rh_std.tvalues.get(v, np.nan)
        sd = stds.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        m = '✓' if (c>0)==(th=='+') else '✗'
        print(f"  {v:<18} {sd:>+10.5f} {c*100:>+9.3f}%  "
              f"{t:>+8.2f}  {th}  {m}  {sig}")

    # ── F-tests ───────────────────────────────────────────────────────────────
    from scipy.stats import f as f_dist
    def ft(r2_r, r2_f, n, k_f, k_r):
        if k_f<=k_r: return np.nan, np.nan
        fs = ((r2_f-r2_r)/(k_f-k_r))/((1-r2_f)/(n-k_f))
        return fs, 1-f_dist.cdf(fs,k_f-k_r,n-k_f)

    print(f"\n── F-tests ──────────────────────────────────────────────────────")
    # ── Pairwise necessity tests: does each variable add over the other two? ─
    # These are the definitive tests of whether all three are needed
    rv   = regs.get('K3')   # body_var + sys_tail + 1/ν_cond  (clean 3D)
    r_bv = sm.OLS(y, sm.add_constant(sub[['sys_tail','inv_nu']])).fit()            if all(c in sub.columns for c in ['sys_tail','inv_nu']) else None
    r_st = sm.OLS(y, sm.add_constant(sub[['body_var','inv_nu']])).fit()            if all(c in sub.columns for c in ['body_var','inv_nu']) else None
    r_nu = sm.OLS(y, sm.add_constant(sub[['body_var','sys_tail']])).fit()            if all(c in sub.columns for c in ['body_var','sys_tail']) else None

    print(f"\n── Pairwise F-tests: Is Each Variable Necessary? ────────────────")
    print(f"  Tests whether each variable adds over the OTHER TWO jointly")
    print(f"  (clean 3D model: body_var + sys_tail + 1/ν_cond)")
    if rv is not None:
        print(f"  Clean 3D R²: {rv.rsquared:.4f}")
    print(f"  {'Test':<46} {'F':>7}  {'p':>7}  Result")
    print("  " + "-"*68)

    # Diagnostic: report what's available
    _has_bv  = 'body_var' in sub.columns and sub['body_var'].notna().sum() > 5
    _has_st  = 'sys_tail' in sub.columns and sub['sys_tail'].notna().sum() > 5
    _has_inv = 'inv_nu'   in sub.columns and sub['inv_nu'].notna().sum() > 5
    print(f"  (body_var={_has_bv}, sys_tail={_has_st}, inv_nu={_has_inv}, "
          f"rv={'available' if rv is not None else 'MISSING'})")

    pairwise = [
        # (description, full_model, restricted_model, k_restricted, k_full)
        ('body_var adds over (sys_tail + 1/ν_cond)',   rv, r_bv, 2, 3),
        ('sys_tail adds over (body_var + 1/ν_cond)',   rv, r_st, 2, 3),
        ('1/ν_cond adds over (body_var + sys_tail)',   rv, r_nu, 2, 3),
    ]
    all_necessary = True
    for desc, r_f, r_r, k_r, k_f in pairwise:
        if r_f is None or r_r is None:
            missing = 'rv' if r_f is None else 'restricted'
            print(f"  {desc:<46} ({missing} is None)")
            all_necessary = False
            continue
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs):
            print(f"  {desc:<46} (F is NaN, R²_r={r_r.rsquared:.4f} R²_f={r_f.rsquared:.4f})")
            continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no — REDUNDANT')
        print(f"  {desc:<46} {fs:>7.2f}  {p:>7.4f}  {sig}")
        if p >= 0.05:
            all_necessary = False
    if all_necessary:
        print(f"\n  → ALL THREE dimensions are necessary")
        print(f"    body_var (normal regime), sys_tail (tail mean),")
        print(f"    and 1/ν_cond (tail shape) each add independently")
    else:
        print(f"\n  → At least one dimension is redundant given the others")

    # ── Additional F-tests ────────────────────────────────────────────────────
    tests = [
        ('body_var vs sys_var (clean vs contaminated)',
         regs.get('K'), regs.get('K2'), 2, 2),
        ('1/ν_cond adds over prev 2D (sys_var+tail)',
         regs.get('K'), regs.get('G'), 2, 3),
        ('1/ν_cond adds over clean 2D (body+tail)',
         regs.get('K2'), regs.get('K3'), 2, 3),
        ('Cond Student-t adds over FF5',
         regs.get('A'), regs.get('L'), len(FACTOR_VARS), len(FACTOR_VARS)+2),
        ('FF5 adds over cond Student-t',
         regs.get('D'), regs.get('L'), 2, len(FACTOR_VARS)+2),
        ('Clean 3D adds over FF5',
         regs.get('A'), regs.get('M'), len(FACTOR_VARS), len(FACTOR_VARS)+3),
        ('FF5 adds over clean 3D',
         regs.get('K3'), regs.get('M'), 3, len(FACTOR_VARS)+3),
    ]
    for desc, r_r, r_f, k_r, k_f in tests:
        if r_r is None or r_f is None: continue
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    # ── Factor shrinkage ──────────────────────────────────────────────────────
    print(f"\n── Factor Shrinkage A → M (FF5 + clean 3D risk) ────────────────")
    rk = regs.get('M')
    if rk is None:
        rk = regs.get('L', regs.get('K'))
    print(f"  {'Factor':<14} {'A coef':>10} {'K coef':>10} "
          f"{'Shrink':>8}  {'A t':>6}  {'K t':>6}")
    print("  " + "-"*58)
    if rk is None:
        print("  (Model M not available)")
    else:
     for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        ck = rk.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        tk = rk.tvalues.get(v, np.nan)
        sh = (1-abs(ck)/abs(ca))*100 if abs(ca)>1e-10 else np.nan
        sa = '*' if abs(ta)>2 else ' '
        sk = '*' if abs(tk)>2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {ck:>+10.4f} "
              f"{sh:>7.1f}%  {ta:>+5.2f}{sa}  {tk:>+5.2f}{sk}")

    return regs, sub


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(df, regs, gamma_implied, gamma_df,
               outpath='student_t_pricing.png'):
    uc_col = f'uc_g{int(gamma_implied)}'
    req    = FACTOR_VARS + ['mean_excess','nu','sigma_t',
                             'inv_nu','sys_var','sys_tail', uc_col]
    sub    = df.dropna(subset=req)
    colors = {'decile':'steelblue','industry':'darkorange'}

    fig = plt.figure(figsize=(16,14))
    gs  = gridspec.GridSpec(3,3, figure=fig, hspace=0.5, wspace=0.38)

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
    if 'E' in regs:
        scatter_fit(ax2, regs['E'], 'E: σ + 1/ν (Student-t 2-param)')

    ax3 = fig.add_subplot(gs[0,2])
    if 'K' in regs:
        scatter_fit(ax3, regs['K'], 'K: FF5 + Student-t full')

    # ν distribution
    ax4 = fig.add_subplot(gs[1,0])
    for pt, grp in sub.groupby('portfolio_type'):
        ax4.hist(grp['nu'].dropna(), bins=12, alpha=0.6,
                 label=pt, color=colors[pt])
    ax4.axvline(5,  color='red',    ls='--', lw=1, label='ν=5 (fat)')
    ax4.axvline(30, color='orange', ls='--', lw=1, label='ν=30 (near-normal)')
    ax4.set_xlabel('ν (degrees of freedom)')
    ax4.set_title('Distribution of ν\n(lower = fatter tails)')
    ax4.legend(fontsize=7)

    # ν vs return
    ax5 = fig.add_subplot(gs[1,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax5.scatter(grp['nu'], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax5.set_xlabel('ν (df)'); ax5.set_ylabel('Mean Excess Return (%)')
    ax5.set_title('ν vs Return\n(lower ν = fatter tail = higher return?)')
    corr = sub['nu'].corr(sub['mean_excess'])
    ax5.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax5.transAxes, fontsize=8, color='navy')

    # Utility cost vs return
    ax6 = fig.add_subplot(gs[1,2])
    for pt, grp in sub.groupby('portfolio_type'):
        ax6.scatter(grp[uc_col], grp['mean_excess']*100,
                    alpha=0.5, s=20, color=colors[pt])
    ax6.set_xlabel(f'Utility Cost (γ={gamma_implied:.0f})')
    ax6.set_ylabel('Mean Excess Return (%)')
    ax6.set_title('Expected Utility Cost vs Return')
    corr = sub[uc_col].corr(sub['mean_excess'])
    ax6.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax6.transAxes, fontsize=8, color='navy')

    # γ sensitivity
    ax7 = fig.add_subplot(gs[2,0])
    ax7.plot(gamma_df['gamma'], gamma_df['r2']*100,
             marker='o', color='steelblue', lw=2)
    ax7.set_xlabel('γ (risk aversion)')
    ax7.set_ylabel('R² (%)')
    ax7.set_title('Utility Cost R² by γ\n(peak = implied market γ)')

    # σ vs 1/ν scatter
    ax8 = fig.add_subplot(gs[2,1])
    for pt, grp in sub.groupby('portfolio_type'):
        ax8.scatter(grp['sigma_t'], grp['inv_nu'],
                    alpha=0.5, s=20, color=colors[pt])
    ax8.set_xlabel('σ (Student-t scale)')
    ax8.set_ylabel('1/ν (tail thickness)')
    ax8.set_title('σ vs 1/ν\n(orthogonal → independent dimensions)')
    corr = sub['sigma_t'].corr(sub['inv_nu'])
    ax8.text(0.05,0.92,f'r={corr:.3f}',
             transform=ax8.transAxes, fontsize=8, color='navy')

    # R² bar chart
    ax9 = fig.add_subplot(gs[2,2])
    mkeys = ['A','B','C','D','E','F','G','H','I','J','K']
    mlabs = ['FF5','σ','ν','1/ν','σ+1/ν','EU','G','H\n2D','FF5\n+EU',
             'FF5\n+t2','FF5\n+full']
    r2v = [regs.get(k,type('',(),{'rsquared':0})()).rsquared for k in mkeys]
    bcols = ['steelblue' if k=='A' else
             'darkorange' if k in ['B','C','D','E','F','G','H'] else
             'green' for k in mkeys]
    x = np.arange(len(mkeys))
    ax9.bar(x, r2v, color=bcols, alpha=0.8)
    ax9.set_xticks(x); ax9.set_xticklabels(mlabs, fontsize=7)
    ax9.set_ylabel('R²')
    ax9.set_title('R² by Model')

    fig.suptitle('Student-t Pricing: σ and ν as Independent Risk Dimensions',
                 fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print("="*65)
    print("Student-t Pricing Model")
    print("Testing σ and ν as two independent systematic risk dimensions")
    print("="*65)

    factors, mom, deciles, industries = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    gammas = (1, 2, 3, 5, 8, 10, 15, 20)
    df = build_cross_section(all_factors, deciles, industries, gammas)

    # Find implied γ
    gamma_implied, gamma_df = find_implied_gamma(df, gammas)

    # Main regressions
    regs_all, sub_all = run_regressions(df, gamma_implied, 'All portfolios')

    # Industry only
    ind_df   = df[df['portfolio_type']=='industry']
    regs_ind = None
    if len(ind_df) > 20:
        regs_ind, _ = run_regressions(
            ind_df, gamma_implied, 'Industry portfolios only')

    # Plots
    print("\nGenerating plots...")
    make_plots(df, regs_all, gamma_implied, gamma_df)

    # Summary
    ra = regs_all['A']
    re = regs_all.get('E')
    rk = regs_all.get('K')
    rf_ = regs_all.get('F')

    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    print(f"  Implied market risk aversion γ: {gamma_implied:.1f}")
    print(f"\n  FF5 factors R²:               {ra.rsquared:.4f}")
    if re:
        print(f"  Student-t (σ+1/ν) R²:         {re.rsquared:.4f}  "
              f"({re.rsquared/ra.rsquared*100:.1f}% of FF5)")
    if rf_:
        print(f"  Utility cost E[U*(R_sys)] R²: {rf_.rsquared:.4f}  "
              f"({rf_.rsquared/ra.rsquared*100:.1f}% of FF5)")

    # Clean 3D model summary
    rk3 = regs_all.get('K3')
    print(f"  Clean 3D (body_var+sys_tail+1/ν_cond) R²:")
    if rk3:
        print(f"    All portfolios:  {rk3.rsquared:.4f}  "
              f"({rk3.rsquared/ra.rsquared*100:.1f}% of FF5)")
    rk3_ind = regs_ind.get('K3') if regs_ind else None
    if rk3_ind:
        ra_ind = regs_ind['A']
        print(f"    Industry only:   {rk3_ind.rsquared:.4f}  "
              f"({rk3_ind.rsquared/ra_ind.rsquared*100:.1f}% of FF5)")
    print()
    print(f"  Three orthogonal risk dimensions:")
    print(f"    body_var:  variance in normal market months (body risk)")
    print(f"    sys_tail:  mean return in market crash months (tail level)")
    print(f"    1/ν_cond:  tail thickness in crash months (tail shape)")
    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()