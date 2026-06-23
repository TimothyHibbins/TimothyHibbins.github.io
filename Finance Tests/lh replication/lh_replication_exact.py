"""
Lambert-Hübner (2013) Replication — Exact Methodology
=======================================================

Follows Lambert & Hübner (2013) "Comoment Risk and Stock Returns"
Journal of Empirical Finance 23, 191-205.

Key methodology (from paper Section 3):
1. Comoment estimation via polynomial regression (Eq. 1):
   Ri,t - rf,t = c0 + c1*(RM,t-rf,t) + c2*(RM,t-RM_bar)^2 + c3*(RM,t-RM_bar)^3
   where RM_bar = mean market return over preceding 36 months
   Estimated on monthly basis with 36-month rolling window

2. Triple sequential conditional sort into 27 portfolios (3x3x3):
   - Sort on covariance (beta) first
   - Within each, sort on coskewness
   - Within each, sort on cokurtosis
   Monthly rebalancing

3. Factor = arithmetic average of 9 long-short spreads (Eq. 2)

4. Fama-MacBeth test (Section 4):
   - Test assets: French 25 and 100 size/BTM portfolios
   - Factor loading estimation: 48-month rolling window
   - Monthly cross-sectional regressions
   - Up/down market segmentation (Pettengill et al. 1995)

Data: Stooq bulk download (stock_returns_stooq.csv)
      Ken French library (FF factors, 25/100 BTM portfolios)
"""

import sys, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy import stats
import statsmodels.api as sm
import requests, zipfile, io
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

STOCK_RETURNS_FILE = 'stock_returns_stooq.csv'
LOOKBACK_MONTHS    = 36    # LH: 36-month rolling window
LOADING_MONTHS     = 48    # LH: 48-month window for Fama-MacBeth loadings
N_GROUPS           = 3     # LH: tertile sorts (3 groups per dimension)
START_DATE         = '1993-01-01'  # after 36-month lookback from 1990
END_DATE           = '2024-12-31'
MIN_OBS            = 24    # minimum valid months in rolling window

# ── Data loading ──────────────────────────────────────────────────────────────

FF_BASE  = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
HEADERS  = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}

def _get_zip(filename, timeout=60):
    url = f"{FF_BASE}/{filename}_CSV.zip"
    r = requests.get(url, headers=HEADERS, timeout=timeout)
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
        if len(parts) < n_cols: continue
        if len(parts[0]) == 6:
            try:
                date = int(parts[0])
                if 192601 <= date <= 210012:
                    vals = []
                    for p in parts[1:n_cols]:
                        try:
                            v = float(p)
                            vals.append(np.nan if v in (-99.99,-999.) else v)
                        except: vals.append(np.nan)
                    rows.append([date] + vals)
                    in_data = True
            except: pass
    return rows

def _make_df(rows, cols):
    df = pd.DataFrame(rows, columns=cols)
    df['Date'] = pd.to_datetime(df['Date'].astype(str), format='%Y%m')
    return df.set_index('Date').sort_index()

def norm_idx(obj):
    """Normalise index to month-end timestamps."""
    obj = obj.copy()
    obj.index = obj.index.to_period('M').to_timestamp('M')
    return obj

def fetch_ff_factors():
    cache = Path('ff_factors_cache.csv')
    if cache.exists():
        try:
            df = pd.read_csv(cache, index_col=0, parse_dates=True)
            if df.shape[1] >= 6:
                df = norm_idx(df)
                print(f"  ✓ FF factors from cache: {df.shape[0]} months")
                return df
        except: pass
    print("  Fetching FF5 factors...")
    ff5 = _make_df(_parse_monthly(_get_zip('F-F_Research_Data_5_Factors_2x3'),7),
                   ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
    mom = _make_df(_parse_monthly(_get_zip('F-F_Momentum_Factor'),2),
                   ['Date','MOM'])
    df = norm_idx(ff5.join(mom, how='left').fillna(0))
    df.to_csv(cache)
    print(f"  ✓ FF factors: {df.shape[0]} months")
    return df

def fetch_btm_portfolios(name, n_cols, col_names):
    """Fetch French size/BTM sorted portfolios."""
    cache = Path(f'{name}_cache.csv')
    if cache.exists():
        try:
            df = pd.read_csv(cache, index_col=0, parse_dates=True)
            if df.shape[1] >= n_cols - 1:
                df = norm_idx(df)
                print(f"  ✓ {name} from cache: {df.shape}")
                return df / 100
        except: pass
    print(f"  Fetching {name}...")
    content = _get_zip(name)
    # Find value-weighted returns section
    lines = content.split('\n')
    rows = []
    in_vw = False
    for line in lines:
        s = line.strip().rstrip(',')
        if 'Average Value Weighted Returns' in s or \
           'Value Weight' in s.lower():
            in_vw = True; continue
        if in_vw and ('Average Equal' in s or 'Equal Weight' in s.lower()):
            break
        if not in_vw: continue
        if not s: continue
        parts = [p.strip() for p in s.split(',')]
        if len(parts) >= n_cols:
            try:
                date = int(parts[0])
                if 192601 <= date <= 210012:
                    vals = []
                    for p in parts[1:n_cols]:
                        try:
                            v = float(p)
                            vals.append(np.nan if v in (-99.99,-999.) else v)
                        except: vals.append(np.nan)
                    rows.append([date] + vals)
            except: pass
    if not rows:
        return None
    df = _make_df(rows, ['Date'] + col_names)
    df = norm_idx(df)
    df.to_csv(cache)
    print(f"  ✓ {name}: {df.shape}")
    return df / 100

def load_stock_returns(filepath):
    print(f"  Loading {filepath}...")
    df = pd.read_csv(filepath, index_col=0, parse_dates=True)
    df = norm_idx(df)
    # Winsorise at monthly [-50%, +200%] to remove data errors
    df = df.clip(lower=-0.50, upper=2.00)
    print(f"  ✓ {df.shape[1]} stocks, {df.shape[0]} months")
    print(f"    {df.index[0].date()} to {df.index[-1].date()}")
    return df

# ── Step 1: Comoment estimation ───────────────────────────────────────────────

def estimate_comoments_lh(ri_exc, rm_exc, rm_bar_36):
    """
    Lambert-Hübner Eq. (1):
    Ri - rf = c0 + c1*(RM-rf) + c2*(RM-RM_bar)^2 + c3*(RM-RM_bar)^3

    rm_bar_36: rolling 36-month mean of RM (not rf-adjusted in paper)
    Returns dict with beta (c1), coskew (c2), cokurt (c3), or None.
    """
    ri = np.array(ri_exc, dtype=float)
    rm = np.array(rm_exc, dtype=float)
    rm_bar = float(rm_bar_36)

    mask = np.isfinite(ri) & np.isfinite(rm)
    if mask.sum() < MIN_OBS:
        return None

    ri_c = ri[mask]; rm_c = rm[mask]

    # Demeaned market return (using rolling 36m mean)
    rm_dm = rm_c - rm_bar

    X = sm.add_constant(pd.DataFrame({
        'rm':  rm_c,          # c1: beta (market excess return)
        'rm2': rm_dm ** 2,    # c2: coskewness loading
        'rm3': rm_dm ** 3,    # c3: cokurtosis loading
    }))
    try:
        reg = sm.OLS(ri_c, X).fit()
        return {
            'beta':   float(reg.params.get('rm',  np.nan)),
            'coskew': float(reg.params.get('rm2', np.nan)),
            'cokurt': float(reg.params.get('rm3', np.nan)),
            'n':      int(mask.sum()),
        }
    except:
        return None

# ── Step 2: Triple sequential sort → 27 portfolios → factor ──────────────────

def triple_sort_factor(stock_rets_t, comoments_t, dim_order,
                       n_groups=N_GROUPS):
    """
    Lambert-Hübner triple sequential conditional sort (Section 3.2).

    dim_order: list of 3 strings e.g. ['beta','coskew','cokurt']
    The LAST dimension is the one being priced; first two are controls.
    Factor = (1/9) * sum of 9 long(high)-short(low) spreads on last dim.

    Returns: float (monthly factor return) or np.nan
    """
    # Get comoment values for stocks available this month
    tickers = [t for t in stock_rets_t.index
               if t in comoments_t.index
               and np.isfinite(stock_rets_t[t])
               and all(np.isfinite(comoments_t.loc[t, d]) for d in dim_order)]

    if len(tickers) < n_groups ** 3 * 3:
        return np.nan

    cm = comoments_t.loc[tickers]
    rets = stock_rets_t.loc[tickers]

    # Sequential conditional sort
    # Stage 1: sort on dim_order[0] into n_groups tertiles
    d0 = dim_order[0]
    cuts0 = np.percentile(cm[d0], np.linspace(0, 100, n_groups+1)[1:-1])
    group0 = np.digitize(cm[d0], cuts0)  # 0, 1, ..., n_groups-1

    # Collect all 9 spread portfolios
    spreads = []

    for g0 in range(n_groups):
        mask0 = group0 == g0
        if mask0.sum() < n_groups * 2:
            continue
        cm_g0 = cm[mask0]; rets_g0 = rets[mask0]

        # Stage 2: within g0, sort on dim_order[1]
        d1 = dim_order[1]
        cuts1 = np.percentile(cm_g0[d1], np.linspace(0, 100, n_groups+1)[1:-1])
        group1 = np.digitize(cm_g0[d1], cuts1)

        for g1 in range(n_groups):
            mask1 = group1 == g1
            if mask1.sum() < n_groups * 2:
                continue
            cm_g1 = cm_g0[mask1]; rets_g1 = rets_g0[mask1]

            # Stage 3: within g1, sort on dim_order[2] (the priced dimension)
            d2 = dim_order[2]
            cuts2 = np.percentile(cm_g1[d2], np.linspace(0,100,n_groups+1)[1:-1])
            group2 = np.digitize(cm_g1[d2], cuts2)

            # Long: high on d2 (group n_groups-1)
            # Short: low on d2 (group 0)
            high_mask = group2 == n_groups - 1
            low_mask  = group2 == 0

            if high_mask.sum() < 2 or low_mask.sum() < 2:
                continue

            r_high = float(rets_g1[high_mask].mean())
            r_low  = float(rets_g1[low_mask].mean())
            spreads.append(r_high - r_low)

    if len(spreads) < 3:
        return np.nan

    # Factor = arithmetic average of spreads
    # For coskewness: low minus high (negative = bad for investors)
    # For cokurtosis: high minus low
    # LH convention: coskewness factor = LOW coskew - HIGH coskew
    # (stocks with low/negative coskew should earn more)
    return float(np.mean(spreads))

# ── Step 3: Build monthly factor time series ──────────────────────────────────

def build_monthly_factors(stock_returns, ff_factors,
                          lookback=LOOKBACK_MONTHS):
    """
    For each month t from lookback+1 to end:
    1. Estimate comoments for each stock from months [t-lookback, t-1]
    2. Do triple sort, compute factor return for month t

    Returns: DataFrame with columns [COV, SKEW, KURT] monthly
    """
    rm  = ff_factors['Mkt-RF'] / 100
    rf  = ff_factors['RF']     / 100

    # Align indices
    sr_idx = stock_returns.index.to_period('M').to_timestamp('M')
    stock_returns = stock_returns.copy()
    stock_returns.index = sr_idx

    common = stock_returns.index.intersection(ff_factors.index)
    SR = stock_returns.loc[common]
    rm = rm.loc[common]
    rf = rf.loc[common]

    dates = SR.index[lookback:]
    print(f"\n  Building monthly factors ({len(dates)} months)...")
    print(f"  {dates[0].date()} to {dates[-1].date()}")

    cov_rets  = []
    skew_rets = []
    kurt_rets = []
    factor_dates = []

    for i, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)
        lb_start = t_pos - lookback
        lb_end   = t_pos  # exclusive: [lb_start, lb_end)

        # Lookback window
        rm_lb = rm.iloc[lb_start:lb_end]
        rf_lb = rf.iloc[lb_start:lb_end]
        SR_lb = SR.iloc[lb_start:lb_end]

        # Rolling 36-month mean of market return (for demeaning)
        rm_bar_36 = float(rm_lb.mean())

        # Estimate comoments for each stock
        comoments = {}
        for ticker in SR.columns:
            ri = SR_lb[ticker].values
            rm_v = rm_lb.values
            rf_v = rf_lb.values
            ri_exc = ri - rf_v
            rm_exc = rm_v - rf_v.mean()  # approximate; LH uses raw RM-rf
            cm = estimate_comoments_lh(ri_exc, rm_exc, rm_bar_36)
            if cm is not None:
                comoments[ticker] = cm

        if len(comoments) < N_GROUPS**3 * 5:
            cov_rets.append(np.nan)
            skew_rets.append(np.nan)
            kurt_rets.append(np.nan)
            factor_dates.append(t)
            continue

        cm_df = pd.DataFrame(comoments).T[['beta','coskew','cokurt']]
        # Replace infinities
        cm_df = cm_df.replace([np.inf, -np.inf], np.nan).dropna()

        # Next month's returns (month t)
        if t_pos >= len(SR):
            cov_rets.append(np.nan)
            skew_rets.append(np.nan)
            kurt_rets.append(np.nan)
            factor_dates.append(t)
            continue
        next_rets = SR.iloc[t_pos]  # returns in month t

        # LH factor ordering:
        # COV:  KV,S or SV,K → last dim = beta (covariance)
        # SKEW: KV,S or equivalent → controlling beta+kurtosis, pricing skew
        # KURT: SV,K or equivalent → controlling beta+skew, pricing kurtosis
        # Paper retains: VS,K (cov→skew→kurt), SV,K (skew→cov→kurt),
        #                KV,S (kurt→cov→skew)

        # Coskewness factor (SV,K): sort on skew, controlling for cov then kurt
        # LH: coskewness premium = LOW skew MINUS HIGH skew
        # (negative coskewness is bad, should earn more)
        skew_factor = triple_sort_factor(
            next_rets, cm_df,
            dim_order=['beta', 'cokurt', 'coskew'])
        # Flip sign: factor = LOW - HIGH coskewness
        if np.isfinite(skew_factor):
            skew_factor = -skew_factor  # low coskew earns more

        # Cokurtosis factor (KV,S): sort on kurt, controlling for cov then skew
        kurt_factor = triple_sort_factor(
            next_rets, cm_df,
            dim_order=['beta', 'coskew', 'cokurt'])
        # No sign flip: high cokurtosis earns more premium

        # Covariance factor (VS,K): sort on beta, controlling for skew then kurt
        cov_factor = triple_sort_factor(
            next_rets, cm_df,
            dim_order=['coskew', 'cokurt', 'beta'])
        # High beta earns more

        cov_rets.append(cov_factor)
        skew_rets.append(skew_factor)
        kurt_rets.append(kurt_factor)
        factor_dates.append(t)

        if (i+1) % 50 == 0:
            n_valid = sum(1 for x in skew_rets if np.isfinite(x))
            print(f"    {i+1}/{len(dates)} months  "
                  f"({n_valid} valid skew factors so far)")

    idx = pd.DatetimeIndex(factor_dates).to_period('M').to_timestamp('M')
    factors = pd.DataFrame({
        'COV':  cov_rets,
        'SKEW': skew_rets,
        'KURT': kurt_rets,
    }, index=idx)

    print(f"\n  Factor summary:")
    for col in factors.columns:
        s = factors[col].dropna()
        if len(s) > 0:
            t_stat = s.mean() / (s.std(ddof=1) / np.sqrt(len(s)))
            print(f"    {col}: N={len(s):3d}  mean={s.mean()*100:+.3f}%  "
                  f"std={s.std()*100:.3f}%  t={t_stat:+.2f}")

    return factors

# ── Step 4: Fama-MacBeth on 25/100 BTM portfolios ────────────────────────────

def fama_macbeth_lh(port_df, factors_monthly, ff_monthly,
                    loading_window=LOADING_MONTHS, label=''):
    """
    Lambert-Hübner Fama-MacBeth procedure (Section 4).

    Step 1 (time series): for each portfolio, estimate factor loadings
    using rolling loading_window months.

    Step 2 (cross section): each month, regress portfolio returns on
    lagged loadings. Report mean and t-stat of cross-sectional slopes.

    Tests:
    M.1: FF4 (Mkt + SMB + HML + UMD)
    M.2: Four-moment (Mkt + COV + SKEW + KURT)
    M.3: Combined (all seven)
    Up/down market segmentation.
    """
    print(f"\n{'='*65}")
    print(f"Fama-MacBeth Test: {label}")
    print(f"{'='*65}")

    # Normalise all indices
    port_df  = norm_idx(port_df)
    factors_monthly = norm_idx(factors_monthly)
    ff_monthly = norm_idx(ff_monthly)

    # Align
    common = port_df.index.intersection(factors_monthly.index)\
                           .intersection(ff_monthly.index)
    common = common.sort_values()

    if len(common) < loading_window + 12:
        print(f"  Insufficient data: {len(common)} months")
        return

    P = port_df.loc[common]       # N portfolios × T months
    F = factors_monthly.loc[common]  # COV, SKEW, KURT
    G = ff_monthly.loc[common] / 100  # Mkt-RF, SMB, HML, MOM, RF

    rf_m = G['RF']
    mkt  = G['Mkt-RF']
    smb  = G['SMB']
    hml  = G['HML']
    umd  = G.get('MOM', pd.Series(0., index=common))
    cov  = F['COV']
    skew = F['SKEW']
    kurt = F['KURT']

    T = len(common)
    N = P.shape[1]
    print(f"  Portfolios: {N}, Months: {T}")
    print(f"  Period: {common[0].date()} to {common[-1].date()}")

    # ── Rolling time-series regressions ──────────────────────────────────
    # For each month t, estimate loadings using [t-loading_window, t-1]
    # Then use those loadings to predict return at t

    def get_factors_matrix(t_end_idx, model):
        """Get factor matrix for loading estimation window."""
        t_start = max(0, t_end_idx - loading_window)
        sl = slice(t_start, t_end_idx)
        if model == 'M1':
            return np.column_stack([
                mkt.iloc[sl], smb.iloc[sl], hml.iloc[sl], umd.iloc[sl]])
        elif model == 'M2':
            return np.column_stack([
                mkt.iloc[sl], cov.iloc[sl], skew.iloc[sl], kurt.iloc[sl]])
        elif model == 'M3':
            return np.column_stack([
                mkt.iloc[sl], cov.iloc[sl], skew.iloc[sl], kurt.iloc[sl],
                smb.iloc[sl], hml.iloc[sl], umd.iloc[sl]])

    # Collect cross-sectional observations
    cs_obs = {m: {'lambdas': [], 'r2s': [], 'dates': []}
              for m in ['M1','M2','M3']}

    for t_idx in range(loading_window, T):
        t_date = common[t_idx]

        # Market state: up or down?
        mkt_up = float(mkt.iloc[t_idx]) > 0

        for model in ['M1','M2','M3']:
            # Estimate loadings for each portfolio
            betas = {}
            for port in P.columns:
                y = (P[port].iloc[max(0,t_idx-loading_window):t_idx]
                     - rf_m.iloc[max(0,t_idx-loading_window):t_idx]).values
                X_ts = get_factors_matrix(t_idx, model)
                valid = np.isfinite(y) & np.all(np.isfinite(X_ts), axis=1)
                if valid.sum() < loading_window // 2:
                    continue
                try:
                    reg = sm.OLS(y[valid], sm.add_constant(X_ts[valid])).fit()
                    betas[port] = reg.params[1:]  # exclude intercept
                except:
                    continue

            if len(betas) < max(N // 2, 5):
                continue

            # Cross-sectional regression at month t
            ports_with_betas = list(betas.keys())
            Y_cs = (P[ports_with_betas].iloc[t_idx]
                    - rf_m.iloc[t_idx]).values
            X_cs = np.array([betas[p] for p in ports_with_betas])

            valid_cs = np.isfinite(Y_cs) & np.all(np.isfinite(X_cs), axis=1)
            if valid_cs.sum() < 5:
                continue

            try:
                reg_cs = sm.OLS(Y_cs[valid_cs],
                                sm.add_constant(X_cs[valid_cs])).fit()
                lambdas = reg_cs.params[1:]  # slope estimates
                cs_obs[model]['lambdas'].append(
                    (lambdas, mkt_up, t_date))
                cs_obs[model]['r2s'].append(reg_cs.rsquared)
            except:
                continue

    # ── Report results ────────────────────────────────────────────────────
    factor_names = {
        'M1': ['Mkt-RF','SMB','HML','UMD'],
        'M2': ['Mkt-RF','COV','SKEW','KURT'],
        'M3': ['Mkt-RF','COV','SKEW','KURT','SMB','HML','UMD'],
    }
    model_labels = {
        'M1': 'M.1 F&F 4-factor',
        'M2': 'M.2 Four-moment CAPM',
        'M3': 'M.3 Combined',
    }

    for model in ['M1','M2','M3']:
        obs = cs_obs[model]['lambdas']
        if not obs:
            print(f"\n  {model_labels[model]}: no observations")
            continue

        all_lambdas = np.array([o[0] for o in obs])
        up_lambdas  = np.array([o[0] for o in obs if o[1]])
        dn_lambdas  = np.array([o[0] for o in obs if not o[1]])
        mean_r2 = np.mean(cs_obs[model]['r2s'])

        fnames = factor_names[model]
        print(f"\n  {model_labels[model]}  "
              f"(N={len(obs)}, R²={mean_r2:.3f})")
        print(f"  {'Factor':<10} {'Total':>8} {'t':>6} "
              f"{'Up':>8} {'t':>6} {'Down':>8} {'t':>6}")
        print("  " + "-"*58)

        for j, fname in enumerate(fnames):
            def fm_stat(arr):
                if len(arr) < 3:
                    return np.nan, np.nan
                col = arr[:, j]
                col = col[np.isfinite(col)]
                if len(col) < 3:
                    return np.nan, np.nan
                m = np.mean(col)
                se = np.std(col, ddof=1) / np.sqrt(len(col))
                return m*100, m/se if se>0 else np.nan

            m_all, t_all = fm_stat(all_lambdas)
            m_up,  t_up  = fm_stat(up_lambdas)
            m_dn,  t_dn  = fm_stat(dn_lambdas)

            def sig(t):
                if not np.isfinite(t): return ''
                return '***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                       else ('*' if abs(t)>1.65 else ''))

            print(f"  {fname:<10} {m_all:>+8.3f}{sig(t_all):3s} "
                  f"{m_up:>+8.3f}{sig(t_up):3s} "
                  f"{m_dn:>+8.3f}{sig(t_dn):3s}")

        print(f"  (in %; *** p<1%, ** p<5%, * p<10%)")


# ── Mediation analysis ───────────────────────────────────────────────────────

def mediation_analysis(port_df, factors_monthly, ff_monthly,
                       loading_window=LOADING_MONTHS, label=''):
    """
    Tests whether comoment factors mediate FF factor premiums.
    Part 1: Time-series regression of FF factor returns on comoment factors.
    Part 2: Fama-MacBeth lambda shrinkage M.1 vs M.3.
    LH finding: complementary, not substitutes.
    """
    print(f"\n{'='*65}")
    print(f"Mediation Analysis: {label}")
    print(f"{'='*65}")

    port_df  = norm_idx(port_df)
    factors_monthly = norm_idx(factors_monthly)
    ff_monthly = norm_idx(ff_monthly)

    common = port_df.index.intersection(factors_monthly.index)\
                           .intersection(ff_monthly.index)
    common = common.sort_values()
    F = factors_monthly.loc[common]
    G = ff_monthly.loc[common] / 100
    rf = G['RF']
    P  = port_df.loc[common]
    T  = len(common)

    cm_idx = F['COV'].dropna().index\
                              .intersection(F['SKEW'].dropna().index)\
                              .intersection(F['KURT'].dropna().index)
    X_cm = sm.add_constant(pd.DataFrame({
        'COV': F['COV'].loc[cm_idx],
        'SKEW': F['SKEW'].loc[cm_idx],
        'KURT': F['KURT'].loc[cm_idx]}))

    def sig(t):
        if not np.isfinite(t): return ''
        return '***' if abs(t)>2.58 else ('**' if abs(t)>1.96
               else ('*' if abs(t)>1.65 else ''))

    # Part 1
    print(f"\n── Part 1: FF Factor Returns on Comoment Factors ────────────")
    print(f"  {'Factor':<10} {'α%':>8} {'β_COV':>8} {'t':>5} "
          f"{'β_SKEW':>8} {'t':>5} {'β_KURT':>8} {'t':>5} {'R²':>6}")
    print("  " + "-"*70)
    for fname, fseries in [
            ('Mkt-RF', G['Mkt-RF']), ('SMB', G['SMB']),
            ('HML',    G['HML']),
            ('UMD',    G.get('MOM', pd.Series(0., index=common)))]:
        y = fseries.loc[cm_idx]
        valid = np.isfinite(y.values) & np.all(np.isfinite(X_cm.values), axis=1)
        if valid.sum() < 60: continue
        try:
            reg = sm.OLS(y.values[valid], X_cm.values[valid]).fit(
                cov_type='HAC', cov_kwds={'maxlags': 12})
            a = reg.params[0]*100
            bc,tc = reg.params[1],reg.tvalues[1]
            bs,ts = reg.params[2],reg.tvalues[2]
            bk,tk = reg.params[3],reg.tvalues[3]
            print(f"  {fname:<10} {a:>+8.3f} "
                  f"{bc:>+8.4f}{sig(tc):3s} "
                  f"{bs:>+8.4f}{sig(ts):3s} "
                  f"{bk:>+8.4f}{sig(tk):3s} "
                  f"{reg.rsquared:>6.3f}")
        except Exception as e:
            print(f"  {fname:<10} ERROR: {e}")

    # Part 2: lambda shrinkage
    print(f"\n── Part 2: FF Premium Shrinkage (M.1 → M.3) ────────────────")

    def get_Xf(t_end, model):
        sl = slice(max(0, t_end-loading_window), t_end)
        mkt  = G['Mkt-RF'].iloc[sl].values
        smb  = G['SMB'].iloc[sl].values
        hml  = G['HML'].iloc[sl].values
        umd  = G.get('MOM', pd.Series(0.,index=common)).iloc[sl].values
        cov_ = F['COV'].iloc[sl].values
        sk_  = F['SKEW'].iloc[sl].values
        ku_  = F['KURT'].iloc[sl].values
        if model == 'M1': return np.column_stack([mkt,smb,hml,umd])
        return np.column_stack([mkt,cov_,sk_,ku_,smb,hml,umd])

    lam1, lam3 = [], []
    for t_idx in range(loading_window, T):
        for model, llist in [('M1',lam1),('M3',lam3)]:
            betas = {}
            for port in P.columns:
                y_ts = (P[port].iloc[max(0,t_idx-loading_window):t_idx]
                        - rf.iloc[max(0,t_idx-loading_window):t_idx]).values
                Xts = get_Xf(t_idx, model)
                ok = np.isfinite(y_ts) & np.all(np.isfinite(Xts),axis=1)
                if ok.sum() < loading_window//2: continue
                try:
                    r = sm.OLS(y_ts[ok], sm.add_constant(Xts[ok])).fit()
                    betas[port] = r.params[1:]
                except: continue
            if len(betas) < max(P.shape[1]//2,5): continue
            ports = list(betas.keys())
            Ycs = (P[ports].iloc[t_idx] - rf.iloc[t_idx]).values
            Xcs = np.array([betas[p] for p in ports])
            okcs = np.isfinite(Ycs) & np.all(np.isfinite(Xcs),axis=1)
            if okcs.sum() < 5: continue
            try:
                r = sm.OLS(Ycs[okcs], sm.add_constant(Xcs[okcs])).fit()
                llist.append(r.params[1:])
            except: continue

    def fmstat(ll, j):
        arr = np.array([l[j] for l in ll if len(l)>j and np.isfinite(l[j])])
        if len(arr)<3: return np.nan, np.nan
        m = np.mean(arr); se = np.std(arr,ddof=1)/np.sqrt(len(arr))
        return m*100, m/se if se>0 else np.nan

    print(f"  {'Factor':<10} {'M.1 λ%':>9} {'':>4} "
          f"{'M.3 λ%':>9} {'':>4} {'Shrinkage':>10}")
    print("  " + "-"*55)
    for fname,p1,p3 in [('Mkt-RF',0,0),('SMB',1,4),('HML',2,5),('UMD',3,6)]:
        m1,t1 = fmstat(lam1,p1); m3,t3 = fmstat(lam3,p3)
        sh = (m1-m3)/m1*100 if np.isfinite(m1) and abs(m1)>1e-6 else np.nan
        print(f"  {fname:<10} {m1:>+9.3f}{sig(t1):3s} "
              f"{m3:>+9.3f}{sig(t3):3s} {sh:>+9.1f}%")

    print(f"\n  Comoment premia in M.3:")
    for fname,pos in [('COV',1),('SKEW',2),('KURT',3)]:
        m3,t3 = fmstat(lam3,pos)
        print(f"  {fname:<10} {m3:>+9.3f}{sig(t3)}")


# ── Shared stock-level comoment panel ────────────────────────────────────────

def build_comoment_panel(stock_returns, ff_factors,
                          window=LOOKBACK_MONTHS,
                          step=1,
                          cache_file='lh_comoment_panel.csv'):
    """
    Builds a panel of comoment estimates for every stock at every month.
    Estimated using a rolling backward window of `window` months.
    step=1 → monthly (used by factor construction)
    step=3 → quarterly (faster, used by persistence analysis)

    Caches to CSV. This is the shared computation reused by:
    - Persistence analysis
    - Forward-backward comparison
    - Triple sort (backward and forward variants)

    Returns DataFrame with MultiIndex (date, ticker) and columns:
    [beta, coskew, cokurt]
    """
    cache = Path(cache_file)
    if cache.exists():
        print(f"  Loading comoment panel from {cache_file}...")
        df = pd.read_csv(cache, parse_dates=['date'])
        print(f"  ✓ {len(df):,} obs, "
              f"{df['date'].nunique()} dates, "
              f"{df['ticker'].nunique()} stocks")
        return df

    print(f"  Building comoment panel (step={step}m, window={window}m)...")
    rm = ff_factors['Mkt-RF'] / 100
    rf = ff_factors['RF']     / 100

    sr_idx = stock_returns.index.to_period('M').to_timestamp('M')
    SR = stock_returns.copy(); SR.index = sr_idx
    common = SR.index.intersection(ff_factors.index)
    SR = SR.loc[common]
    rm = rm.loc[common]; rf = rf.loc[common]

    dates = SR.index[window::step]
    records = []

    for i, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)
        rm_lb = rm.iloc[t_pos-window:t_pos].values
        rf_lb = rf.iloc[t_pos-window:t_pos].values
        rm_bar = float(rm_lb.mean())
        rm_exc = rm_lb - rf_lb.mean()

        for ticker in SR.columns:
            ri = SR[ticker].iloc[t_pos-window:t_pos].values - rf_lb
            cm = estimate_comoments_lh(ri, rm_exc, rm_bar)
            if cm is not None:
                records.append({
                    'date':   t,
                    'ticker': ticker,
                    'beta':   cm['beta'],
                    'coskew': cm['coskew'],
                    'cokurt': cm['cokurt'],
                })

        if (i+1) % 20 == 0:
            print(f"    {i+1}/{len(dates)} dates, "
                  f"{len(records):,} records so far...")

    df = pd.DataFrame(records)
    df.to_csv(cache, index=False)
    print(f"  ✓ Saved {len(df):,} obs to {cache_file}")
    return df


# ── Forward-window comoment estimation ───────────────────────────────────────

def build_forward_comoments(stock_returns, ff_factors,
                             forward=LOOKBACK_MONTHS,
                             backward=LOOKBACK_MONTHS):
    """
    For each month t, estimate comoments from FORWARD window [t, t+forward]
    then demean by subtracting backward-window comoment estimate.

    The demeaned forward comoment is:
        CS_fwd_dm_i,t = CS_fwd_i,t - CS_back_i,t

    This is orthogonal to the forward mean return by construction
    (central moments are invariant to location shifts).

    The hypothesis: if markets efficiently price expected comoments,
    forward-window demeaned comoments should predict returns better
    than backward-window comoments because:
    1. They capture the actually-realised distributional shape
    2. They are demeaned so contain no look-ahead bias from mean returns
    3. If comoments are persistent, forward ≈ expected comoment

    Returns: DataFrame with columns [beta_fwd_dm, coskew_fwd_dm, cokurt_fwd_dm]
             indexed by month t, for each stock
             (stored as panel: MultiIndex [date, ticker])
    """
    rm = ff_factors['Mkt-RF'] / 100
    rf = ff_factors['RF']     / 100

    sr_idx = stock_returns.index.to_period('M').to_timestamp('M')
    SR = stock_returns.copy(); SR.index = sr_idx

    common = SR.index.intersection(ff_factors.index)
    SR = SR.loc[common]
    rm = rm.loc[common]; rf = rf.loc[common]

    T = len(common)
    dates = SR.index[backward:T-forward]

    print(f"\n  Computing forward-window demeaned comoments...")
    print(f"  {len(dates)} months with both lookback and forward windows")

    records = []
    for i, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)

        # Backward window: [t-backward, t)
        lb_s = t_pos - backward; lb_e = t_pos
        rm_back = rm.iloc[lb_s:lb_e]
        rf_back = rf.iloc[lb_s:lb_e]
        rm_bar_back = float(rm_back.mean())

        # Forward window: [t, t+forward)
        fwd_s = t_pos; fwd_e = t_pos + forward
        rm_fwd = rm.iloc[fwd_s:fwd_e]
        rf_fwd = rf.iloc[fwd_s:fwd_e]
        rm_bar_fwd = float(rm_fwd.mean())

        for ticker in SR.columns:
            # Backward comoment
            ri_back = SR[ticker].iloc[lb_s:lb_e].values - rf_back.values
            cm_back = estimate_comoments_lh(ri_back,
                                            rm_back.values - rf_back.values.mean(),
                                            rm_bar_back)
            if cm_back is None:
                continue

            # Forward comoment
            ri_fwd = SR[ticker].iloc[fwd_s:fwd_e].values - rf_fwd.values
            cm_fwd = estimate_comoments_lh(ri_fwd,
                                           rm_fwd.values - rf_fwd.values.mean(),
                                           rm_bar_fwd)
            if cm_fwd is None:
                continue

            # Demeaned forward comoments
            records.append({
                'date':        t,
                'ticker':      ticker,
                'coskew_back': cm_back['coskew'],
                'cokurt_back': cm_back['cokurt'],
                'beta_back':   cm_back['beta'],
                'coskew_fwd':  cm_fwd['coskew'],
                'cokurt_fwd':  cm_fwd['cokurt'],
                'beta_fwd':    cm_fwd['beta'],
                # Forward mean excess return — orthogonal to comoments
                # because comoments are central moments (mean-free)
                'fwd_mean_exc': float(np.nanmean(ri_fwd)) * 12,
            })

        if (i+1) % 50 == 0:
            print(f"    {i+1}/{len(dates)} months processed...")

    df = pd.DataFrame(records)
    print(f"  ✓ {len(df)} stock-month observations")
    return df


def compare_forward_backward(panel_df, label=''):
    """
    Compare predictive power of forward vs backward demeaned comoments.

    Tests cross-sectional correlation of each measure with forward returns.
    If forward-window measures have higher absolute correlation, it supports
    the hypothesis that they better capture market expectations.
    """
    print(f"\n{'='*65}")
    print(f"Forward vs Backward Comoment Comparison: {label}")
    print(f"{'='*65}")

    df = panel_df.dropna(subset=['fwd_mean_exc','coskew_fwd',
                                  'coskew_back','cokurt_fwd','cokurt_back'])
    if len(df) < 100:
        print("  Insufficient data")
        return

    print(f"  N = {len(df)} stock-month obs across "
          f"{df['date'].nunique()} dates")

    print(f"\n  Cross-sectional correlations with forward excess return:")
    print(f"  {'Measure':<25} {'Corr':>8} {'Interpretation'}")
    print("  " + "-"*60)

    measures = [
        ('coskew_back',   'Backward coskew (LH)'),
        ('coskew_fwd_dm', 'Forward demeaned coskew'),
        ('coskew_fwd',    'Raw forward coskew (biased)'),
        ('cokurt_back',   'Backward cokurt (LH)'),
        ('cokurt_fwd_dm', 'Forward demeaned cokurt'),
        ('cokurt_fwd',    'Raw forward cokurt (biased)'),
        ('beta_fwd_dm',   'Forward demeaned beta'),
    ]

    for col, label_m in measures:
        if col not in df.columns: continue
        # Fama-MacBeth style: mean of cross-sectional correlations
        cs_corrs = []
        for d, grp in df.groupby('date'):
            if len(grp) < 20: continue
            c = grp[[col,'fwd_mean_exc']].dropna()
            if len(c) < 20: continue
            corr = np.corrcoef(c[col], c['fwd_mean_exc'])[0,1]
            cs_corrs.append(corr)
        if not cs_corrs: continue
        mean_corr = np.mean(cs_corrs)
        t = mean_corr / (np.std(cs_corrs,ddof=1)/np.sqrt(len(cs_corrs)))
        sig = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
               else ('*' if abs(t)>1.65 else '')))
        bias_note = '← look-ahead (mean)' if 'fwd' in col and 'dm' not in col                     else ('← clean' if 'dm' in col else '')
        print(f"  {label_m:<25} {mean_corr:>+8.4f}{sig:3s}  {bias_note}")

    # Fama-MacBeth regression comparison
    print(f"\n  Fama-MacBeth slopes (λ) for each measure:")
    print(f"  {'Measure':<25} {'λ':>10} {'t':>8} {'sig':>5}")
    print("  " + "-"*52)

    for col, label_m in measures:
        if col not in df.columns: continue
        slopes = []
        for d, grp in df.groupby('date'):
            if len(grp) < 20: continue
            c = grp[[col,'fwd_mean_exc']].dropna()
            if len(c) < 20: continue
            try:
                X = sm.add_constant(c[[col]].values)
                reg = sm.OLS(c['fwd_mean_exc'].values, X).fit()
                slopes.append(float(reg.params[1]))
            except: pass
        if len(slopes) < 3: continue
        m = np.mean(slopes)
        t = m / (np.std(slopes,ddof=1)/np.sqrt(len(slopes)))
        sig = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
               else ('*' if abs(t)>1.65 else '')))
        print(f"  {label_m:<25} {m:>+10.4f} {t:>+8.2f} {sig:>5}")

    # Persistence check: are comoments stable enough for forward≈backward?
    print(f"\n  Comoment persistence (corr between backward and forward):")
    for b_col, f_col, name in [
            ('coskew_back','coskew_fwd','Coskewness'),
            ('cokurt_back','cokurt_fwd','Cokurtosis')]:
        if b_col not in df.columns: continue
        c = df[[b_col,f_col]].dropna()
        if len(c) < 50: continue
        corr = np.corrcoef(c[b_col], c[f_col])[0,1]
        print(f"  {name:<15} corr(back, fwd) = {corr:+.4f}")
    print(f"  (High persistence → forward ≈ backward → both equally valid)")
    print(f"  (Low persistence → market conditions change → forward adds info)")




def persistence_analysis(stock_returns, ff_factors, label=""):
    print(f"\n{'='*65}")
    print(f"Comoment Persistence Analysis: {label}")
    print(f"{'='*65}")

    rm = ff_factors["Mkt-RF"] / 100
    rf = ff_factors["RF"]     / 100

    sr_idx = stock_returns.index.to_period("M").to_timestamp("M")
    SR = stock_returns.copy(); SR.index = sr_idx
    common = SR.index.intersection(ff_factors.index)
    SR = SR.loc[common]; rm = rm.loc[common]; rf = rf.loc[common]
    T = len(common)
    window = 36

    print(f"  Estimating stock-level comoments at quarterly intervals...")
    coskew_panel = {}
    cokurt_panel = {}
    dates_est = SR.index[window:]
    sample_dates = dates_est[::3]  # every 3 months

    for i, t in enumerate(sample_dates):
        t_pos = SR.index.get_loc(t)
        rm_lb = rm.iloc[t_pos-window:t_pos].values
        rf_lb = rf.iloc[t_pos-window:t_pos].values
        rm_bar = float(rm_lb.mean())
        cs_t = {}; ck_t = {}
        for ticker in SR.columns:
            ri = SR[ticker].iloc[t_pos-window:t_pos].values - rf_lb
            rm_exc = rm_lb - rf_lb.mean()
            cm = estimate_comoments_lh(ri, rm_exc, rm_bar)
            if cm is not None:
                cs_t[ticker] = cm["coskew"]
                ck_t[ticker] = cm["cokurt"]
        coskew_panel[t] = cs_t
        cokurt_panel[t] = ck_t
        if (i+1) % 20 == 0:
            print(f"    {i+1}/{len(sample_dates)} dates...")

    sorted_dates = sorted(coskew_panel.keys())
    cs_df = pd.DataFrame(coskew_panel).T.sort_index()
    ck_df = pd.DataFrame(cokurt_panel).T.sort_index()
    date_idx = cs_df.index.tolist()
    step = 3

    def trim_outliers(a, b, pct=1):
        lo = np.percentile(a, pct); hi = np.percentile(a, 100-pct)
        lo2 = np.percentile(b, pct); hi2 = np.percentile(b, 100-pct)
        mask = (a>=lo)&(a<=hi)&(b>=lo2)&(b<=hi2)
        return a[mask], b[mask]

    # Stock-level autocorrelations
    print(f"\n-- Stock-level Comoment Persistence --")
    print(f"  corr(comoment_t, comoment_t+h) across all stocks")
    print(f"  Horizon    CS corr    CK corr   n_pairs")
    print("  " + "-"*42)

    for lag_months in [3, 6, 12, 24, 36]:
        lag_steps = lag_months // step
        if lag_steps >= len(date_idx): continue
        cs_corrs = []; ck_corrs = []
        for i in range(len(date_idx) - lag_steps):
            t0 = date_idx[i]; t1 = date_idx[i+lag_steps]
            tickers = list(set(coskew_panel[t0].keys()) &
                           set(coskew_panel[t1].keys()))
            if len(tickers) < 50: continue
            cs0 = np.array([coskew_panel[t0][tk] for tk in tickers])
            cs1 = np.array([coskew_panel[t1][tk] for tk in tickers])
            ck0 = np.array([cokurt_panel[t0][tk] for tk in tickers])
            ck1 = np.array([cokurt_panel[t1][tk] for tk in tickers])
            a,b = trim_outliers(cs0,cs1); c,d = trim_outliers(ck0,ck1)
            if len(a)>30: cs_corrs.append(np.corrcoef(a,b)[0,1])
            if len(c)>30: ck_corrs.append(np.corrcoef(c,d)[0,1])
        cs_m = np.mean(cs_corrs) if cs_corrs else np.nan
        ck_m = np.mean(ck_corrs) if ck_corrs else np.nan
        print(f"  {lag_months:>6}m   {cs_m:>+9.4f}  {ck_m:>+9.4f}  {len(cs_corrs):>8}")

    # Rank stability
    print(f"\n-- Cross-sectional Rank Stability --")
    print(f"  Fraction of stocks staying in same coskewness quintile")
    print(f"  Horizon   Stay rate   vs random(20%)")
    print("  " + "-"*36)

    for lag_months in [3, 6, 12, 24, 36]:
        lag_steps = lag_months // step
        if lag_steps >= len(date_idx): continue
        stay_rates = []
        for i in range(len(date_idx)-lag_steps):
            t0 = date_idx[i]; t1 = date_idx[i+lag_steps]
            tickers = list(set(coskew_panel[t0].keys()) &
                           set(coskew_panel[t1].keys()))
            if len(tickers)<50: continue
            cs0 = np.array([coskew_panel[t0][tk] for tk in tickers])
            cs1 = np.array([coskew_panel[t1][tk] for tk in tickers])
            try:
                q0 = pd.qcut(cs0, 5, labels=False, duplicates="drop")
                q1 = pd.qcut(cs1, 5, labels=False, duplicates="drop")
                valid = ~(pd.isna(q0)|pd.isna(q1))
                if valid.sum()<20: continue
                stay_rates.append(np.mean(
                    np.array(q0)[valid]==np.array(q1)[valid]))
            except: continue
        if stay_rates:
            m = np.mean(stay_rates)
            print(f"  {lag_months:>6}m   {m:>9.3f}   {m-0.20:>+12.3f}")

    # Portfolio-level persistence
    print(f"\n-- Portfolio-level Persistence --")
    print(f"  Corr of quintile-portfolio coskews across dates")
    print(f"  Horizon   Port rank corr")
    print("  " + "-"*26)

    port_cs_panel = {}
    for t in sorted_dates:
        tickers = list(coskew_panel[t].keys())
        if len(tickers)<50: continue
        cs_vals = np.array([coskew_panel[t][tk] for tk in tickers])
        try:
            q = pd.qcut(cs_vals, 5, labels=False, duplicates="drop")
            port_cs = [np.mean(cs_vals[np.array(q)==i])
                       if (np.array(q)==i).sum()>0 else np.nan
                       for i in range(5)]
            if not any(np.isnan(port_cs)):
                port_cs_panel[t] = port_cs
        except: continue

    port_dates = sorted(port_cs_panel.keys())
    for lag_months in [3, 6, 12, 24, 36]:
        lag_steps = lag_months // step
        if lag_steps >= len(port_dates): continue
        corrs = []
        for i in range(len(port_dates)-lag_steps):
            t0 = port_dates[i]; t1 = port_dates[i+lag_steps]
            corr = np.corrcoef(port_cs_panel[t0], port_cs_panel[t1])[0,1]
            if np.isfinite(corr): corrs.append(corr)
        if corrs:
            print(f"  {lag_months:>6}m   {np.mean(corrs):>+14.4f}")

    print(f"\n  If stock-level persistence is near zero but portfolio-level")
    print(f"  is higher, the premium reflects systematic sector/industry")
    print(f"  coskewness persisting at the aggregate level.")


# ── Forward triple sort factor ───────────────────────────────────────────────

def build_forward_triple_sort_factors(stock_returns, ff_factors,
                                       backward_panel_df,
                                       window=LOOKBACK_MONTHS):
    """
    Replicates the LH triple sort factor construction using FORWARD
    comoment estimates instead of backward.

    For each month t:
    1. Estimate comoments from FORWARD window [t, t+window]
    2. Triple sort stocks using these forward estimates
    3. Compute factor return for month t+window (the month after
       the forward estimation period ends)

    Exact forward flip of LH:
    LH backward: comoments from [t-36, t), return at t+1
    Forward flip: comoments from [t+1, t+37), return at t+1

    Both tests predict the same month t+1 using windows of equal
    length on opposite sides of the target return.

    Prediction: if LH premium reflects backward-estimated risk,
    forward comoments (uncorrelated with backward at 36m) should
    produce zero premium — confirming the market prices historically
    estimated risk, not the distributional shape that will realise.

    Returns: DataFrame with COV_fwd, SKEW_fwd, KURT_fwd monthly returns
    """
    print(f"\n  Building forward triple-sort factors...")

    rm = ff_factors['Mkt-RF'] / 100
    rf = ff_factors['RF']     / 100

    sr_idx = stock_returns.index.to_period('M').to_timestamp('M')
    SR = stock_returns.copy(); SR.index = sr_idx
    common = SR.index.intersection(ff_factors.index)
    SR = SR.loc[common]; rm = rm.loc[common]; rf = rf.loc[common]
    T = len(common)

    # LH backward: comoments from [t-window, t), return at t+1
    # Forward flip: comoments from [t+1, t+1+window), return at t+1
    # Both predict the SAME month t+1, from opposite sides.
    # t+1 ranges from window+1 to T-window-1
    # i.e. t (the comoment start for forward) ranges from window to T-window-2
    dates = SR.index[window:T-window-1]

    cov_rets  = []; skew_rets = []; kurt_rets = []
    factor_dates = []

    for i, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)

        # Forward window: [t+1, t+1+window) — comoment estimation
        # Starts the month AFTER the return month
        fwd_s = t_pos + 1
        fwd_e = t_pos + 1 + window
        if fwd_e > T:
            continue
        rm_fwd = rm.iloc[fwd_s:fwd_e].values
        rf_fwd = rf.iloc[fwd_s:fwd_e].values
        rm_bar_fwd = float(rm_fwd.mean())
        rm_exc_fwd = rm_fwd - rf_fwd.mean()

        # Return month: t+1 — same target as LH backward factor
        ret_pos = t_pos + 1
        next_rets = SR.iloc[ret_pos]

        # Estimate forward comoments
        comoments = {}
        for ticker in SR.columns:
            ri_fwd = SR[ticker].iloc[fwd_s:fwd_e].values - rf_fwd
            cm = estimate_comoments_lh(ri_fwd, rm_exc_fwd, rm_bar_fwd)
            if cm is not None:
                comoments[ticker] = cm

        if len(comoments) < N_GROUPS**3 * 5:
            cov_rets.append(np.nan); skew_rets.append(np.nan)
            kurt_rets.append(np.nan)
            factor_dates.append(SR.index[ret_pos])  # return at t+1
            continue

        cm_df = pd.DataFrame(comoments).T[['beta','coskew','cokurt']]
        cm_df = cm_df.replace([np.inf,-np.inf], np.nan).dropna()

        skew_f = triple_sort_factor(next_rets, cm_df,
                                    dim_order=['beta','cokurt','coskew'])
        if np.isfinite(skew_f): skew_f = -skew_f

        kurt_f = triple_sort_factor(next_rets, cm_df,
                                    dim_order=['beta','coskew','cokurt'])
        cov_f  = triple_sort_factor(next_rets, cm_df,
                                    dim_order=['coskew','cokurt','beta'])

        cov_rets.append(cov_f); skew_rets.append(skew_f)
        kurt_rets.append(kurt_f)
        factor_dates.append(SR.index[ret_pos])

        if (i+1) % 50 == 0:
            n_v = sum(1 for x in skew_rets if np.isfinite(x))
            print(f"    {i+1}/{len(dates)} months, {n_v} valid...")

    idx = pd.DatetimeIndex(factor_dates).to_period('M').to_timestamp('M')
    factors_fwd = pd.DataFrame({
        'COV_fwd':  cov_rets,
        'SKEW_fwd': skew_rets,
        'KURT_fwd': kurt_rets,
    }, index=idx)

    print(f"\n  Forward factor summary:")
    for col in factors_fwd.columns:
        s = factors_fwd[col].dropna()
        if len(s):
            t = s.mean()/(s.std(ddof=1)/np.sqrt(len(s)))
            print(f"    {col}: N={len(s)} mean={s.mean()*100:+.3f}% t={t:+.2f}")

    return factors_fwd


def compare_forward_backward_factors(factors_back, factors_fwd, ff_factors,
                                      port25, port100):
    """
    Compare backward vs forward triple-sort factors:
    1. Raw factor premiums
    2. Correlation between forward and backward factors
    3. Fama-MacBeth on 25/100 portfolios using forward factors

    If forward factors have zero correlation with backward factors
    but similar premiums, it suggests the LH premium is contemporaneous
    rather than predictive — a fundamental reinterpretation.
    """
    print(f"\n{'='*65}")
    print(f"Backward vs Forward Triple-Sort Factor Comparison")
    print(f"{'='*65}")

    # Align
    common = factors_back.index.intersection(factors_fwd.index)
    fb = factors_back.loc[common]
    ff_fwd = factors_fwd.loc[common]

    print(f"\n  Factor premiums (N={len(common)} overlapping months):")
    print(f"  {'Factor':<14} {'Mean%':>8} {'t':>7} {'LH Mean%':>10}")
    lh_ref = {'COV':0.18,'SKEW':0.27,'KURT':0.14}
    for b_col, f_col in [('COV','COV_fwd'),('SKEW','SKEW_fwd'),
                          ('KURT','KURT_fwd')]:
        sb = fb[b_col].dropna(); sf = ff_fwd[f_col].dropna()
        name = b_col
        for s, label in [(sb,'backward'),(sf,'forward ')]:
            if len(s) < 3: continue
            t = s.mean()/(s.std(ddof=1)/np.sqrt(len(s)))
            sig = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                   else ('*' if abs(t)>1.65 else '')))
            lh = lh_ref.get(name, np.nan)
            print(f"  {name} {label}  {s.mean()*100:>+8.3f}{sig:3s} "
                  f"{t:>+6.2f}  {lh:>10.2f}")

    # Validate date ranges are actually different
    print(f"\n  Date range validation:")
    print(f"  Backward factors: {factors_back.index[0].date()} "
          f"to {factors_back.index[-1].date()}")
    print(f"  Forward factors:  {factors_fwd.index[0].date()} "
          f"to {factors_fwd.index[-1].date()}")

    # Validation: end dates should differ (forward loses last 36 months)
    if factors_back.index[-1] == factors_fwd.index[-1]:
        print(f"\n  WARNING: Forward and backward factors have identical")
        print(f"  end dates — this suggests the forward factor is using")
        print(f"  the same data as backward. Delete lh_forward_factors.csv.")
        return
    print(f"  ✓ End dates differ as expected "
          f"(forward ends {factors_fwd.index[-1].date()}, "
          f"backward ends {factors_back.index[-1].date()})")

    print(f"\n  Correlations between forward and backward factors:")
    print(f"  (Should be near zero given ~0 stock-level persistence at 36m)")
    for b_col, f_col in [('COV','COV_fwd'),('SKEW','SKEW_fwd'),
                          ('KURT','KURT_fwd')]:
        common2 = fb[b_col].dropna().index.intersection(
                  ff_fwd[f_col].dropna().index)
        if len(common2) < 10: continue
        corr = np.corrcoef(fb[b_col].loc[common2],
                           ff_fwd[f_col].loc[common2])[0,1]
        print(f"  corr({b_col}_back, {f_col}) = {corr:+.4f}")

    print(f"\n  Interpretation:")
    print(f"  High corr → forward ≈ backward → same information")
    print(f"  Zero corr + similar premium → independent pricing channels")
    print(f"  Zero corr + zero forward premium → backward is the priced signal")

    # Quick Fama-MacBeth for forward factors on 25 portfolios
    if port25 is not None:
        print(f"\n  Fama-MacBeth on 25 BTM portfolios using FORWARD factors:")
        fama_macbeth_lh(port25, ff_fwd.rename(columns={
            'COV_fwd':'COV','SKEW_fwd':'SKEW','KURT_fwd':'KURT'}),
            ff_factors, loading_window=LOADING_MONTHS,
            label="25 BTM — Forward factors")


# ── Portfolio sort comparison: forward vs backward comoments ─────────────────

def portfolio_sort_comparison(fwd_panel, ff_factors, label=''):
    """
    Sorts stocks into quintile portfolios based on:
    (A) backward coskewness/cokurtosis (LH standard)
    (B) forward coskewness/cokurtosis

    Measures the return spread (Q1 - Q5) for each sort.

    Prediction: if corr(forward, backward) ≈ 0 and backward predicts
    returns, then forward sort should produce zero spread.

    This is the clean falsifiable test of whether the LH premium
    is driven by information in backward comoments that the market
    prices as a risk premium, or whether it reflects something
    about the stocks that happen to have extreme comoments in any
    given period regardless of direction.
    """
    print(f"\n{'='*65}")
    print(f"Portfolio Sort Comparison: Forward vs Backward Comoments")
    print(f"({label})")
    print(f"{'='*65}")
    print(f"  Prediction: forward sort → zero spread (uncorrelated with backward)")
    print(f"  LH result:  backward sort → significant spread")

    df = fwd_panel.dropna(subset=['coskew_back','coskew_fwd',
                                   'cokurt_back','cokurt_fwd',
                                   'fwd_mean_exc'])
    dates = sorted(df['date'].unique())
    print(f"\n  N = {len(df)} obs, {len(dates)} dates")

    # For each date, sort stocks into quintiles on each measure
    # compute Q1 - Q5 equal-weighted spread return

    results = {
        'coskew_back': [], 'coskew_fwd': [],
        'cokurt_back': [], 'cokurt_fwd': [],
    }

    for d in dates:
        grp = df[df['date'] == d].dropna(
            subset=['coskew_back','coskew_fwd',
                    'cokurt_back','cokurt_fwd','fwd_mean_exc'])
        if len(grp) < 50:
            continue

        ret = grp['fwd_mean_exc'].values

        for col in results.keys():
            vals = grp[col].values
            try:
                q = pd.qcut(vals, 5, labels=False, duplicates='drop')
                q = np.array(q, dtype=float)
                valid = np.isfinite(q)
                if valid.sum() < 20:
                    continue
                r_q1 = np.mean(ret[valid][q[valid] == 0])   # lowest
                r_q5 = np.mean(ret[valid][q[valid] == 4])   # highest
                if np.isfinite(r_q1) and np.isfinite(r_q5):
                    # For coskewness: low earns more → spread = Q1 - Q5
                    # For cokurtosis: high earns more → spread = Q5 - Q1
                    if 'coskew' in col:
                        results[col].append(r_q1 - r_q5)
                    else:
                        results[col].append(r_q5 - r_q1)
            except:
                continue

    print(f"\n  Return spread (annualised %) for each sort:")
    print(f"  Prediction: backward spread > 0 and significant")
    print(f"              forward spread ≈ 0 and insignificant")
    print()
    print(f"  {'Sort':<28} {'Mean%':>8} {'Std%':>8} {'t':>7} {'sig':>5} "
          f"{'N':>5}")
    print("  " + "-"*62)

    for col, spreads in results.items():
        s = np.array(spreads)
        s = s[np.isfinite(s)]
        if len(s) < 3:
            continue
        mean = np.mean(s) * 100
        std  = np.std(s, ddof=1) * 100
        t    = np.mean(s) / (np.std(s, ddof=1) / np.sqrt(len(s)))
        sig  = ('***' if abs(t)>2.58 else ('**' if abs(t)>1.96
                else ('*' if abs(t)>1.65 else '')))
        direction = 'low CS - high CS' if 'coskew' in col else 'high CK - low CK'
        window = 'backward' if 'back' in col else 'forward '
        moment = 'coskew' if 'coskew' in col else 'cokurt '
        label_str = f"{moment} {window} ({direction})"
        print(f"  {label_str:<28} {mean:>+8.3f} {std:>8.3f} "
              f"{t:>+7.2f} {sig:>5} {len(s):>5}")

    # Also show full quintile patterns for each sort
    print(f"\n  Full quintile return patterns (Q1=lowest to Q5=highest):")
    print(f"  {'Sort':<22} {'Q1':>8} {'Q2':>8} {'Q3':>8} {'Q4':>8} {'Q5':>8}")
    print("  " + "-"*62)

    for col in results.keys():
        quint_rets = {q: [] for q in range(5)}
        for d in dates:
            grp = df[df['date'] == d].dropna(
                subset=[col, 'fwd_mean_exc'])
            if len(grp) < 50: continue
            vals = grp[col].values
            ret  = grp['fwd_mean_exc'].values
            try:
                q = pd.qcut(vals, 5, labels=False, duplicates='drop')
                q = np.array(q, dtype=float)
                valid = np.isfinite(q)
                for qi in range(5):
                    mask = valid & (q == qi)
                    if mask.sum() > 0:
                        quint_rets[qi].append(np.mean(ret[mask]))
            except: continue

        means = [np.mean(quint_rets[qi])*100 if quint_rets[qi] else np.nan
                 for qi in range(5)]
        window = 'back' if 'back' in col else 'fwd '
        moment = 'CS' if 'coskew' in col else 'CK'
        lbl = f"{moment} {window}"
        print(f"  {lbl:<22} " +
              " ".join(f"{m:>+8.3f}" if np.isfinite(m) else f"{'nan':>8}"
                       for m in means))

    print(f"\n  Interpretation:")
    print(f"  Monotone pattern in backward sort → comoment is priced")
    print(f"  Flat/random pattern in forward sort → confirms forward")
    print(f"  comoments add no information beyond what is already")
    print(f"  captured by backward comoments (as predicted by their")
    print(f"  zero correlation).")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Lambert-Hübner (2013) Replication — Exact Methodology")
    print("=" * 55)

    # ── Fetch data ─────────────────────────────────────────────────────────
    print("\nFetching factor data...")
    ff = fetch_ff_factors()

    print("\nFetching test portfolios...")
    p25_cols  = [f'P{i+1}' for i in range(25)]
    p100_cols = [f'P{i+1}' for i in range(100)]

    p25 = fetch_btm_portfolios('25_Portfolios_5x5', 26, p25_cols)
    p100 = fetch_btm_portfolios('100_Portfolios_10x10', 101, p100_cols)

    print("\nLoading stock returns...")
    SR = load_stock_returns(STOCK_RETURNS_FILE)

    # ── Build monthly comoment factors ─────────────────────────────────────
    factor_cache = Path('lh_monthly_factors.csv')
    if factor_cache.exists():
        print("\nLoading cached monthly factors...")
        factors = norm_idx(pd.read_csv(
            factor_cache, index_col=0, parse_dates=True))
        print(f"  ✓ {factors.shape[0]} months loaded")
        for col in factors.columns:
            s = factors[col].dropna()
            if len(s):
                t = s.mean()/(s.std(ddof=1)/np.sqrt(len(s)))
                print(f"    {col}: N={len(s)} mean={s.mean()*100:+.3f}% t={t:+.2f}")
    else:
        print("\nBuilding monthly comoment factor portfolios...")
        print("(Following LH: 36-month rolling window, monthly rebalancing)")
        print("(Triple sequential sort: 3x3x3 = 27 portfolios, 9 spreads)")
        print("This will take ~10-15 minutes for 384 months...")
        factors = build_monthly_factors(SR, ff, lookback=LOOKBACK_MONTHS)
        factors.to_csv(factor_cache)
        print(f"\nSaved monthly factors to lh_monthly_factors.csv")

    # Factor summary stats
    print("\n── Factor Descriptive Statistics (LH Table 1 comparison) ──")
    print(f"  {'Factor':<8} {'Mean%':>8} {'Std%':>8} {'t-stat':>8} "
          f"{'LH Mean%':>10} {'LH t':>8}")
    print("  " + "-"*56)
    lh_ref = {'SKEW': (0.27, 3.23), 'KURT': (0.14, 1.43),
              'COV':  (0.18, 1.16)}
    for col in ['COV','SKEW','KURT']:
        s = factors[col].dropna()
        if len(s) > 0:
            t = s.mean() / (s.std(ddof=1)/np.sqrt(len(s)))
            lh_m, lh_t = lh_ref.get(col, (np.nan, np.nan))
            print(f"  {col:<8} {s.mean()*100:>+8.3f} {s.std()*100:>8.3f} "
                  f"{t:>+8.2f} {lh_m:>10.2f} {lh_t:>8.2f}")

    # Cross-correlations
    print("\n── Factor Cross-correlations (LH Table 2 comparison) ──")
    print("  LH reference: COV-SKEW=16.97%, COV-KURT=47.63%, SKEW-KURT=10.19%")
    fv = factors.dropna()
    if len(fv) > 10:
        corr = fv.corr() * 100
        print(f"  COV-SKEW:  {corr.loc['COV','SKEW']:+.2f}%")
        print(f"  COV-KURT:  {corr.loc['COV','KURT']:+.2f}%")
        print(f"  SKEW-KURT: {corr.loc['SKEW','KURT']:+.2f}%")

    # ── Fama-MacBeth tests ─────────────────────────────────────────────────
    if p25 is not None:
        fama_macbeth_lh(p25, factors, ff,
                        loading_window=LOADING_MONTHS,
                        label="25 Size/BTM Portfolios (LH Table 4)")

    if p100 is not None:
        fama_macbeth_lh(p100, factors, ff,
                        loading_window=LOADING_MONTHS,
                        label="100 Size/BTM Portfolios (LH Table 5)")

    # ── Persistence analysis ─────────────────────────────────────────────
    print("\nRunning persistence analysis (~5 minutes)...")
    persistence_analysis(SR, ff, label="Stooq universe")

    # ── Forward vs backward window comparison ────────────────────────────
    fwd_cache = Path('lh_forward_comoments.csv')
    if fwd_cache.exists():
        print("\nLoading cached forward comoment panel...")
        fwd_panel = pd.read_csv(fwd_cache, parse_dates=['date'])
        print(f"  ✓ {len(fwd_panel)} observations loaded")
    else:
        print("\nComputing forward-window demeaned comoments...")
        print("(This takes ~20-30 minutes for 5696 stocks × 300+ months)")
        fwd_panel = build_forward_comoments(SR, ff,
                                            forward=LOOKBACK_MONTHS,
                                            backward=LOOKBACK_MONTHS)
        fwd_panel.to_csv(fwd_cache, index=False)
        print(f"  Saved to {fwd_cache}")

    compare_forward_backward(fwd_panel, label="Stooq universe")

    # ── Shared comoment panel (quarterly, cached) ─────────────────────────
    print("\nBuilding/loading shared comoment panel (quarterly)...")
    cm_panel_q = build_comoment_panel(SR, ff, window=LOOKBACK_MONTHS,
                                       step=3,
                                       cache_file='lh_comoment_panel_q.csv')

    # ── Forward triple sort factors ────────────────────────────────────────
    fwd_factor_cache = Path('lh_forward_factors.csv')
    if fwd_factor_cache.exists():
        print("\nLoading cached forward triple-sort factors...")
        factors_fwd = norm_idx(pd.read_csv(
            fwd_factor_cache, index_col=0, parse_dates=True))
        # Validate correct design:
        # Forward factors should end ~36 months before data end
        # because we need [t+1, t+37) future data after each return month
        # Data ends 2024-12, so forward factors should end ~2021-12
        correct_end = pd.Timestamp('2022-06-30')  # approximate cutoff
        if 'COV_fwd' not in factors_fwd.columns:
            print(f"  Wrong columns {list(factors_fwd.columns)} — rebuilding")
            fwd_factor_cache.unlink(); factors_fwd = None
        elif factors_fwd.index[-1] > correct_end:
            print(f"  Cache has wrong design (ends {factors_fwd.index[-1].date()}"
                  f", expected before {correct_end.date()}) — rebuilding")
            fwd_factor_cache.unlink(); factors_fwd = None
        else:
            print(f"  ✓ {factors_fwd.shape[0]} months loaded "
                  f"({factors_fwd.index[0].date()} to "
                  f"{factors_fwd.index[-1].date()})")
    if not fwd_factor_cache.exists() or        ('factors_fwd' in dir() and factors_fwd is None):
        print("\nBuilding forward triple-sort factors...")
        print("(~10-15 minutes)")
        factors_fwd = build_forward_triple_sort_factors(
            SR, ff, cm_panel_q, window=LOOKBACK_MONTHS)
        factors_fwd.to_csv(fwd_factor_cache)

    compare_forward_backward_factors(factors, factors_fwd, ff, p25, p100)

    # ── Portfolio sort comparison ──────────────────────────────────────────
    if 'fwd_panel' in dir() and fwd_panel is not None and len(fwd_panel) > 100:
        portfolio_sort_comparison(fwd_panel, ff,
                                  label="Stooq universe, annual windows")

    # ── Mediation ──────────────────────────────────────────────────────────
    if p25 is not None:
        mediation_analysis(p25, factors, ff,
                          loading_window=LOADING_MONTHS,
                          label="25 Size/BTM Portfolios")
    if p100 is not None:
        mediation_analysis(p100, factors, ff,
                          loading_window=LOADING_MONTHS,
                          label="100 Size/BTM Portfolios")

    print("\nDone.")

if __name__ == '__main__':
    main()