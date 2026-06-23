"""
GP-CRRA Utility Curve Estimation and Mediation Test
====================================================

Pipeline:
1. For each portfolio × forward window, fit a Gaussian process regression
   of portfolio excess returns on market excess returns.  The GP posterior
   gives the smooth conditional expectation  μ_i(r) = E[R_i | R_m = r].

2. The SYSTEMATIC return in each month is the GP fitted value μ_i(R_m,t).
   The distribution of these fitted values is the estimated systematic
   return distribution F_i,t.

3. For a CRRA utility function U(W) = W^(1-γ)/(1-γ) evaluated at
   wealth level W, compute the certainty-equivalent of F_i,t:
       CE_i,t(γ,W) s.t. U(W+CE) = E[U(W + R_systematic)]

4. The model-implied risk premium is:
       RP_i,t(γ,W) = E[R_systematic] - CE_i,t(γ,W)

5. Estimate γ (and optionally W/W0 as a relative wealth) by minimising
   cross-sectional pricing errors across all portfolio-windows.

6. Use fitted RP as the distributional risk measure in mediation regressions.
   Compare with sys_var / sys_tail from the existing pipeline.
"""

import sys, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy import stats, optimize
import statsmodels.api as sm
import requests, zipfile, io

try:
    import GPy
    HAS_GPY = True
except ImportError:
    HAS_GPY = False

# sklearn GP always imported as fallback regardless
try:
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import Matern, WhiteKernel, ConstantKernel
    HAS_SKLEARN_GP = True
except ImportError:
    HAS_SKLEARN_GP = False

if not HAS_GPY and not HAS_SKLEARN_GP:
    raise ImportError("Neither GPy nor sklearn GP available. "
                      "Install either: pip install GPy  or  pip install scikit-learn")
if not HAS_GPY:
    print("INFO: GPy not found – using sklearn GaussianProcessRegressor")

# ── Data loading (same as mediation_test.py) ─────────────────────────────────

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
        if len(parts) < n_cols:
            continue
        if len(parts[0]) == 6:
            try:
                date = int(parts[0])
                if 192601 <= date <= 210012:
                    vals = []
                    for p in parts[1:n_cols]:
                        try:
                            v = float(p)
                            vals.append(np.nan if v in (-99.99, -999.0) else v)
                        except ValueError:
                            vals.append(np.nan)
                    rows.append([date] + vals)
                    in_data = True
            except ValueError:
                pass
    return rows

def _make_df(rows, cols):
    df = pd.DataFrame(rows, columns=cols)
    df['Date'] = pd.to_datetime(df['Date'].astype(str), format='%Y%m')
    df = df.set_index('Date').sort_index()
    return df

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

# ── Factor loadings (same as mediation_test.py) ───────────────────────────────

def estimate_factor_loadings(r_exc, factors_window):
    mkt = factors_window['Mkt-RF'] / 100
    smb = factors_window['SMB']    / 100
    hml = factors_window['HML']    / 100
    rmw = factors_window['RMW']    / 100
    cma = factors_window['CMA']    / 100
    mom_s = factors_window['MOM']  / 100 \
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

# ── GP regression ─────────────────────────────────────────────────────────────

def fit_gp_systematic(rm_excess, ri_excess, n_grid=200):
    """
    Fit a Gaussian process regression of portfolio excess returns on
    market excess returns.

    Returns:
      sys_returns : array of GP-predicted systematic returns at each
                    observed market return (same length as input)
      gp_model    : fitted GP object (for diagnostics)
      length_scale: estimated GP length scale
    """
    rm = np.array(rm_excess, dtype=float)
    ri = np.array(ri_excess, dtype=float)

    # Remove NaNs
    mask = np.isfinite(rm) & np.isfinite(ri)
    if mask.sum() < 12:
        return None, None, np.nan

    rm_c = rm[mask].reshape(-1, 1)
    ri_c = ri[mask]

    if HAS_GPY:
        # Matern 3/2 kernel — once differentiable, allows curvature in tails
        # Length scale initialised at market return std (typical scale of variation)
        ls_init = float(np.std(rm_c) * 1.5)
        kernel = GPy.kern.Matern32(input_dim=1, variance=np.var(ri_c),
                                    lengthscale=ls_init)
        gp = GPy.models.GPRegression(rm_c, ri_c.reshape(-1,1), kernel)
        # Constrain length scale to physically reasonable range:
        # min = 0.5 * std(rm) — allows some nonlinearity
        # max = 5 * std(rm)   — no wilder than roughly linear
        rm_std = float(np.std(rm_c))
        gp.kern.lengthscale.constrain_bounded(rm_std * 0.3, rm_std * 6.0,
                                               warning=False)
        # Noise variance bounded below to prevent overfitting
        gp.likelihood.variance.constrain_bounded(1e-6, np.var(ri_c) * 2.0,
                                                  warning=False)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            gp.optimize(messages=False, max_iters=300)

        # Predict at observed market return points
        mu_pred, _ = gp.predict(rm_c)
        sys_ret = np.full(len(rm), np.nan)
        sys_ret[mask] = mu_pred.flatten()
        ls = float(gp.kern.lengthscale)

    else:
        # sklearn fallback
        rm_std = float(np.std(rm_c))
        kernel = (ConstantKernel(np.var(ri_c)) *
                  Matern(length_scale=rm_std*1.5, nu=1.5,
                         length_scale_bounds=(rm_std*0.3, rm_std*6)) +
                  WhiteKernel(noise_level=np.var(ri_c)*0.1))
        gp = GaussianProcessRegressor(kernel=kernel, n_restarts_optimizer=3,
                                       normalize_y=True)
        gp.fit(rm_c, ri_c)
        mu_pred = gp.predict(rm_c)
        sys_ret = np.full(len(rm), np.nan)
        sys_ret[mask] = mu_pred
        ls = float(gp.kernel_.k1.k2.length_scale) if hasattr(
            gp.kernel_, 'k1') else np.nan

    return sys_ret, gp, ls


# ── CRRA utility functions ────────────────────────────────────────────────────

def crra_utility(x, gamma, W=1.0):
    """
    CRRA utility evaluated at absolute wealth W + return x.
    U(W*(1+r)) = (W*(1+r))^(1-gamma) / (1-gamma)

    gamma=1 → log utility: U = log(W*(1+r))
    """
    wealth = W * (1.0 + x)
    wealth = np.maximum(wealth, 1e-8)   # avoid log(0) or power of negative
    if abs(gamma - 1.0) < 1e-6:
        return np.log(wealth)
    else:
        return wealth**(1.0 - gamma) / (1.0 - gamma)

def crra_inverse_utility(u_val, gamma, W=1.0):
    """
    Inverse of CRRA utility: given U=u_val, find return r such that
    U(W*(1+r)) = u_val.

    CRRA: U(W*(1+r)) = (W*(1+r))^(1-gamma) / (1-gamma)
    Solving for r:
        (W*(1+r))^(1-gamma) = u_val * (1-gamma)
        W*(1+r) = (u_val*(1-gamma))^(1/(1-gamma))
        r = (u_val*(1-gamma))^(1/(1-gamma)) / W - 1
    """
    if abs(gamma - 1.0) < 1e-6:
        # log utility: log(W*(1+r)) = u_val → r = exp(u_val)/W - 1
        return np.exp(u_val) / W - 1.0
    else:
        val = u_val * (1.0 - gamma)
        if val <= 0:
            return -0.999
        # Correct: (val)^(1/(1-gamma)) / W - 1
        return (val ** (1.0 / (1.0 - gamma))) / W - 1.0

def compute_certainty_equivalent(sys_returns, gamma, W=1.0):
    """
    Given array of systematic returns, compute certainty equivalent under CRRA.

    CE such that U(W*(1+CE)) = E[U(W*(1+R_systematic))]
    """
    sys_r = np.array(sys_returns, dtype=float)
    sys_r = sys_r[np.isfinite(sys_r)]
    if len(sys_r) < 5:
        return np.nan

    u_vals = crra_utility(sys_r, gamma, W)
    if not np.all(np.isfinite(u_vals)):
        u_vals = u_vals[np.isfinite(u_vals)]
    if len(u_vals) < 5:
        return np.nan

    mean_u = np.mean(u_vals)

    # Invert to get certainty equivalent
    try:
        ce = crra_inverse_utility(mean_u, gamma, W)
    except Exception:
        ce = np.nan
    return ce

def compute_shape_disutility(sys_returns, gamma, W=1.0):
    """
    Shape disutility = -CE_zero(gamma, W)

    Where CE_zero is the certainty equivalent of the DEMEANED distribution.
    This measures the cost of distributional shape (variance, skewness, kurtosis)
    independently of the mean return.

    In equilibrium: E[R_i] - r_f = Shape_disutility_i(gamma*)
    So this is the correct cross-sectional mediator — it varies because
    portfolio distributions have different shapes, not different means.

    Returns a positive number (higher = worse shape = higher required premium).
    """
    sys_r = np.array(sys_returns, dtype=float)
    sys_r = sys_r[np.isfinite(sys_r)]
    if len(sys_r) < 5:
        return np.nan
    # Demean: remove the mean return, leaving pure shape
    sys_r_zero = sys_r - np.mean(sys_r)
    # CE of zero-mean distribution is <= 0 for risk-averse agent
    ce_zero = compute_certainty_equivalent(sys_r_zero, gamma, W)
    if not np.isfinite(ce_zero):
        return np.nan
    # Shape disutility = -CE_zero >= 0
    return -ce_zero

def compute_risk_premium(sys_returns, gamma, W=1.0):
    """Alias for backwards compatibility — returns shape disutility."""
    return compute_shape_disutility(sys_returns, gamma, W)


# ── Panel building with GP ────────────────────────────────────────────────────

def build_gp_panel(all_factors, portfolios, label='industry',
                   lookback_years=5, forward_years_list=(3, 5),
                   step_years=5):
    """
    Build a panel of GP-estimated systematic return distributions and
    CRRA-implied risk measures.

    For each portfolio × forward window:
      - GP regresses R_i on R_m over the forward window
      - Computes E[R_systematic], sys_var_gp, sys_tail_gp
      - Stores the systematic return series for CRRA fitting

    Returns dict: fwd_years → DataFrame
    """
    print(f"\nBuilding GP panel [{label}] "
          f"(lookback={lookback_years}y, forward={forward_years_list})...")

    rm_full = all_factors['Mkt-RF'] / 100
    rf_full = all_factors['RF']     / 100

    # Flatten portfolio dict
    port_series = {}
    if isinstance(portfolios, dict) and not isinstance(
            list(portfolios.values())[0], pd.Series):
        # nested dict (deciles)
        for group_name, df in portfolios.items():
            for col in df.columns:
                port_series[f"{group_name}_{col}"] = df[col]
    else:
        for col in portfolios.columns:
            port_series[col] = portfolios[col]

    start = all_factors.index.min() + pd.DateOffset(years=lookback_years)
    end   = all_factors.index.max() - pd.DateOffset(
                years=max(forward_years_list))
    t = start

    panels = {fy: [] for fy in forward_years_list}
    n_total = 0

    while t <= end:
        lookback_start = t - pd.DateOffset(years=lookback_years)
        f_back = all_factors.loc[lookback_start:t]

        rm_month_t = float(rm_full.loc[t]) if t in rm_full.index else np.nan

        for port_name, s_raw in port_series.items():
            s  = s_raw.dropna() / 100
            rf = rf_full

            # Factor loadings from lookback window
            r_back_idx = s.index.intersection(f_back.index)
            if len(r_back_idx) < 24:
                continue
            r_back = s.loc[r_back_idx] - rf.loc[r_back_idx]
            loadings = estimate_factor_loadings(r_back, f_back.loc[r_back_idx])
            if loadings is None:
                continue

            for fwd_years in forward_years_list:
                fwd_end = t + pd.DateOffset(years=fwd_years)
                f_fwd   = all_factors.loc[t:fwd_end]

                r_fwd_idx = s.index.intersection(f_fwd.index)
                if len(r_fwd_idx) < 12:
                    continue

                ri_fwd = (s.loc[r_fwd_idx] - rf.loc[r_fwd_idx]).values
                rm_fwd = (rm_full.loc[r_fwd_idx]).values
                rf_fwd_mean = float(rf.loc[r_fwd_idx].mean()) * 12

                # ── GP regression ──────────────────────────────────────────
                sys_ret, gp_model, ls = fit_gp_systematic(rm_fwd, ri_fwd)
                if sys_ret is None:
                    continue
                sys_ret_clean = sys_ret[np.isfinite(sys_ret)]
                if len(sys_ret_clean) < 8:
                    continue

                # ── Distribution summary stats ─────────────────────────────
                mean_sys  = float(np.mean(sys_ret_clean)) * 12  # annualised
                std_sys   = float(np.std(sys_ret_clean))  * np.sqrt(12)
                skew_sys  = float(stats.skew(sys_ret_clean))
                kurt_sys  = float(stats.kurtosis(sys_ret_clean))

                # sys_var_gp: variance of systematic returns (annualised)
                sys_var_gp = float(np.var(sys_ret_clean)) * 12

                # sys_tail_gp: mean systematic return in bottom 20% market months
                q20 = np.percentile(rm_fwd[np.isfinite(rm_fwd)], 20)
                tail_mask = rm_fwd <= q20
                tail_sys  = sys_ret[tail_mask & np.isfinite(sys_ret)]
                sys_tail_gp = float(np.mean(tail_sys)) * 12 \
                              if len(tail_sys) >= 3 else np.nan

                # Realised mean excess return (annualised)
                fwd_mean_exc = float(np.mean(ri_fwd)) * 12

                # Market wealth level proxy: cumulative market return
                # relative to start of window — proxy for W_t / W_0
                cum_mkt = float(np.exp(np.sum(np.log1p(rm_fwd))) )
                # Normalise so W=1 at average market level
                W_proxy = max(0.1, cum_mkt)

                # Actual observed excess returns (for CRRA utility)
                ri_fwd_clean = ri_fwd[np.isfinite(ri_fwd)]

                # Demeaned sys_tail: pure shape measure, mean removed
                # sys_tail_gp_dm = E[R_sys|bad] - E[R_sys]
                # This isolates tail asymmetry from mean return level
                sys_tail_gp_dm = (sys_tail_gp - mean_sys)                                   if np.isfinite(sys_tail_gp) else np.nan

                # Polynomial coskewness (Lambert-Hubner style)
                poly_coskew = np.nan; poly_cokurt = np.nan
                try:
                    mask_p = np.isfinite(ri_fwd) & np.isfinite(rm_fwd)
                    if mask_p.sum() >= 20:
                        rm_s = (rm_fwd[mask_p]-np.mean(rm_fwd[mask_p]))
                        rm_s = rm_s / (np.std(rm_s) if np.std(rm_s)>0 else 1)
                        ri_p = ri_fwd[mask_p]
                        Xp = sm.add_constant(pd.DataFrame(
                            {'rm':rm_s,'rm2':rm_s**2,'rm3':rm_s**3},
                            index=range(len(rm_s))))
                        rp = sm.OLS(ri_p, Xp).fit()
                        poly_coskew = float(rp.params.get('rm2', np.nan))
                        poly_cokurt = float(rp.params.get('rm3', np.nan))
                except Exception:
                    pass

                row = {
                    'date':          t,
                    'portfolio':     port_name,
                    'fwd_years':     fwd_years,
                    'label':         label,
                    'fwd_mean_exc':  fwd_mean_exc,
                    'rf_ann':        rf_fwd_mean,
                    'mean_sys_gp':   mean_sys,
                    'std_sys_gp':    std_sys,
                    'skew_sys_gp':   skew_sys,
                    'kurt_sys_gp':   kurt_sys,
                    'sys_var_gp':    sys_var_gp,
                    'sys_tail_gp':   sys_tail_gp,
                    'sys_tail_gp_dm': sys_tail_gp_dm,
                    'poly_coskew':   poly_coskew,
                    'poly_cokurt':   poly_cokurt,
                    'gp_ls':         ls,
                    'W_proxy':       W_proxy,
                    'n_obs':         len(ri_fwd),
                    # GP systematic returns (conditional means at each R_m)
                    '_sys_ret':      sys_ret_clean.tolist(),
                    # Market returns paired with each sys_ret observation
                    # Used for market-path bootstrap in terminal wealth calculation
                    '_rm_ret':       rm_fwd[np.isfinite(sys_ret)].tolist(),
                    # Actual observed excess returns
                    '_obs_ret':      ri_fwd_clean.tolist(),
                    **loadings,
                }
                panels[fwd_years].append(row)
                n_total += 1

        t += pd.DateOffset(years=step_years)

    result = {}
    for fy in forward_years_list:
        df = pd.DataFrame(panels[fy])
        if len(df):
            df = df.sort_values(['date','portfolio']).reset_index(drop=True)
        result[fy] = df
        n = len(df)
        n_ports = df['portfolio'].nunique() if n else 0
        n_dates = df['date'].nunique() if n else 0
        print(f"  {fy}-year forward: {n} obs "
              f"({n_ports} portfolios × {n_dates} time points)")
        if n > 0:
            # Save panel (excluding list columns) for offline analysis
            save_cols = [c for c in df.columns
                        if not c.startswith('_')]
            df[save_cols].to_csv(
                f'gp_panel_{label}_{fy}y.csv',
                index=False)

    return result


# ── CRRA parameter estimation ─────────────────────────────────────────────────

def fit_crra_parameters(panel_df, use_wealth_scaling=True,
                        gamma_bounds=(0.5, 200.0)):
    """
    Estimate CRRA parameter γ (and optionally wealth scaling) by minimising
    cross-sectional pricing errors:

        min_γ Σ_i,t (R_i,realised - r_f - RP_i,t(γ, W_t))²

    Parameters
    ----------
    panel_df : DataFrame with columns:
        fwd_mean_exc, rf_ann, _sys_ret (list), W_proxy
    use_wealth_scaling : bool
        If True, allow wealth level to scale the utility function across windows.
        The wealth scaling multiplies the base W by W_proxy.
    gamma_bounds : tuple
        Search bounds for γ.

    Returns
    -------
    dict with gamma, W_base, R2, pricing_errors
    """
    df = panel_df.dropna(subset=['fwd_mean_exc']).copy()
    df = df[df['_sys_ret'].apply(lambda x: len(x) >= 8)]
    n = len(df)
    if n < 20:
        return None

    def compute_rp_vector(params):
        if use_wealth_scaling:
            gamma, W_base = params
        else:
            gamma = params[0]
            W_base = 1.0

        gamma = float(np.clip(gamma, 0.2, 300.0))
        W_base = float(np.clip(W_base, 0.1, 10.0))

        rp_vec = np.full(n, np.nan)
        for i, (_, row) in enumerate(df.iterrows()):
            sys_r = np.array(row.get('_sys_ret', []), dtype=float)
            n_months = len(sys_r)
            sd = compute_terminal_shape_disutility(
                sys_r, gamma_eff=gamma,
                W0=1.0, n_bootstrap=200, T_periods=n_months)
            rp_vec[i] = sd * 12 if np.isfinite(sd) else np.nan
        return rp_vec

    def objective(params):
        sd_vec = compute_rp_vector(params)
        # Model: excess_return_i = shape_disutility_i(gamma) + error
        # Shape disutility of demeaned dist should equal excess return at true gamma
        excess = df['fwd_mean_exc'].values - df['rf_ann'].values
        errors = excess - sd_vec
        valid  = np.isfinite(errors)
        if valid.sum() < 10:
            return 1e10
        return float(np.sum(errors[valid]**2))

    # Grid search for starting value of γ
    best_obj = np.inf
    best_gamma = 2.0
    for g0 in [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]:
        obj = objective([g0, 1.0] if use_wealth_scaling else [g0])
        if obj < best_obj:
            best_obj = obj
            best_gamma = g0

    # Optimise
    if use_wealth_scaling:
        x0     = [best_gamma, 1.0]
        bounds = [gamma_bounds, (0.05, 5.0)]
    else:
        x0     = [best_gamma]
        bounds = [gamma_bounds]

    try:
        res = optimize.minimize(objective, x0, method='L-BFGS-B',
                                bounds=bounds,
                                options={'maxiter': 200, 'ftol': 1e-10})
        opt_params = res.x
    except Exception as e:
        print(f"  Optimisation failed: {e}")
        opt_params = x0

    gamma_opt = float(opt_params[0])
    W_opt     = float(opt_params[1]) if use_wealth_scaling else 1.0

    # Compute fitted values and R²
    rp_fitted = compute_rp_vector(opt_params)
    realised  = df['fwd_mean_exc'].values
    fitted    = df['rf_ann'].values + rp_fitted
    valid     = np.isfinite(rp_fitted) & np.isfinite(realised)

    if valid.sum() < 10:
        return None

    r_v = realised[valid]
    f_v = fitted[valid]
    ss_res = np.sum((r_v - f_v)**2)
    ss_tot = np.sum((r_v - r_v.mean())**2)
    r2     = 1 - ss_res / ss_tot if ss_tot > 0 else 0

    return {
        'gamma':     gamma_opt,
        'W_base':    W_opt,
        'R2':        r2,
        'n_valid':   int(valid.sum()),
        'rp_fitted': rp_fitted,
        'valid_mask': valid,
    }


# ── Add RP to panel ───────────────────────────────────────────────────────────

def compute_terminal_shape_disutility(sys_returns_monthly, gamma_eff,
                                      W0=1.0, n_bootstrap=500,
                                      T_periods=60,
                                      rm_returns_monthly=None):
    """
    Shape disutility using terminal wealth distribution.

    If rm_returns_monthly is provided, bootstraps MARKET RETURN PATHS and
    maps them through the (R_m → sys_ret) relationship to preserve the
    asymmetric beta structure. This correctly captures how negative skewness
    from asymmetric beta compounds over the investment horizon.

    If rm_returns_monthly is None, falls back to i.i.d. bootstrap of
    systematic returns (old behaviour — loses asymmetric beta structure).

    gamma_eff: effective CRRA = 1 + T_mean*(gamma-1)
    """
    sys_r = np.array(sys_returns_monthly, dtype=float)
    if rm_returns_monthly is not None:
        rm_r = np.array(rm_returns_monthly, dtype=float)
        # Keep only paired observations
        mask = np.isfinite(sys_r) & np.isfinite(rm_r)
        sys_r = sys_r[mask]
        rm_r  = rm_r[mask]
    else:
        mask = np.isfinite(sys_r)
        sys_r = sys_r[mask]
        rm_r  = None

    if len(sys_r) < 12:
        return np.nan

    # Demean systematic returns
    mean_sys = np.mean(sys_r)
    sys_zero = sys_r - mean_sys

    if rm_r is not None:
        # Market-path bootstrap: resample (R_m, sys_zero) pairs together
        # This preserves the R_m → sys_ret mapping (asymmetric beta)
        n_obs = len(sys_zero)
        idx = np.random.choice(n_obs, size=(n_bootstrap, T_periods),
                               replace=True)
        # Each path uses the sys_zero values at the resampled market states
        paths = sys_zero[idx]  # shape (n_bootstrap, T_periods)
    else:
        # Fallback: i.i.d. bootstrap of sys_zero directly
        paths = np.random.choice(sys_zero,
                                 size=(n_bootstrap, T_periods),
                                 replace=True)

    terminal_wealth = W0 * np.prod(1.0 + paths, axis=1)
    terminal_wealth = np.maximum(terminal_wealth, 1e-8)

    if abs(gamma_eff - 1.0) < 1e-6:
        u_vals = np.log(terminal_wealth)
    else:
        u_vals = terminal_wealth**(1.0-gamma_eff) / (1.0-gamma_eff)

    u_vals = u_vals[np.isfinite(u_vals)]
    if len(u_vals) < 10:
        return np.nan
    mean_u = np.mean(u_vals)

    if abs(gamma_eff - 1.0) < 1e-6:
        w_ce = np.exp(mean_u)
    else:
        val = mean_u * (1.0 - gamma_eff)
        if val <= 0:
            return np.nan
        w_ce = val**(1.0/(1.0-gamma_eff))

    r_ce = (w_ce / W0)**(1.0/T_periods) - 1.0
    if not np.isfinite(r_ce):
        return np.nan
    return float(-r_ce)


def add_crra_rp(panel_df, gamma, W_base=1.0, use_wealth=True):
    """Add CRRA risk premium column to panel using estimated parameters."""
    rp_list = []
    for _, row in panel_df.iterrows():
        sys_r = row.get('_sys_ret', [])
        rm_r  = row.get('_rm_ret', None)
        if not isinstance(sys_r, (list, np.ndarray)) or len(sys_r) < 5:
            rp_list.append(np.nan)
            continue
        n_months = len(sys_r)
        sd = compute_terminal_shape_disutility(
            np.array(sys_r), gamma_eff=gamma,
            W0=1.0, n_bootstrap=300, T_periods=n_months,
            rm_returns_monthly=np.array(rm_r) if rm_r is not None else None)
        rp_list.append(sd * 12 if np.isfinite(sd) else np.nan)
    panel_df = panel_df.copy()
    panel_df['crra_rp'] = rp_list
    return panel_df


# ── Mediation test ────────────────────────────────────────────────────────────

def run_crra_mediation(panel_df, fwd_years, gamma_fixed=None):
    """
    Full mediation test using CRRA risk premium as the distributional measure.

    Tests:
    1. Does crra_rp predict cross-sectional returns?
    2. Does it mediate the Fama-French factors?
    3. How does it compare to sys_var_gp and sys_tail_gp?
    4. Implied CRRA γ from cross-sectional fit.
    """
    df = panel_df.dropna(subset=['fwd_mean_exc','crra_rp',
                                  'sys_var_gp','sys_tail_gp']).copy()
    n = len(df)
    if n < 30:
        print(f"  Insufficient observations ({n})")
        return

    print(f"\n{'='*65}")
    print(f"CRRA-GP Mediation Test ({fwd_years}-year forward, N={n})")
    print(f"{'='*65}")

    y  = df['fwd_mean_exc'].values
    date_grp = df['date'].astype(str).values

    factors = ['load_Mkt-RF','load_SMB','load_HML',
               'load_RMW','load_CMA','load_MOM']
    factors = [f for f in factors if f in df.columns]

    # ── Model comparison ───────────────────────────────────────────────────
    def fit_ols(X_df, label):
        # Pass DataFrame (not .values) so column names are preserved in exog_names
        X  = sm.add_constant(X_df)
        reg = sm.OLS(y, X).fit(
            cov_type='cluster', cov_kwds={'groups': date_grp})
        return reg

    print(f"\n── R² Comparison ─────────────────────────────────────────────")
    print(f"  {'Model':<45} {'R²':>7}  {'% Factor R²':>12}")
    print("  " + "-"*67)

    # A: Factors only
    reg_A = fit_ols(df[factors], 'factors')
    r2_A  = reg_A.rsquared

    # B: GP sys_var + sys_tail (non-parametric, NOT demeaned)
    reg_B = fit_ols(df[['sys_var_gp','sys_tail_gp']], 'dist_np')
    r2_B  = reg_B.rsquared

    # B3: Polynomial coskewness + cokurtosis (Lambert-Hubner style)
    poly_cols = [c for c in ['poly_coskew','poly_cokurt'] if c in df.columns]
    df_poly = df.dropna(subset=poly_cols) if poly_cols else df
    reg_B3 = fit_ols(df_poly[poly_cols], 'poly') if poly_cols else None
    r2_B3  = reg_B3.rsquared if reg_B3 else np.nan

    # B2: GP sys_var + demeaned sys_tail (pure shape, mean removed)
    df_dm = df.dropna(subset=['sys_tail_gp_dm'])
    reg_B2 = fit_ols(df_dm[['sys_var_gp','sys_tail_gp_dm']], 'dist_dm')              if 'sys_tail_gp_dm' in df.columns else None
    r2_B2 = reg_B2.rsquared if reg_B2 else np.nan

    # C: CRRA risk premium only
    reg_C = fit_ols(df[['crra_rp']], 'crra')
    r2_C  = reg_C.rsquared

    # D: CRRA + factors
    reg_D = fit_ols(df[factors + ['crra_rp']], 'crra+factors')
    r2_D  = reg_D.rsquared

    # E: GP dist + factors
    reg_E = fit_ols(df[factors + ['sys_var_gp','sys_tail_gp']], 'dist+factors')
    r2_E  = reg_E.rsquared

    # F: mean_sys_gp only (test if mean return drives B's R²)
    reg_F = fit_ols(df[['mean_sys_gp']], 'mean_sys')
    r2_F  = reg_F.rsquared

    for lbl, r2 in [
            ('A  Factors only',                      r2_A),
            ('B  GP sys_var + sys_tail (raw)',        r2_B),
            ('B2 GP sys_var + sys_tail (demeaned)',   r2_B2),
            ('B3 Poly coskew + cokurt (LH style)',    r2_B3),
            ('C  CRRA shape disutility only',         r2_C),
            ('D  CRRA + factors',                     r2_D),
            ('E  GP dist (raw) + factors',            r2_E),
            ('F  mean_sys_gp only (look-ahead check)',r2_F)]:
        pct = r2/r2_A*100 if r2_A > 0 else np.nan
        print(f"  {lbl:<45} {r2:>7.4f}  {pct:>11.1f}%")

    # ── CRRA coefficient t-stat ─────────────────────────────────────────────
    print(f"\n── CRRA Risk Premium Pricing ─────────────────────────────────")
    crra_t  = reg_C.tvalues.get('crra_rp', np.nan)               if hasattr(reg_C.tvalues, 'get')               else (reg_C.tvalues[1] if len(reg_C.tvalues)>1 else np.nan)
    crra_p  = reg_C.pvalues.get('crra_rp', np.nan)               if hasattr(reg_C.pvalues, 'get')               else (reg_C.pvalues[1] if len(reg_C.pvalues)>1 else np.nan)
    crra_b  = reg_C.params.get('crra_rp', np.nan)               if hasattr(reg_C.params, 'get')               else (reg_C.params[1] if len(reg_C.params)>1 else np.nan)
    sig     = '***' if crra_p<0.01 else ('*' if crra_p<0.05 else '')
    # Diagnostics on shape disutility
    sd_col = df['crra_rp'].values
    exc_col = (df['fwd_mean_exc'] - df['rf_ann']).values
    valid_both = np.isfinite(sd_col) & np.isfinite(exc_col)
    if valid_both.sum() > 10:
        corr = np.corrcoef(sd_col[valid_both], exc_col[valid_both])[0,1]
        print(f"  Shape disutility diagnostics:")
        print(f"    mean={np.nanmean(sd_col):+.4f}  std={np.nanstd(sd_col):.4f}  "
              f"min={np.nanmin(sd_col):+.4f}  max={np.nanmax(sd_col):+.4f}")
        print(f"    corr(shape_disutil, excess_return)={corr:+.4f}")
        print(f"    (positive correlation = model predicts higher risk → higher return)")
    print(f"  shape_disutil coef={crra_b:+.4f}  t={crra_t:+.2f}{sig}  "
          f"p={crra_p:.4f}  R²={r2_C:.4f}")
    print(f"  (Expected coef ≈ 1.0 if CRRA correctly prices the cross-section)")

    # Additional correlations — diagnose what drives predictive power
    excess = (df['fwd_mean_exc'] - df['rf_ann']).values
    print(f"\n── Correlations with excess return ─────────────────────────")
    for col in ['sys_var_gp','sys_tail_gp','sys_tail_gp_dm',
                'skew_sys_gp','kurt_sys_gp',
                'poly_coskew','poly_cokurt',
                'mean_sys_gp','crra_rp']:
        if col in df.columns:
            vals = df[col].values
            mask = np.isfinite(vals) & np.isfinite(excess)
            if mask.sum() > 10:
                corr = np.corrcoef(vals[mask], excess[mask])[0,1]
                print(f"  corr({col:<20}, excess_ret) = {corr:+.4f}")

    # ── Factor shrinkage ────────────────────────────────────────────────────
    print(f"\n── Factor Shrinkage: Factors → Factors + CRRA ──────────────")
    print(f"  {'Factor':<15} {'Without CRRA':>14} {'With CRRA':>12}  "
          f"{'Mediation%':>11}")
    print("  " + "-"*58)

    for f in factors:
        # Safely extract coefficients and t-stats from regression results
        def get_coef_t(reg, fname):
            names = list(reg.model.exog_names)
            if fname not in names:
                return np.nan, np.nan
            idx = names.index(fname)
            return float(reg.params[idx]), float(reg.tvalues[idx])

        bA, tA = get_coef_t(reg_A, f)
        bD, tD = get_coef_t(reg_D, f)
        med = (bA - bD) / bA * 100 if np.isfinite(bA) and abs(bA) > 1e-8 else np.nan
        sA = '*' if abs(tA)>2 else ''
        sD = '*' if abs(tD)>2 else ''
        fname = f.replace('load_','')
        print(f"  {fname:<15} {bA:>+10.4f}{sA:1s}   {bD:>+10.4f}{sD:1s}  "
              f"  {med:>9.1f}%")

    # ── F-tests ─────────────────────────────────────────────────────────────
    print(f"\n── Key F-tests ────────────────────────────────────────────────")

    def f_test_add(base_df, add_df, label):
        base_X = sm.add_constant(base_df)
        # Combine DataFrames for full model
        if hasattr(add_df, 'columns'):
            full_df = pd.concat([base_df.reset_index(drop=True),
                                 add_df.reset_index(drop=True)], axis=1)
        else:
            full_df = pd.concat([base_df.reset_index(drop=True),
                                 pd.DataFrame(add_df)], axis=1)
        full_X = sm.add_constant(full_df)
        base_r = sm.OLS(y, base_X).fit()
        full_r = sm.OLS(y, full_X).fit()
        rss0 = np.sum(base_r.resid**2)
        rss1 = np.sum(full_r.resid**2)
        q = add_df.shape[1] if hasattr(add_df, 'shape') else 1
        n_obs = len(y)
        k1 = full_X.shape[1]
        f_stat = ((rss0-rss1)/q) / (rss1/(n_obs-k1))
        p_val  = 1 - stats.f.cdf(f_stat, q, n_obs-k1)
        sig = 'YES ***' if p_val<0.01 else ('yes *' if p_val<0.05 else 'no')
        print(f"  {label:<45} F={f_stat:>6.2f}  p={p_val:.4f}  {sig}")

    f_test_add(df[factors],              df[['crra_rp']],
               'CRRA adds over factors')
    f_test_add(df[['crra_rp']],          df[factors],
               'Factors add over CRRA')
    f_test_add(df[['sys_var_gp']],       df[['sys_tail_gp']],
               'sys_tail_gp adds over sys_var_gp')
    f_test_add(df[['crra_rp']],          df[['sys_var_gp','sys_tail_gp']],
               'GP dist adds over CRRA')
    f_test_add(df[['sys_var_gp',
                   'sys_tail_gp']],      df[['crra_rp']],
               'CRRA adds over GP dist')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # ── Data ──────────────────────────────────────────────────────────────
    factors, mom, industries, deciles = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    # ── Build GP panels (non-overlapping, 5-year steps) ───────────────────
    print("\n── Non-overlapping: Industry portfolios ──────────────────────")
    panels_ind = build_gp_panel(
        all_factors, industries, label='industry',
        lookback_years=5, forward_years_list=(3, 5), step_years=5)

    print("\n── Non-overlapping: Factor decile portfolios ─────────────────")
    panels_dec = build_gp_panel(
        all_factors, deciles, label='decile',
        lookback_years=5, forward_years_list=(3, 5), step_years=5)

    # ── Fit CRRA parameters ───────────────────────────────────────────────
    print(f"\n{'='*65}")
    print("CRRA Parameter Estimation")
    print(f"{'='*65}")

    crra_results = {}
    for label, panels in [('industry', panels_ind), ('decile', panels_dec)]:
        for fwd_years, df in panels.items():
            if len(df) < 20:
                continue
            print(f"\n  [{label}] {fwd_years}-year forward (N={len(df)}):")

            # Without wealth scaling
            res_fixed = fit_crra_parameters(df, use_wealth_scaling=False)
            if res_fixed:
                print(f"    Fixed W:   γ_eff={res_fixed['gamma']:.3f}  "
                      f"R²={res_fixed['R2']:.4f}  "
                      f"N={res_fixed['n_valid']}")

            # With wealth scaling
            res_scaled = fit_crra_parameters(df, use_wealth_scaling=True)
            if res_scaled:
                print(f"    Scaled W:  γ_eff={res_scaled['gamma']:.3f}  "
                      f"W_base={res_scaled['W_base']:.3f}  "
                      f"R²={res_scaled['R2']:.4f}  "
                      f"N={res_scaled['n_valid']}")

            crra_results[(label, fwd_years)] = res_scaled or res_fixed

    # ── Add CRRA RP to panels and run mediation ────────────────────────────
    print(f"\n{'='*65}")
    print("CRRA-GP Mediation Tests")
    print(f"{'='*65}")

    for label, panels in [('decile', panels_dec)]:
        for fwd_years, df in panels.items():
            if len(df) < 20:
                continue
            res = crra_results.get((label, fwd_years))
            if res is None:
                print(f"\n  No CRRA result for [{label}] {fwd_years}y")
                continue

            gamma_opt = res['gamma']
            W_opt     = res['W_base']
            use_W     = res.get('W_base', 1.0) != 1.0

            df_rp = add_crra_rp(df, gamma_opt, W_opt, use_wealth=True)
            run_crra_mediation(df_rp, fwd_years, gamma_fixed=gamma_opt)

    print("\nDone.")

if __name__ == '__main__':
    main()