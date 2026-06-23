"""
Factor Mediation Test
======================
Tests whether FF5 factors predict future returns *through* the future
return distribution (systematic variance + tail risk), or whether they
retain independent predictive power beyond the distribution channel.

Causal chain under test:
  Factor loading (t) → Future distribution (t→t+k) → Future return (t→t+k)

If this chain holds:
  - Factors should predict future distribution (Stage 1)
  - Future distribution should predict future return (Stage 2)
  - Factor's direct effect on return should shrink when distribution
    is controlled for (Stage 3 mediation)

Test assets: 49 industry portfolios
  - Factor loadings vary meaningfully over time across industries
  - Large enough for stable distribution estimation
  - Not sorted on factor characteristics (unbiased)

Rolling structure:
  - Factor loading: estimated from preceding 5-year window
  - Forward window: 3 years and 5 years (compared for robustness)
  - Step: 1 year (partially overlapping windows)
  - Regression: pooled cross-section × time (panel), industry FE optional

Usage:
    pip install pandas numpy scipy statsmodels requests matplotlib
    python mediation_test.py
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
from scipy import stats, optimize
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
    rows = _parse_monthly(_get_zip('49_Industry_Portfolios'), 50)
    industries = _make_df(rows, ['Date'] + [f'Ind{i+1}' for i in range(49)])
    print("  ✓ 49 industry portfolios")

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

    return factors, mom, industries, deciles


# ══════════════════════════════════════════════════════════════════════════════
# 2.  ROLLING WINDOW COMPUTATION
# ══════════════════════════════════════════════════════════════════════════════

def estimate_factor_loadings(r_exc, factors_window):
    """
    Estimate FF5 + MOM loadings from a backward-looking window.
    Returns dict of loadings or None if insufficient data.
    """
    mkt = factors_window['Mkt-RF'] / 100
    smb = factors_window['SMB'] / 100
    hml = factors_window['HML'] / 100
    rmw = factors_window['RMW'] / 100
    cma = factors_window['CMA'] / 100
    mom_s = factors_window['MOM'] / 100 \
            if 'MOM' in factors_window.columns \
            else pd.Series(0.0, index=factors_window.index)

    idx = r_exc.index.intersection(factors_window.index)
    if len(idx) < 24:
        return None

    r  = r_exc.loc[idx]
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': mkt.loc[idx], 'SMB': smb.loc[idx],
        'HML': hml.loc[idx],    'RMW': rmw.loc[idx],
        'CMA': cma.loc[idx],    'MOM': mom_s.loc[idx]
    }))
    reg = sm.OLS(r, Xf).fit()
    return {f'load_{k}': reg.params[k]
            for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']}


def fit_student_t_simple(returns, min_obs=15):
    """Fit Student-t by MLE, return (nu, sigma) or (nan, nan)."""
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < min_obs:
        return np.nan, np.nan
    try:
        df, loc, scale = stats.t.fit(r, floc=0)
        df = float(np.clip(df, 1.5, 200))
        return df, float(abs(scale))
    except Exception:
        return np.nan, np.nan


def _hansen_st_logpdf(x, nu, lam):
    """Hansen (1994) skewed-t log-density."""
    from scipy.special import gamma as _gamma
    c = _gamma((nu+1)/2) / (np.sqrt(np.pi*(nu-2)) * _gamma(nu/2))
    a = 4*lam*c*(nu-2)/(nu-1)
    b2 = 1 + 3*lam**2 - a**2
    if b2 <= 0 or not np.isfinite(b2):
        return np.full(len(x), -1e10)
    b = np.sqrt(b2)
    thr = -a/b
    lp  = np.zeros(len(x))
    left = x < thr
    if left.any():
        zl = (b*x[left]+a)/(1-lam)
        lp[left] = np.log(b)+np.log(c)-(nu+1)/2*np.log(1+zl**2/(nu-2))
    if (~left).any():
        zr = (b*x[~left]+a)/(1+lam)
        lp[~left] = np.log(b)+np.log(c)-(nu+1)/2*np.log(1+zr**2/(nu-2))
    return lp


def fit_skewed_t(returns, min_obs=20, nu_cap=50):
    """
    Fit Hansen (1994) skewed-t by MLE.
    Returns (sigma, nu, lambda):
      sigma:  scale — proxy for systematic variance
      nu:     degrees of freedom — tail thickness (lower = fatter)
      lambda: skewness in (-1,1) — negative = left-skewed
    Returns (nan, nan, nan) on failure.
    """
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < min_obs:
        return np.nan, np.nan, np.nan
    mu    = float(np.mean(r))
    sigma = float(np.std(r))
    if sigma < 1e-10:
        return np.nan, np.nan, np.nan
    r_s   = (r - mu) / sigma
    sk    = float(stats.skew(r_s))
    lam0  = float(np.clip(sk * 0.1, -0.5, 0.5))

    def neg_ll(params):
        nu  = 2.01 + np.exp(params[0])
        lam = np.tanh(params[1])
        lp  = _hansen_st_logpdf(r_s, nu, lam)
        return -float(np.sum(lp)) if np.all(np.isfinite(lp)) else 1e10

    best_val, best_res = np.inf, None
    for nu0, l0 in [(4,lam0),(5,0),(8,lam0),(3,-0.1)]:
        x0 = [np.log(max(nu0-2, 0.01)),
               np.arctanh(np.clip(l0, -0.9, 0.9))]
        try:
            res = optimize.minimize(neg_ll, x0, method='Nelder-Mead',
                                    options={'maxiter':3000,'xatol':1e-6})
            if res.fun < best_val:
                best_val, best_res = res.fun, res
        except Exception:
            continue

    if best_res is None:
        return np.nan, np.nan, np.nan
    nu_fit  = float(np.clip(2.01+np.exp(best_res.x[0]), 2.01, nu_cap))
    lam_fit = float(np.clip(np.tanh(best_res.x[1]), -0.99, 0.99))
    return float(sigma), nu_fit, lam_fit


def skewed_t_moments(sigma, nu, lam):
    """
    Compute economically interpretable moments from skewed-t parameters.
    Returns (variance, skewness, excess_kurtosis).

    These are orthogonal by construction:
      variance:        σ² (approximately) — scale of distribution
      skewness:        determined primarily by λ — left/right asymmetry
      excess_kurtosis: determined primarily by ν — fat vs thin tails

    Theory pricing predictions:
      variance:   + (higher variance = more risk = higher return)
      skewness:   − (more negative skew = worse downside = higher return)
                    [or equivalently, neg_skewness has + coefficient]
      ex_kurtosis:+ (fatter tails = more extreme outcomes = higher return)
    """
    if any(np.isnan(x) for x in [sigma, nu, lam]) or nu <= 2:
        return np.nan, np.nan, np.nan

    from scipy.special import gamma as _gamma
    c  = _gamma((nu+1)/2) / (np.sqrt(np.pi*(nu-2)) * _gamma(nu/2))
    a  = 4*lam*c*(nu-2)/(nu-1)
    b2 = 1 + 3*lam**2 - a**2
    if b2 <= 0:
        return np.nan, np.nan, np.nan
    b = np.sqrt(b2)

    # Numerical integration over standardised variable
    z  = np.linspace(-15, 15, 3000)
    dz = z[1] - z[0]
    thr = -a/b
    left  = z < thr
    right = ~left
    pdf   = np.zeros(len(z))

    if left.any():
        t_l = (b*z[left] + a) / (1-lam)
        pdf[left] = b * c * (1 + t_l**2/(nu-2))**(-(nu+1)/2)
    if right.any():
        t_r = (b*z[right] + a) / (1+lam)
        pdf[right] = b * c * (1 + t_r**2/(nu-2))**(-(nu+1)/2)

    total = np.sum(pdf) * dz
    if total <= 0:
        return np.nan, np.nan, np.nan
    pdf = pdf / total

    mu_z    = np.sum(z * pdf) * dz
    var_z   = np.sum((z - mu_z)**2 * pdf) * dz
    if var_z <= 0:
        return np.nan, np.nan, np.nan
    skew_z  = np.sum((z - mu_z)**3 * pdf) * dz / var_z**1.5
    kurt_z  = np.sum((z - mu_z)**4 * pdf) * dz / var_z**2 - 3

    actual_var = float(sigma**2 * var_z)
    return actual_var, float(skew_z), float(kurt_z)


def estimate_forward_distribution(r_exc, factors_fwd, tail_q=0.20):
    """
    Full distribution characterisation using regime-conditional betas.

    Core insight: the correct measure of nonlinear market sensitivity is
    how beta changes across market regimes, not the residual after
    removing average beta. Regime-conditional betas are:
      - Fully systematic (covariance with market, just in a subperiod)
      - Not tautologically correlated with mean return
      - Directly capture nonlinearity of the pricing curve

    Five measures:
      sys_var           β²·σ²_market (average systematic variance)
      sys_tail          E[R | market worst q%] (raw crash level — for comparison)
      tail_beta_excess  β_tail - β_avg  (extra crash sensitivity)
      boom_beta_excess  β_boom - β_avg  (extra boom sensitivity)
      beta_asym         β_tail - β_boom (pure asymmetry, signed)
      beta_extreme      (|β_tail - β_avg| + |β_boom - β_avg|) / 2
                        (unsigned total nonlinearity)

    Theory predictions:
      sys_var:          + (systematic variance costly)
      sys_tail:         + (worse crash performance = higher return)
      tail_beta_excess: + (higher crash beta than average = costly)
      boom_beta_excess: ? (higher boom beta = beneficial or risky?)
      beta_asym:        + (crashes amplify more than booms = costly)
      beta_extreme:     + (large beta deviation in either direction)
    """
    mkt = factors_fwd['Mkt-RF'] / 100
    rf  = factors_fwd['RF']     / 100

    idx = r_exc.index.intersection(factors_fwd.index)
    if len(idx) < 18:
        return None

    r      = r_exc.loc[idx]
    rm_exc = mkt.loc[idx]
    rf_    = rf.loc[idx]
    r_exc_ = r - rf_

    if rm_exc.var() < 1e-12:
        return None

    # ── Average (full-window) beta ────────────────────────────────────────────
    beta_avg = float(np.cov(r_exc_, rm_exc)[0,1] / rm_exc.var())
    sys_var  = float(beta_avg**2 * rm_exc.var())

    # ── Regime thresholds ─────────────────────────────────────────────────────
    low_thresh  = float(np.percentile(rm_exc.dropna(), tail_q * 100))
    high_thresh = float(np.percentile(rm_exc.dropna(), (1-tail_q) * 100))
    tail_mask = rm_exc <= low_thresh
    boom_mask = rm_exc >= high_thresh
    body_mask = (~tail_mask) & (~boom_mask)

    # ── Regime-conditional betas ──────────────────────────────────────────────
    def regime_beta(mask, fallback=beta_avg):
        r_   = r_exc_[mask]
        rm_  = rm_exc[mask]
        if len(r_) < 4 or rm_.var() < 1e-12:
            return fallback
        return float(np.cov(r_, rm_)[0,1] / rm_.var())

    beta_tail = regime_beta(tail_mask)
    beta_boom = regime_beta(boom_mask)
    beta_body = regime_beta(body_mask)

    # ── Beta excess measures ──────────────────────────────────────────────────
    tail_beta_excess = float(beta_tail - beta_avg)
    boom_beta_excess = float(beta_boom - beta_avg)

    # Asymmetry: positive = crashes amplify more than booms (costly under loss aversion)
    beta_asym    = float(beta_tail - beta_boom)

    # Extremeness: how much does beta deviate from average in either direction
    beta_extreme = float((abs(tail_beta_excess) + abs(boom_beta_excess)) / 2)

    # ── Raw level measures (for comparison, some tautological) ───────────────
    r_tail = r_exc_[tail_mask]
    r_boom = r_exc_[boom_mask]
    r_body = r_exc_[body_mask]

    sys_tail = float(r_tail.mean()) if tail_mask.sum() >= 3 else np.nan
    sys_boom = float(r_boom.mean()) if boom_mask.sum() >= 3 else np.nan

    # Body variance (of full returns, not residuals)
    body_var = float(r_body.var()) if body_mask.sum() > 5 else np.nan

    # ── Student-t tail shape in crash months ─────────────────────────────────
    nu_low, _ = fit_student_t_simple(r_tail.values, min_obs=4)                 if tail_mask.sum() >= 4 else (np.nan, np.nan)
    inv_nu_low = 1.0/nu_low if not np.isnan(nu_low) else np.nan

    # ── Full-window ───────────────────────────────────────────────────────────
    mean_excess = float(r_exc_.mean() * 12)
    idio_var    = float(max(r_exc_.var() - sys_var, 0))

    # ── Skewed-t fit to full forward window ───────────────────────────────────
    # Fits Hansen (1994) skewed-t to portfolio excess returns
    # At portfolio level idiosyncratic variance is small so distribution
    # is predominantly systematic
    st_sigma, st_nu, st_lam = fit_skewed_t(r_exc_.values, min_obs=20)
    st_inv_nu  = 1.0/st_nu if not np.isnan(st_nu)  else np.nan
    st_neg_lam = -st_lam   if not np.isnan(st_lam)  else np.nan

    # ── Implied moments from skewed-t fit ─────────────────────────────────────
    # These are economically interpretable and less correlated than raw params:
    #   st_var:      actual variance (σ² adjusted for ν and λ)
    #   st_skew:     standardised skewness (negative = left-skewed = risky)
    #   st_exkurt:   excess kurtosis (positive = fat tails = risky)
    # We use neg_skew so that positive coefficient = theory-consistent
    st_var, st_skew, st_exkurt = skewed_t_moments(st_sigma, st_nu, st_lam)
    st_neg_skew = -st_skew if not np.isnan(st_skew) else np.nan

    return {
        'fwd_beta':               beta_avg,
        'fwd_mean_excess':        mean_excess,
        'fwd_n_obs':              len(idx),
        # ── Core systematic measures ──────────────────────────────────────────
        'fwd_sys_var':            sys_var,
        'fwd_sys_tail':           sys_tail,
        # ── Regime-conditional betas ──────────────────────────────────────────
        'fwd_beta_tail':          beta_tail,
        'fwd_beta_boom':          beta_boom,
        'fwd_beta_body':          beta_body,
        'fwd_tail_beta_excess':   tail_beta_excess,
        'fwd_boom_beta_excess':   boom_beta_excess,
        'fwd_beta_asym':          beta_asym,
        'fwd_beta_extreme':       beta_extreme,
        # ── Body variance ─────────────────────────────────────────────────────
        'fwd_body_var':           body_var,
        # ── Tail shape ────────────────────────────────────────────────────────
        'fwd_inv_nu_low':         inv_nu_low,
        # ── Skewed-t parameters (raw MLE) ─────────────────────────────────────
        'fwd_st_sigma':           st_sigma,
        'fwd_st_nu':              st_nu,
        'fwd_st_inv_nu':          st_inv_nu,
        'fwd_st_lam':             st_lam,
        'fwd_st_neg_lam':         st_neg_lam,
        # ── Implied moments (economically orthogonal) ─────────────────────────
        'fwd_st_var':             st_var,      # actual variance
        'fwd_st_skew':            st_skew,     # skewness (neg = left-skewed)
        'fwd_st_neg_skew':        st_neg_skew, # -skew (pos = left-skewed = risky)
        'fwd_st_exkurt':          st_exkurt,   # excess kurtosis (pos = fat tails)
        # ── Comparison ────────────────────────────────────────────────────────
        'fwd_sys_boom':           sys_boom,
        'fwd_idio_var':           idio_var,
        'fwd_tail_excess':        float(sys_tail - beta_avg * rm_exc[tail_mask].mean())
                                  if tail_mask.sum() >= 3 and not np.isnan(sys_tail)
                                  else np.nan,
    }


def build_panel(all_factors, portfolios, label='industry',
                lookback_years=5,
                forward_years_list=(3, 5),
                step_years=None,   # None = non-overlapping (step = fwd window)
                tail_q=0.10):
    """
    Build a panel dataset: one row per (portfolio, time point).
    portfolios: dict of {name: DataFrame} for deciles, or single DataFrame for industries
    label: 'industry' or 'decile'
    """
    # Normalise input: always work with a flat dict of series
    port_series = {}
    if isinstance(portfolios, pd.DataFrame):
        for col in portfolios.columns:
            port_series[col] = portfolios[col]
    else:
        # dict of DataFrames (decile case)
        for fname, ddf in portfolios.items():
            for col in ddf.columns:
                port_series[f'{fname}_{col}'] = ddf[col]

    # Non-overlapping mode: step = forward window length
    # so each observation uses a completely fresh return period
    if step_years is None:
        step_years = max(forward_years_list)
        print(f"\nBuilding NON-OVERLAPPING panel [{label}] "
              f"(lookback={lookback_years}y, "
              f"forward={forward_years_list}, "
              f"n_portfolios={len(port_series)})...")
    else:
        print(f"\nBuilding rolling panel [{label}] "
              f"(lookback={lookback_years}y, "
              f"forward={forward_years_list}, step={step_years}y, "
              f"n_portfolios={len(port_series)})...")

    panels = {fwd: [] for fwd in forward_years_list}

    start = all_factors.index.min() + pd.DateOffset(years=lookback_years)
    end   = all_factors.index.max() - pd.DateOffset(years=max(forward_years_list))

    t = start
    while t <= end:
        lookback_start = t - pd.DateOffset(years=lookback_years)
        f_back = all_factors.loc[lookback_start:t]

        for port_name, s_raw in port_series.items():
            s  = s_raw.dropna() / 100
            rf = all_factors['RF'] / 100

            r_back_idx = s.index.intersection(f_back.index)
            if len(r_back_idx) < 24:
                continue
            r_back = s.loc[r_back_idx] - rf.loc[r_back_idx]

            loadings = estimate_factor_loadings(r_back, f_back.loc[r_back_idx])
            if loadings is None:
                continue

            # Factor characteristic: which decile bin (1-10) for decile panels
            decile_rank = np.nan
            if label == 'decile':
                parts = port_name.split('_')
                if parts[-1].startswith('D'):
                    try:
                        decile_rank = int(parts[-1][1:])
                    except:
                        pass
                factor_group = '_'.join(parts[:-1])
            else:
                factor_group = 'industry'

            for fwd_years in forward_years_list:
                fwd_end = t + pd.DateOffset(years=fwd_years)
                f_fwd   = all_factors.loc[t:fwd_end]

                r_fwd_idx = s.index.intersection(f_fwd.index)
                if len(r_fwd_idx) < 12:
                    continue

                dist = estimate_forward_distribution(
                    s.loc[r_fwd_idx], f_fwd.loc[r_fwd_idx], tail_q=tail_q)
                if dist is None:
                    continue

                row = {
                    'date':         t,
                    'portfolio':    port_name,
                    'factor_group': factor_group,
                    'decile_rank':  decile_rank,
                    'fwd_years':    fwd_years,
                    'label':        label,
                    **loadings,
                    **dist,
                }
                panels[fwd_years].append(row)

        t += pd.DateOffset(years=step_years)

    result = {}
    for fwd in forward_years_list:
        df = pd.DataFrame(panels[fwd])
        result[fwd] = df
        n_ports = df['portfolio'].nunique() if len(df) > 0 else 0
        n_times = df['date'].nunique()      if len(df) > 0 else 0
        print(f"  {fwd}-year forward: {len(df)} observations "
              f"({n_ports} portfolios × {n_times} time points)")

    return result


# ══════════════════════════════════════════════════════════════════════════════
# 3.  MEDIATION ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

FACTOR_VARS = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']
# Distribution measures
DIST_VARS    = ['fwd_sys_var','fwd_sys_tail']       # 2D baseline
BETA_VARS    = ['fwd_tail_beta_excess',               # β_tail - β_avg
                'fwd_boom_beta_excess',               # β_boom - β_avg
                'fwd_beta_asym',                      # β_tail - β_boom
                'fwd_beta_extreme']                   # (|Δβ_tail|+|Δβ_boom|)/2
SKEWT_VARS   = ['fwd_st_sigma',                      # skewed-t scale
                'fwd_st_inv_nu',                     # 1/nu (tail thickness)
                'fwd_st_neg_lam']                    # -lambda (left skew)
ALL_DIST_VARS = DIST_VARS + BETA_VARS + SKEWT_VARS

def run_mediation(panel_df, fwd_years, factor='load_HML', dist_var='fwd_sys_tail'):
    """
    Run the three-stage mediation analysis for a single factor and
    distribution measure.

    Stage 1: factor → future distribution
    Stage 2: future distribution → future return
    Stage 3: factor + future distribution → future return (mediation)

    Also runs the full model with all factors and both distribution measures.
    """
    req = [factor, dist_var, 'fwd_mean_excess',
           'fwd_sys_var', 'fwd_sys_tail']
    sub = panel_df.dropna(subset=req)
    n   = len(sub)

    if n < 30:
        print(f"  Insufficient data for {factor} ({n} obs)")
        return None

    print(f"\n── Mediation: {factor} → {dist_var} → return "
          f"(N={n}, {fwd_years}y forward) ───────")

    y_dist   = sub[dist_var]
    y_return = sub['fwd_mean_excess']
    X_factor = sm.add_constant(sub[[factor]])
    X_dist   = sm.add_constant(sub[[dist_var]])
    X_both   = sm.add_constant(sub[[factor, dist_var]])
    dg       = sub['date'].astype(str)  # date clusters

    def mc(y_, X_):
        return sm.OLS(y_, X_).fit(cov_type='cluster',
                                   cov_kwds={'groups': dg})

    # Stage 1: factor → distribution
    r1 = mc(y_dist, X_factor)
    t1 = r1.tvalues.get(factor, np.nan)
    c1 = r1.params.get(factor, np.nan)

    # Stage 2: distribution → return
    r2 = mc(y_return, X_dist)
    t2 = r2.tvalues.get(dist_var, np.nan)
    c2 = r2.params.get(dist_var, np.nan)

    # Stage 3: factor + distribution → return (mediation)
    r3 = mc(y_return, X_both)
    t3_factor = r3.tvalues.get(factor, np.nan)
    t3_dist   = r3.tvalues.get(dist_var, np.nan)
    c3_factor = r3.params.get(factor, np.nan)
    c3_dist   = r3.params.get(dist_var, np.nan)

    # Direct effect (Stage 3 factor coef) vs total effect (naive factor → return)
    r_total = mc(y_return, X_factor)
    c_total = r_total.params.get(factor, np.nan)
    t_total = r_total.tvalues.get(factor, np.nan)

    # Mediation fraction: how much of the total effect goes through distribution?
    if abs(c_total) > 1e-10:
        indirect_effect = c_total - c3_factor
        mediation_pct   = float(indirect_effect / c_total * 100)
    else:
        mediation_pct = np.nan

    sig = lambda t: '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')

    print(f"  Stage 1 ({factor} → {dist_var}):")
    print(f"    coef={c1:+.4f}  t={t1:+.2f}{sig(t1)}  "
          f"R²={r1.rsquared:.3f}")

    print(f"  Stage 2 ({dist_var} → return):")
    print(f"    coef={c2:+.4f}  t={t2:+.2f}{sig(t2)}  "
          f"R²={r2.rsquared:.3f}")

    print(f"  Total effect ({factor} → return, no mediation):")
    print(f"    coef={c_total:+.4f}  t={t_total:+.2f}{sig(t_total)}  "
          f"R²={r_total.rsquared:.3f}")

    print(f"  Stage 3 (mediation — factor + dist → return):")
    print(f"    {factor:<14} coef={c3_factor:+.4f}  t={t3_factor:+.2f}{sig(t3_factor)}")
    print(f"    {dist_var:<14} coef={c3_dist:+.4f}  t={t3_dist:+.2f}{sig(t3_dist)}")
    print(f"    R²={r3.rsquared:.3f}")

    if not np.isnan(mediation_pct):
        print(f"  Mediation: {mediation_pct:.1f}% of factor effect goes through distribution")
        if mediation_pct > 50:
            print(f"  → MEDIATION CONFIRMED: distribution mediates majority of factor effect")
        elif mediation_pct > 20:
            print(f"  → PARTIAL MEDIATION: distribution explains part of factor effect")
        else:
            print(f"  → LITTLE MEDIATION: factor effect mostly direct, not through distribution")

    return {
        'factor':         factor,
        'dist_var':       dist_var,
        'fwd_years':      fwd_years,
        'n':              n,
        'stage1_coef':    c1,
        'stage1_t':       t1,
        'stage1_r2':      r1.rsquared,
        'stage2_coef':    c2,
        'stage2_t':       t2,
        'stage2_r2':      r2.rsquared,
        'total_coef':     c_total,
        'total_t':        t_total,
        'total_r2':       r_total.rsquared,
        'direct_coef':    c3_factor,
        'direct_t':       t3_factor,
        'mediation_pct':  mediation_pct,
        'stage3_r2':      r3.rsquared,
    }


def run_full_mediation(panel_df, fwd_years):
    """
    Full panel mediation with all factors and both distribution measures.
    Tests whether the full factor set's predictive power is mediated
    by systematic variance + tail risk jointly.
    """
    req = FACTOR_VARS + DIST_VARS + ['fwd_mean_excess']
    sub = panel_df.dropna(subset=req)
    y   = sub['fwd_mean_excess']
    n   = len(sub)

    print(f"\n{'='*65}")
    print(f"Full Mediation Test: All Factors ({fwd_years}-year forward, N={n})")
    print(f"{'='*65}")

    # Non-overlapping windows: observations are independent
    # Use standard OLS — no clustering needed
    # (clustering still applied to higher moments section for safety)
    def ols(y_, X_):
        return sm.OLS(y_, X_).fit()

    # Model A: factors only (total effect)
    ra = ols(y, sm.add_constant(sub[FACTOR_VARS]))

    # Model B: distribution only
    rb = ols(y, sm.add_constant(sub[DIST_VARS]))

    # Model C: factors + distribution (direct effect after mediation)
    rc = ols(y, sm.add_constant(sub[FACTOR_VARS + DIST_VARS]))

    # Model D: two-dimensional risk (sys_var + sys_tail) — core test
    rd = ols(y, sm.add_constant(sub[['fwd_sys_var','fwd_sys_tail']]))

    print(f"\n── R² Comparison ────────────────────────────────────────────────")
    print(f"  {'Model':<44} {'R²':>7}  {'% of A':>8}")
    print("  " + "-"*60)
    for name, reg in [
        ('A  Factors only (total effect)',       ra),
        ('B  Distribution only (sys_var+tail)',  rb),
        ('C  Factors + distribution (direct)',   rc),
        ('D  sys_var + sys_tail (2D risk)',       rd),
    ]:
        pct = reg.rsquared / ra.rsquared * 100 if ra.rsquared > 0 else 0
        print(f"  {name:<44} {reg.rsquared:>7.4f}  {pct:>7.1f}%")

    print(f"\n── Factor Coefficient Shrinkage A → C ───────────────────────────")
    print(f"  {'Factor':<14} {'Total (A)':>10} {'Direct (C)':>11} "
          f"{'Mediation %':>12}  {'A t':>6}  {'C t':>6}")
    print("  " + "-"*62)
    for v in FACTOR_VARS:
        ca = ra.params.get(v, np.nan)
        cc = rc.params.get(v, np.nan)
        ta = ra.tvalues.get(v, np.nan)
        tc = rc.tvalues.get(v, np.nan)
        if abs(ca) > 1e-10:
            med_pct = (ca - cc) / ca * 100
        else:
            med_pct = np.nan
        sa = '*' if abs(ta)>2 else ' '
        sc = '*' if abs(tc)>2 else ' '
        print(f"  {v:<14} {ca:>+10.4f} {cc:>+11.4f} "
              f"{med_pct:>11.1f}%  {ta:>+5.2f}{sa}  {tc:>+5.2f}{sc}")

    print(f"\n── Distribution Coefficients in Model C ─────────────────────────")
    for v in DIST_VARS:
        c = rc.params.get(v, np.nan)
        t = rc.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<20} coef={c:+.6f}  t={t:+.2f}  {sig}")

    print(f"\n── Two-Dimensional Risk Rescue Test (Model D) ───────────────────")
    for v in ['fwd_sys_var','fwd_sys_tail']:
        c = rd.params.get(v, np.nan)
        t = rd.tvalues.get(v, np.nan)
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        print(f"  {v:<20} coef={c:+.6f}  t={t:+.2f}  {sig}")

    from scipy.stats import f as f_dist
    from sklearn.preprocessing import StandardScaler

    def ft(r2_r, r2_f, n_, k_f, k_r):
        if k_f <= k_r or r2_f <= r2_r: return np.nan, np.nan
        fs = ((r2_f-r2_r)/(k_f-k_r)) / ((1-r2_f)/(n_-k_f))
        return fs, 1 - f_dist.cdf(fs, k_f-k_r, n_-k_f)

    # ── 5D full distribution analysis ────────────────────────────────────────
    # Skewed-t parameters — clean parametric characterisation
    # These three fully describe the distribution shape beyond the mean
    # sigma: scale (body width)
    # 1/nu:  tail thickness (fat vs thin tails)
    # -lam:  skewness (left vs right asymmetry)
    # Implied moments — economically interpretable, less correlated
    # than raw MLE parameters (sigma, nu, lam)
    SKT_D  = ['fwd_st_var',      # actual variance
              'fwd_st_neg_skew', # -skewness (positive = left-skewed = risky)
              'fwd_st_exkurt']   # excess kurtosis (fat tails = risky)
    FIVE_D = SKT_D
    TWO_D  = ['fwd_sys_var','fwd_sys_tail']

    # Theory predictions:
    #  variance:    + (higher variance = more systematic risk = higher return)
    #  neg_skew:    + (more left-skewed = worse downside = higher return)
    #  exkurt:      + (fatter tails = more extreme outcomes = higher return)
    # If all three are priced, the aggregate utility function has nonzero
    # derivatives through at least the 4th order (variance, skewness, kurtosis)

    req_5d = FACTOR_VARS + FIVE_D + TWO_D + ['fwd_mean_excess']

    # Diagnose NaN counts before dropna
    print(f"\n  NaN counts in 5D variables (N={len(panel_df)}):")
    for col in FIVE_D + TWO_D:
        if col in panel_df.columns:
            n_nan = panel_df[col].isna().sum()
            print(f"    {col}: {n_nan} NaN ({n_nan/len(panel_df)*100:.1f}%)")
        else:
            print(f"    {col}: MISSING from panel")

    sub_5d = panel_df.dropna(subset=req_5d)
    print(f"  Rows after dropna: {len(sub_5d)}")

    # If skewed-t columns are all NaN, fall back to beta-only 5D
    if len(sub_5d) < 20:
        print(f"  WARNING: too few rows, falling back to beta-only model")
        FIVE_D = BETA_D + TWO_D
        req_5d = FACTOR_VARS + FIVE_D + ['fwd_mean_excess']
        sub_5d = panel_df.dropna(subset=req_5d)
        print(f"  Rows after fallback dropna: {len(sub_5d)}")

    y_5d   = sub_5d['fwd_mean_excess']
    n_5d   = len(sub_5d)
    dg_5d  = sub_5d['date'].astype(str)

    def clust_5d(y_, X_):
        return sm.OLS(y_, X_).fit(cov_type='cluster',
                                   cov_kwds={'groups': dg_5d.loc[y_.index]})

    r_fac  = clust_5d(y_5d, sm.add_constant(sub_5d[FACTOR_VARS]))
    r_2d   = clust_5d(y_5d, sm.add_constant(sub_5d[TWO_D]))
    r_5d   = clust_5d(y_5d, sm.add_constant(sub_5d[FIVE_D]))
    r_full = clust_5d(y_5d, sm.add_constant(sub_5d[FACTOR_VARS + FIVE_D]))

    # Report skewed-t cross-sectional variation
    for col, name in [('fwd_st_var','var'),('fwd_st_neg_skew','-skew'),
                      ('fwd_st_exkurt','exkurt')]:
        if col in sub_5d.columns:
            v = sub_5d[col].dropna()
            print(f"  Skewed-t {name}: mean={v.mean():+.4f}  "
                  f"std={v.std():.4f}  "
                  f"(cross-sect. std={v.std():.4f} — "
                  f"{'informative' if v.std()>0.005 else 'low variation'})")

    print(f"\n── Skewed-t Moment Analysis (N={n_5d}, clustered by date) ─────")
    print(f"  Three implied moments of fitted Hansen skewed-t distribution:")
    print(f"  variance (2nd moment), neg_skew (3rd), excess_kurtosis (4th)")
    print(f"\n  {'Model':<44} {'R²':>7}  {'% of factors':>13}")
    print("  " + "-"*66)
    for mname, mreg in [
        ('Factors only',                          r_fac),
        ('sys_var + sys_tail (baseline)',          r_2d),
        ('Skewed-t moments (var+skew+kurt)',       r_5d),
        ('Factors + skewed-t moments',             r_full),
    ]:
        pct = mreg.rsquared / r_fac.rsquared * 100 if r_fac.rsquared > 0 else 0
        print(f"  {mname:<44} {mreg.rsquared:>7.4f}  {pct:>12.1f}%")

    # Standardised coefficients
    scaler = StandardScaler()
    sub_std5 = sub_5d.copy()
    sub_std5[FIVE_D] = scaler.fit_transform(sub_5d[FIVE_D])
    stds5 = sub_5d[FIVE_D].std()

    r_5d_std = clust_5d(y_5d, sm.add_constant(sub_std5[FIVE_D]))

    theory = {
        'fwd_st_var':      '+',   # variance costly
        'fwd_st_neg_skew': '+',   # left skew costly (neg_skew positive = left)
        'fwd_st_exkurt':   '+',   # excess kurtosis costly (fat tails)
    }

    print(f"\n── Standardised Coefficients (5D model, clustered) ──────────────")
    print(f"  + = costly → higher return    ? = ambiguous prediction")
    print(f"  {'Variable':<20} {'1-SD':>10} {'Std coef':>10} "
          f"{'t-clust':>9}  Theory  Sig?")
    print("  " + "-"*68)
    for v in FIVE_D:
        c  = r_5d_std.params.get(v, np.nan)
        t  = r_5d_std.tvalues.get(v, np.nan)
        sd = stds5.get(v, np.nan)
        th = theory.get(v, '?')
        sig = '***' if abs(t)>3 else ('*' if abs(t)>2 else '  ')
        sign = '+' if c > 0 else '−'
        match = '✓' if (th == '?' or sign == th) else '✗'
        print(f"  {v:<20} {sd:>+10.5f} {c*100:>+9.3f}%  "
              f"{t:>+9.2f}  {th}  {match}  {sig}")

    # ── Pairwise F-tests: is each of the 5 dimensions necessary? ─────────────
    print(f"\n── Pairwise F-tests: Is Each Moment Independently Priced? ──────")
    print(f"  (Does each moment add over the other two jointly?)")
    print(f"  {'Test':<48} {'F':>7}  {'p':>7}  Result")
    print("  " + "-"*70)
    all_necessary = True
    for v in FIVE_D:
        others = [x for x in FIVE_D if x != v]
        r_restricted = clust_5d(y_5d, sm.add_constant(sub_5d[others]))
        fs, p = ft(r_restricted.rsquared, r_5d.rsquared,
                   n_5d, len(FIVE_D)+1, len(others)+1)
        if np.isnan(fs):
            print(f"  {v:<48} (F is NaN)")
            continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no — REDUNDANT')
        print(f"  {v:<48} {fs:>7.2f}  {p:>7.4f}  {sig}")
        if p >= 0.05:
            all_necessary = False
    if all_necessary:
        print(f"\n  → ALL FIVE dimensions independently priced")
    else:
        print(f"\n  → Some dimensions are redundant given the others")

    # ── Additional F-tests ────────────────────────────────────────────────────
    print(f"\n── Key F-tests ──────────────────────────────────────────────────")
    key_tests = [
        ('Skewed-t moments add over baseline (var+tail)',
         r_2d, r_5d, 2, 3),
        ('Skewed-t moments add over factors',
         r_fac, r_full, len(FACTOR_VARS), len(FACTOR_VARS)+3),
        ('Factors add over skewed-t moments',
         r_5d, r_full, 3, len(FACTOR_VARS)+3),
    ]
    for desc, r_r, r_f, k_r, k_f in key_tests:
        fs, p = ft(r_r.rsquared, r_f.rsquared, n_5d, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    # F-tests on original 2D model for backwards compatibility
    print(f"\n── Original 2D Rescue Test (for comparison) ─────────────────────")
    base_tests = [
        ('Distribution adds over factors',
         ra, rc, len(FACTOR_VARS), len(FACTOR_VARS)+2),
        ('Factors add over distribution',
         rb, rc, 2, len(FACTOR_VARS)+2),
        ('sys_tail adds over sys_var (2D rescue)',
         sm.OLS(y, sm.add_constant(sub[['fwd_sys_var']])).fit(),
         rd, 1, 2),
        ('sys_var adds over sys_tail (2D rescue)',
         sm.OLS(y, sm.add_constant(sub[['fwd_sys_tail']])).fit(),
         rd, 1, 2),
    ]
    for desc, r_r, r_f, k_r, k_f in base_tests:
        fs, p = ft(r_r.rsquared, r_f.rsquared, n, k_f+1, k_r+1)
        if np.isnan(fs): continue
        sig = 'YES ***' if p<0.01 else ('yes *' if p<0.05 else 'no    ')
        print(f"  {desc:<46} F={fs:6.2f}  p={p:.4f}  {sig}")

    return ra, rb, rc, rd, sub


# ══════════════════════════════════════════════════════════════════════════════
# 4.  ROBUSTNESS: COMPARE 3Y vs 5Y FORWARD WINDOWS
# ══════════════════════════════════════════════════════════════════════════════

def compare_windows(panels, factors_to_test=None):
    if factors_to_test is None:
        factors_to_test = ['load_HML','load_SMB','load_RMW',
                           'load_CMA','load_MOM']

    print(f"\n{'='*65}")
    print("Window Comparison: 3-year vs 5-year forward")
    print(f"{'='*65}")
    print(f"\n  {'Factor':<14} {'3y Stage1 t':>12} {'3y Mediation%':>14} "
          f"{'5y Stage1 t':>12} {'5y Mediation%':>14}")
    print("  " + "-"*68)

    for factor in factors_to_test:
        row_vals = []
        for fwd_years in [3, 5]:
            df = panels.get(fwd_years)
            if df is None or len(df) < 30:
                row_vals.extend([np.nan, np.nan])
                continue
            req = [factor,'fwd_sys_tail','fwd_mean_excess']
            sub = df.dropna(subset=req)
            if len(sub) < 20:
                row_vals.extend([np.nan, np.nan])
                continue

            y_dist   = sub['fwd_sys_tail']
            y_return = sub['fwd_mean_excess']
            Xf       = sm.add_constant(sub[[factor]])
            Xb       = sm.add_constant(sub[['fwd_sys_tail']])
            Xboth    = sm.add_constant(sub[[factor,'fwd_sys_tail']])

            r1     = sm.OLS(y_dist, Xf).fit()
            r_tot  = sm.OLS(y_return, Xf).fit()
            r3     = sm.OLS(y_return, Xboth).fit()

            t1 = r1.tvalues.get(factor, np.nan)
            c_tot  = r_tot.params.get(factor, np.nan)
            c_dir  = r3.params.get(factor, np.nan)
            med_pct = (c_tot - c_dir)/c_tot*100 if abs(c_tot)>1e-10 else np.nan
            row_vals.extend([t1, med_pct])

        fname = factor.replace('load_','')
        t3, m3, t5, m5 = row_vals
        print(f"  {fname:<14} {t3:>+12.2f} {m3:>13.1f}% "
              f"{t5:>+12.2f} {m5:>13.1f}%")


# ══════════════════════════════════════════════════════════════════════════════
# 5.  PLOTS
# ══════════════════════════════════════════════════════════════════════════════

def make_plots(panels, med_results, outpath='mediation_test.png'):
    fig = plt.figure(figsize=(16, 14))
    gs  = gridspec.GridSpec(3, 3, figure=fig, hspace=0.5, wspace=0.38)

    colors_fwd = {3: 'steelblue', 5: 'darkorange'}

    # 1. Factor → distribution (Stage 1) across factors and windows
    ax1 = fig.add_subplot(gs[0,:2])
    factors_short = ['Mkt-RF','SMB','HML','RMW','CMA','MOM']
    x = np.arange(len(factors_short))
    width = 0.35
    for i, fwd in enumerate([3,5]):
        df = panels.get(fwd)
        if df is None: continue
        t_vals = []
        for f in [f'load_{ff}' for ff in factors_short]:
            sub = df.dropna(subset=[f,'fwd_sys_tail'])
            if len(sub) < 20:
                t_vals.append(0)
                continue
            r = sm.OLS(sub['fwd_sys_tail'],
                       sm.add_constant(sub[[f]])).fit()
            t_vals.append(r.tvalues.get(f, 0))
        ax1.bar(x + i*width - width/2, t_vals, width,
                label=f'{fwd}y forward', color=colors_fwd[fwd], alpha=0.8)
    ax1.axhline(2, color='red', ls='--', lw=1, alpha=0.5, label='t=2')
    ax1.axhline(-2, color='red', ls='--', lw=1, alpha=0.5)
    ax1.axhline(0, color='black', lw=0.5)
    ax1.set_xticks(x); ax1.set_xticklabels(factors_short)
    ax1.set_ylabel('t-statistic')
    ax1.set_title('Stage 1: Factor → Future Tail Risk (t-stats)')
    ax1.legend(fontsize=8)

    # 2. Mediation % across factors
    ax2 = fig.add_subplot(gs[0,2])
    if med_results:
        facs   = [r['factor'].replace('load_','') for r in med_results
                  if r and not np.isnan(r.get('mediation_pct', np.nan))]
        m_pcts = [r['mediation_pct'] for r in med_results
                  if r and not np.isnan(r.get('mediation_pct', np.nan))]
        fwds   = [r['fwd_years'] for r in med_results
                  if r and not np.isnan(r.get('mediation_pct', np.nan))]
        colors_bar = [colors_fwd.get(f, 'gray') for f in fwds]
        ax2.barh(range(len(facs)), m_pcts, color=colors_bar, alpha=0.8)
        ax2.axvline(50, color='red', ls='--', lw=1, label='50%')
        ax2.axvline(0, color='black', lw=0.5)
        ax2.set_yticks(range(len(facs)))
        ax2.set_yticklabels([f'{f}({fw}y)' for f,fw in zip(facs,fwds)],
                            fontsize=7)
        ax2.set_xlabel('Mediation %')
        ax2.set_title('% of Factor Effect via Distribution')
        ax2.legend(fontsize=7)

    # 3-4. Scatter: factor loading vs fwd distribution and return
    for i, (fwd, col) in enumerate([(3,'fwd_sys_tail'),(5,'fwd_sys_tail')]):
        ax = fig.add_subplot(gs[1, i])
        df = panels.get(fwd)
        if df is not None:
            sub = df.dropna(subset=['load_HML', col, 'fwd_mean_excess'])
            sc  = ax.scatter(sub['load_HML']*100, sub[col]*100,
                             c=sub['fwd_mean_excess']*100,
                             cmap='RdYlGn', alpha=0.4, s=15)
            plt.colorbar(sc, ax=ax, label='Fwd return (%)')
            ax.set_xlabel('HML Loading')
            ax.set_ylabel('Fwd Tail Risk (%)')
            ax.set_title(f'HML → Tail Risk → Return ({fwd}y)')

    # 5. Two-dimensional rescue in forward window
    ax5 = fig.add_subplot(gs[1,2])
    for fwd, marker in [(3,'o'),(5,'s')]:
        df = panels.get(fwd)
        if df is None: continue
        sub = df.dropna(subset=['fwd_sys_var','fwd_sys_tail','fwd_mean_excess'])
        ax5.scatter(sub['fwd_sys_var']*10000, sub['fwd_sys_tail']*100,
                    c=sub['fwd_mean_excess']*100,
                    cmap='RdYlGn', alpha=0.3, s=10, marker=marker,
                    label=f'{fwd}y')
    ax5.set_xlabel('Fwd Systematic Variance (×10⁴)')
    ax5.set_ylabel('Fwd Systematic Tail Risk (%)')
    ax5.set_title('2D Risk Space\n(coloured by return)')
    ax5.legend(fontsize=7)

    # 6. R² comparison across windows
    ax6 = fig.add_subplot(gs[2,:])
    model_labels = ['A\nFactors\nonly', 'B\nDist\nonly',
                    'C\nFactors\n+dist', 'D\n2D risk\n(rescue)']
    for i, fwd in enumerate([3,5]):
        df = panels.get(fwd)
        if df is None: continue
        sub = df.dropna(subset=FACTOR_VARS+DIST_VARS+['fwd_mean_excess'])
        y   = sub['fwd_mean_excess']
        ra  = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
        rb  = sm.OLS(y, sm.add_constant(sub[DIST_VARS])).fit()
        rc  = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS+DIST_VARS])).fit()
        rd  = sm.OLS(y, sm.add_constant(
                        sub[['fwd_sys_var','fwd_sys_tail']])).fit()
        r2s = [ra.rsquared, rb.rsquared, rc.rsquared, rd.rsquared]
        x = np.arange(len(model_labels))
        ax6.bar(x + i*0.35 - 0.175, r2s, 0.3,
                label=f'{fwd}y forward',
                color=colors_fwd[fwd], alpha=0.8)
    ax6.set_xticks(np.arange(len(model_labels)))
    ax6.set_xticklabels(model_labels, fontsize=8)
    ax6.set_ylabel('R²')
    ax6.set_title('R² by Model and Forward Window Length')
    ax6.legend(fontsize=8)

    fig.suptitle(
        'Factor Mediation Test: Factors → Distribution → Returns',
        fontsize=12, fontweight='bold')
    fig.savefig(outpath, dpi=150, bbox_inches='tight')
    print(f"\n  Plot saved: {outpath}")
    plt.close(fig)


# ══════════════════════════════════════════════════════════════════════════════
# 6.  MAIN
# ══════════════════════════════════════════════════════════════════════════════


def run_variance_regime_sml_test(panels, panels_ol, all_factors):
    """
    ICAPM Variance-Regime SML Test.
    ...
    """
    from scipy.stats import pearsonr, spearmanr

    # Build panels_ov lookup: (fwd_years) -> overlapping dataframe
    panels_ov = {fy: panels_ol[fy] for fy in panels_ol}

    print(f"\n{'='*65}")
    print(f"ICAPM Variance-Regime SML Test")
    print(f"Does the beta premium scale with market variance?")
    print(f"{'='*65}")
    print(f"  Prediction: SML slope steeper in high-variance windows")
    print(f"  Test: regress window-level SML slope on window market variance")

    rm = all_factors['Mkt-RF'] / 100

    for fwd_years, df in panels.items():
        if len(df) < 30:
            continue

        print(f"\n── {fwd_years}-year forward windows ─────────────────────────────────")

        # For each time window, compute:
        # 1. Market variance over the window
        # 2. Cross-sectional SML slope (beta premium) in that window
        # 3. Whether SML slope correlates with market variance

        window_stats = []
        dates = df['date'].unique()

        for t in sorted(dates):
            sub_t = df[df['date'] == t]
            if len(sub_t) < 10:
                continue

            # Market variance over the forward window
            fwd_end = t + pd.DateOffset(years=fwd_years)
            rm_window = rm.loc[t:fwd_end]
            if len(rm_window) < 12:
                continue
            mkt_var = float(rm_window.var() * 12)  # annualised
            mkt_ret = float(rm_window.mean() * 12)  # annualised market return

            # Cross-sectional SML: regress portfolio return on beta
            y = sub_t['fwd_mean_excess'].values
            betas = sub_t['fwd_beta'].values

            if len(y) < 5 or np.std(betas) < 1e-6:
                continue

            # OLS: R_i = alpha + lambda * beta_i
            X = sm.add_constant(betas)
            try:
                reg = sm.OLS(y, X).fit()
                lam = float(reg.params[1])   # SML slope = beta premium
                alpha = float(reg.params[0]) # intercept
                r2 = float(reg.rsquared)
                t_lam = float(reg.tvalues[1])
            except Exception:
                continue

            window_stats.append({
                'date':     t,
                'mkt_var':  mkt_var,
                'mkt_ret':  mkt_ret,
                'lambda':   lam,
                'alpha':    alpha,
                'r2':       r2,
                't_lambda': t_lam,
                'n_ports':  len(sub_t),
            })

        if len(window_stats) < 8:
            print(f"  Insufficient windows ({len(window_stats)}), skipping")
            continue

        ws = pd.DataFrame(window_stats)
        n_win = len(ws)

        print(f"  Windows: {n_win}  "
              f"(mean lambda={ws['lambda'].mean():+.4f}, "
              f"std={ws['lambda'].std():.4f})")
        print(f"  Market variance: mean={ws.mkt_var.mean():.4f}, "
              f"std={ws.mkt_var.std():.4f}")

        # ── Primary test: does lambda scale with market variance? ─────────────
        # Regress SML slope on market variance (controlling for market return)
        y_lam = ws['lambda'].values
        X_var = sm.add_constant(ws[['mkt_var','mkt_ret']].values)
        reg_main = sm.OLS(y_lam, X_var).fit()

        coef_var = float(reg_main.params[1])
        t_var    = float(reg_main.tvalues[1])
        coef_ret = float(reg_main.params[2])
        t_ret    = float(reg_main.tvalues[2])
        r2_main  = float(reg_main.rsquared)

        # Without market return control
        X_var_only = sm.add_constant(ws['mkt_var'].values)
        reg_varonly = sm.OLS(y_lam, X_var_only).fit()
        coef_varonly = float(reg_varonly.params[1])
        t_varonly    = float(reg_varonly.tvalues[1])

        print(f"\n  Primary: does SML slope scale with market variance?")
        print(f"  {'Model':<40} {'coef':>8} {'t':>7}  Sig?")
        print("  " + "-"*60)
        sig_v = '***' if abs(t_varonly)>3 else ('*' if abs(t_varonly)>2 else '')
        sig_c = '***' if abs(t_var)>3    else ('*' if abs(t_var)>2    else '')
        print(f"  {'λ ~ mkt_var (no control)':<40} "
              f"{coef_varonly:>+8.4f} {t_varonly:>+7.2f}  {sig_v}")
        print(f"  {'λ ~ mkt_var + mkt_ret (controlled)':<40} "
              f"{coef_var:>+8.4f} {t_var:>+7.2f}  {sig_c}")
        print(f"  R² of variance → SML slope: {r2_main:.3f}")

        # ── Sort windows into terciles by market variance ─────────────────────
        ws['var_tercile'] = pd.qcut(ws['mkt_var'], 3,
                                     labels=['Low','Mid','High'])
        print(f"\n  SML slope by market variance tercile:")
        print(f"  {'Tercile':<8} {'Mean λ':>9} {'Std λ':>8} "
              f"{'Mean σ²_m':>10} {'N':>4}")
        print("  " + "-"*44)
        for terc in ['Low','Mid','High']:
            sub = ws[ws['var_tercile'] == terc]
            print(f"  {terc:<8} {sub['lambda'].mean():>+9.4f} "
                  f"{sub['lambda'].std():>8.4f} "
                  f"{sub.mkt_var.mean():>10.4f} "
                  f"{len(sub):>4}")

        # ── F-test: High vs Low variance SML slopes ───────────────────────────
        low  = ws[ws['var_tercile']=='Low']['lambda'].values
        high = ws[ws['var_tercile']=='High']['lambda'].values
        if len(low) > 2 and len(high) > 2:
            from scipy.stats import ttest_ind
            t_stat, p_val = ttest_ind(high, low, equal_var=False)
            sig = 'YES ***' if p_val<0.01 else ('yes *' if p_val<0.05 else 'no')
            print(f"\n  High vs Low variance SML slope:")
            print(f"  High mean={high.mean():+.4f}  Low mean={low.mean():+.4f}  "
                  f"Diff={high.mean()-low.mean():+.4f}")
            print(f"  t={t_stat:+.2f}  p={p_val:.4f}  {sig}")

        # ── Spearman rank correlation ─────────────────────────────────────────
        rho, p_rho = spearmanr(ws['mkt_var'], ws['lambda'])
        sig_rho = '***' if p_rho<0.01 else ('*' if p_rho<0.05 else '')
        print(f"\n  Spearman rank correlation (mkt_var, lambda):")
        print(f"  ρ={rho:+.3f}  p={p_rho:.4f}  {sig_rho}")

        # ── ICAPM implied gamma ───────────────────────────────────────────────
        # Under E[R_i] = γ·σ_m²·β_i, the slope of lambda on σ_m² is γ
        # Estimate γ from the variance-only regression
        gamma_implied = coef_varonly
        print(f"\n  Implied risk aversion γ (from λ = γ·σ_m²): "
              f"{gamma_implied:.2f}")
        print(f"  (Theory: γ ≈ 2-10 for typical CRRA utility)")

    print(f"\n  Interpretation:")
    print(f"  If SML slope is steeper in high-variance windows, the market")
    print(f"  correctly priced variance-regime beta in advance — portfolios")
    print(f"  earning more when variance is high were pre-compensated for")
    print(f"  their high conditional beta in those states.")

    # ── Panel interaction test ────────────────────────────────────────────────
    # R_i = α + λ₁·β + λ₂·(β × σ_m²) + ε
    # λ₂ > 0: beta premium scales with market variance (ICAPM)
    # Run on both non-overlapping (N=539, 11 windows) and
    # overlapping (N=2597, 53 windows) panels for power comparison.
    # Overlapping panel uses date-clustered standard errors.

    print(f"\n── Panel Interaction Test ───────────────────────────────────────")
    print(f"  R_i = α + λ₁·β + λ₂·(β × σ_m²) + ε")
    print(f"  λ₂ > 0: beta premium scales with market variance (ICAPM)")
    print(f"  Non-overlapping: 11 windows (independent, standard OLS)")
    print(f"  Overlapping:     53 windows (clustered by date for overlap)")

    # Combine non-overlapping and overlapping panels for comparison
    panel_sets = list(panels.items())  # non-overlapping
    # Add overlapping if available
    if hasattr(panels, 'overlapping'):
        for fy, df_ov in panels.overlapping.items():
            panel_sets.append((fy, df_ov, 'overlapping'))

    for fwd_years, df in panels.items():
        if len(df) < 30:
            continue

        # Run on non-overlapping panel first
        panel_runs = [(df, 'non-overlap', False)]

        # Add overlapping panel if we have it
        if fwd_years in panels_ov:
            panel_runs.append((panels_ov[fwd_years], 'overlapping', True))

        for df_run, label, use_cluster in panel_runs:
            n_windows = df_run['date'].nunique()
            print(f"\n  {fwd_years}-year forward [{label}] "
                  f"(N={len(df_run)}, {n_windows} windows):")

            # Compute market variance for each window date
            dates = df_run['date'].unique()
            var_map = {}
            ret_map = {}
            for t in dates:
                fwd_end = t + pd.DateOffset(years=fwd_years)
                rm_w = rm.loc[t:fwd_end]
                if len(rm_w) >= 12:
                    var_map[t] = float(rm_w.var() * 12)
                    ret_map[t] = float(rm_w.mean() * 12)

            df2 = df_run.copy()
            df2['mkt_var'] = df2['date'].map(var_map)
            df2['mkt_ret'] = df2['date'].map(ret_map)
            df2 = df2.dropna(subset=['fwd_mean_excess','fwd_beta',
                                       'mkt_var','mkt_ret'])

            y  = df2['fwd_mean_excess'].values
            b  = df2['fwd_beta'].values
            v  = df2['mkt_var'].values
            r  = df2['mkt_ret'].values
            bv = b * v
            date_grp = df2['date'].astype(str)

            cov_type = 'cluster' if use_cluster else 'nonrobust'
            cov_kwds = {'groups': date_grp} if use_cluster else {}

            # Model 1: β only (baseline CAPM)
            X1 = sm.add_constant(b)
            r1 = sm.OLS(y, X1).fit(cov_type=cov_type, cov_kwds=cov_kwds)

            # Model 2: β + β×σ² (ICAPM interaction)
            X2 = sm.add_constant(np.column_stack([b, bv]))
            r2 = sm.OLS(y, X2).fit(cov_type=cov_type, cov_kwds=cov_kwds)

            # Model 3: β + β×σ² + σ² + mkt_ret (full controls)
            X3 = sm.add_constant(np.column_stack([b, bv, v, r]))
            r3 = sm.OLS(y, X3).fit(cov_type=cov_type, cov_kwds=cov_kwds)

            # Model 4: β×σ² only
            X4 = sm.add_constant(bv)
            r4 = sm.OLS(y, X4).fit(cov_type=cov_type, cov_kwds=cov_kwds)

            print(f"  {'Model':<44} {'R²':>7}  {'λ₁(β)':>9}  "
                  f"{'λ₂(β×σ²)':>10}  t(λ₂)")
            print("  " + "-"*80)
            for name, reg, has_int in [
                ('CAPM: β only',              r1, False),
                ('ICAPM: β + β×σ²',           r2, True),
                ('ICAPM: β + β×σ² + controls',r3, True),
                ('β×σ² only',                 r4, False),
            ]:
                p = reg.params
                t = reg.tvalues
                l_beta = float(p[1]) if len(p) > 1 else np.nan
                l_int  = float(p[2]) if (has_int and len(p) > 2) else np.nan
                t_int  = float(t[2]) if (has_int and len(t) > 2) else np.nan
                sig = '***' if (not np.isnan(t_int) and abs(t_int)>3) else                       ('*' if (not np.isnan(t_int) and abs(t_int)>2) else '')
                int_str = f"{l_int:>+10.4f}" if not np.isnan(l_int)                           else f"{'—':>10}"
                t_str   = f"{t_int:>+6.2f}{sig}" if not np.isnan(t_int)                           else f"{'—':>8}"
                print(f"  {name:<44} {reg.rsquared:>7.4f}  "
                      f"{l_beta:>+9.4f}  {int_str}  {t_str}")

            # Key result
            t_icapm = float(r2.tvalues[2]) if len(r2.tvalues) > 2 else np.nan
            p_icapm = float(r2.pvalues[2]) if len(r2.pvalues) > 2 else np.nan
            sig_icapm = 'YES ***' if p_icapm<0.01 else                         ('yes *' if p_icapm<0.05 else 'no')
            print(f"\n  ICAPM prediction (λ₂ > 0): {sig_icapm}")
            print(f"  t(λ₂) = {t_icapm:+.2f}  p = {p_icapm:.4f}")
            lam2 = float(r2.params[2]) if len(r2.params) > 2 else np.nan
            print(f"  Implied γ = {lam2:.2f}  (theory: γ ≈ 2-10)")


def main():
    print("="*65)
    print("Factor Mediation Test")
    print("Do factors predict returns through future distribution?")
    print("="*65)

    factors, mom, industries, deciles = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    # ── Non-overlapping panels (primary analysis) ────────────────────────────
    # Each observation is a genuinely independent test period
    # No need for clustered standard errors
    print("\n── Non-overlapping: Industry portfolios ─────────────────────────")
    panels_ind_nol = build_panel(all_factors, industries, label='industry',
                                 lookback_years=5,
                                 forward_years_list=(3, 5),
                                 step_years=None,
                                 tail_q=0.10)

    print("\n── Non-overlapping: Factor decile portfolios ────────────────────")
    panels_dec_nol = build_panel(all_factors, deciles, label='decile',
                                 lookback_years=5,
                                 forward_years_list=(3, 5),
                                 step_years=None,
                                 tail_q=0.10)

    # ── Overlapping panels (for comparison / power) ───────────────────────────
    print("\n── Overlapping (1y step): Factor decile portfolios ──────────────")
    panels_dec_ol = build_panel(all_factors, deciles, label='decile',
                                lookback_years=5,
                                forward_years_list=(3, 5),
                                step_years=1,
                                tail_q=0.10)

    # Primary: non-overlapping decile panels
    panels = panels_dec_nol
    panels_ind = panels_ind_nol

    # Individual factor mediation analyses
    med_results = []
    for fwd_years in [3, 5]:
        df = panels[fwd_years]
        if len(df) < 30:
            continue
        for factor in ['load_HML','load_SMB','load_RMW',
                       'load_CMA','load_MOM']:
            for dist_var in ['fwd_sys_tail','fwd_sys_var']:
                res = run_mediation(df, fwd_years, factor, dist_var)
                if res:
                    med_results.append(res)

    # Full mediation with all factors
    full_results = {}
    for fwd_years in [3, 5]:
        df = panels[fwd_years]
        if len(df) < 30:
            continue
        ra, rb, rc, rd, sub = run_full_mediation(df, fwd_years)
        full_results[fwd_years] = (ra, rb, rc, rd)

    # Window comparison
    compare_windows(panels)

    # Variance-regime SML test
    run_variance_regime_sml_test(panels, panels_dec_ol, all_factors)

    # Plots
    print("\nGenerating plots...")
    make_plots(panels, med_results)

    # Summary
    print("\n" + "="*65)
    print("SUMMARY")
    print("="*65)
    for fwd_years in [3, 5]:
        if fwd_years not in full_results:
            continue
        ra, rb, rc, rd = full_results[fwd_years]
        print(f"\n  {fwd_years}-year forward window:")
        print(f"    Factors only R²:              {ra.rsquared:.4f}")
        print(f"    Distribution only R²:         {rb.rsquared:.4f}  "
              f"({rb.rsquared/ra.rsquared*100:.1f}% of factor R²)")
        print(f"    Factors + distribution R²:    {rc.rsquared:.4f}")
        print(f"    2D risk (sys_var+tail) R²:    {rd.rsquared:.4f}")

    # Mediation summary
    if med_results:
        print(f"\n  Mediation summary (tail risk channel):")
        for fwd in [3, 5]:
            subset = [r for r in med_results
                      if r['fwd_years']==fwd
                      and r['dist_var']=='fwd_sys_tail'
                      and not np.isnan(r['mediation_pct'])]
            if not subset:
                continue
            avg_med = np.mean([r['mediation_pct'] for r in subset])
            avg_s1  = np.mean([r['stage1_t'] for r in subset])
            print(f"    {fwd}y: avg mediation={avg_med:.1f}%  "
                  f"avg Stage1 t={avg_s1:+.2f}")

    # Also run full mediation on industry panels for comparison
    print("\n" + "="*65)
    print("COMPARISON: Non-overlapping vs Overlapping + Industry vs Decile")
    print("="*65)
    for fwd_years in [3, 5]:
        print(f"\n  {fwd_years}-year forward:")
        for label, pnls in [("Ind (non-overlap)",  panels_ind_nol),
                             ("Dec (non-overlap)",  panels_dec_nol),
                             ("Dec (overlap 1y)",   panels_dec_ol)]:
            df = pnls.get(fwd_years, pd.DataFrame())
            if len(df) < 30:
                continue
            req = FACTOR_VARS + DIST_VARS + ['fwd_mean_excess']
            sub = df.dropna(subset=req)
            if len(sub) < 30:
                continue
            y  = sub['fwd_mean_excess']
            ra = sm.OLS(y, sm.add_constant(sub[FACTOR_VARS])).fit()
            rb = sm.OLS(y, sm.add_constant(sub[DIST_VARS])).fit()
            rd = sm.OLS(y, sm.add_constant(
                           sub[['fwd_sys_var','fwd_sys_tail']])).fit()
            print(f"    {label:<10} factors R²={ra.rsquared:.4f}  "
                  f"dist R²={rb.rsquared:.4f}  "
                  f"({rb.rsquared/ra.rsquared*100:.0f}% of factors)  "
                  f"2D rescue: var t={rd.tvalues.get('fwd_sys_var',0):+.2f} "
                  f"tail t={rd.tvalues.get('fwd_sys_tail',0):+.2f}")

    print("="*65)
    print("\nDone.")


if __name__ == '__main__':
    main()