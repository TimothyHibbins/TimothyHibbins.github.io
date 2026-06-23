"""
Lambert-Hubner (2013) Comoment Replication
==========================================

Replicates and extends Lambert & Hübner (2013) "Comoment Risk and Stock Returns"
using Ken French's industry and factor decile portfolios.

Methodology:
1. For each portfolio, estimate coskewness (gamma) and cokurtosis (delta) from
   lookback window: R_i = a + b*R_m + c*R_m^2 + d*R_m^3
2. Test whether these predict forward returns (Fama-MacBeth)
3. Test whether they mediate Fama-French factor loadings

Key difference from gp_crra_test.py:
- Uses LOOKBACK window for distribution estimation (no look-ahead bias)
- Uses polynomial regression (parametric, stable with limited data)
- Follows LH's exact methodology for direct comparison
"""

import sys, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy import stats
import statsmodels.api as sm
import requests, zipfile, io

# ── Data loading ──────────────────────────────────────────────────────────────

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

def fetch_data():
    print("Fetching data...")
    rows = _parse_monthly(_get_zip('F-F_Research_Data_5_Factors_2x3'), 7)
    factors = _make_df(rows, ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
    print("  ✓ FF5 factors")

    rows = _parse_monthly(_get_zip('F-F_Momentum_Factor'), 2)
    mom = _make_df(rows, ['Date','MOM'])
    print("  ✓ Momentum")

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
        deciles[name] = _make_df(
            _parse_monthly(_get_zip(fname), nc),
            ['Date'] + [f'D{i+1}' for i in range(10)])
        print(f"  ✓ {name} deciles")

    return factors, mom, industries, deciles

# ── Comoment estimation ───────────────────────────────────────────────────────

def estimate_comoments(ri_exc, rm_exc, standardise=True):
    """
    Estimate coskewness and cokurtosis via polynomial regression.
    R_i = a + b*R_m + c*R_m^2 + d*R_m^3 + e

    Returns dict with beta, coskew (c), cokurt (d), R2, n_obs.

    If standardise=True, standardise R_m before regression so
    coefficients are comparable across windows (Lambert-Hubner approach).
    """
    ri = np.array(ri_exc, dtype=float)
    rm = np.array(rm_exc, dtype=float)
    mask = np.isfinite(ri) & np.isfinite(rm)
    if mask.sum() < 24:
        return None
    ri = ri[mask]; rm = rm[mask]

    if standardise:
        rm_s = (rm - rm.mean()) / (rm.std() if rm.std() > 0 else 1)
    else:
        rm_s = rm

    X = sm.add_constant(pd.DataFrame({
        'rm':  rm_s,
        'rm2': rm_s**2,
        'rm3': rm_s**3,
    }))
    try:
        reg = sm.OLS(ri, X).fit()
        return {
            'beta':    float(reg.params.get('rm',  np.nan)),
            'coskew':  float(reg.params.get('rm2', np.nan)),
            'cokurt':  float(reg.params.get('rm3', np.nan)),
            'alpha':   float(reg.params.get('const', np.nan)),
            'r2':      float(reg.rsquared),
            'n_obs':   int(mask.sum()),
        }
    except Exception:
        return None

def estimate_ff_loadings(ri_exc, factors_window):
    """Estimate FF6 factor loadings from lookback window."""
    idx = ri_exc.index.intersection(factors_window.index)
    if len(idx) < 24:
        return None
    ri = ri_exc.loc[idx]
    Xf = sm.add_constant(pd.DataFrame({
        'Mkt-RF': factors_window['Mkt-RF'].loc[idx] / 100,
        'SMB':    factors_window['SMB'].loc[idx]    / 100,
        'HML':    factors_window['HML'].loc[idx]    / 100,
        'RMW':    factors_window['RMW'].loc[idx]    / 100,
        'CMA':    factors_window['CMA'].loc[idx]    / 100,
        'MOM':    factors_window['MOM'].loc[idx]    / 100
            if 'MOM' in factors_window.columns
            else pd.Series(0., index=idx),
    }))
    try:
        reg = sm.OLS(ri, Xf).fit()
        return {f'load_{k}': float(reg.params[k])
                for k in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']
                if k in reg.params}
    except: return None

# ── Panel building ────────────────────────────────────────────────────────────

def build_panel(all_factors, portfolios, label='industry',
                lookback_years=5, forward_years_list=(1, 3, 5),
                step_months=12):
    """
    Build panel with:
    - Comoments estimated from LOOKBACK window (no look-ahead)
    - Forward returns measured from FORWARD window
    - FF factor loadings from lookback window

    step_months=12 → annual rebalancing (Fama-MacBeth style)
    """
    print(f"\nBuilding panel [{label}] "
          f"(lookback={lookback_years}y, forward={forward_years_list}, "
          f"step={step_months}m)...")

    rm_full = all_factors['Mkt-RF'] / 100
    rf_full = all_factors['RF']     / 100

    # Flatten portfolios
    port_series = {}
    if isinstance(portfolios, dict) and not isinstance(
            list(portfolios.values())[0], pd.Series):
        for gname, df in portfolios.items():
            for col in df.columns:
                port_series[f'{gname}_{col}'] = df[col]
    else:
        for col in portfolios.columns:
            port_series[col] = portfolios[col]

    start = (all_factors.index.min()
             + pd.DateOffset(years=lookback_years))
    end   = (all_factors.index.max()
             - pd.DateOffset(years=max(forward_years_list)))

    panels = {fy: [] for fy in forward_years_list}
    t = start

    while t <= end:
        lookback_start = t - pd.DateOffset(years=lookback_years)
        f_back = all_factors.loc[lookback_start:t]
        rm_back = rm_full.loc[lookback_start:t]

        for port_name, s_raw in port_series.items():
            s  = s_raw.dropna() / 100
            rf = rf_full

            # Excess return series
            ri_back_idx = s.index.intersection(f_back.index)
            if len(ri_back_idx) < 24: continue
            ri_back = s.loc[ri_back_idx] - rf.loc[ri_back_idx]

            # Comoments from lookback
            cm = estimate_comoments(
                ri_back.values,
                rm_back.loc[ri_back_idx].values)
            if cm is None: continue

            # FF loadings from lookback
            loadings = estimate_ff_loadings(ri_back, f_back.loc[ri_back_idx])
            if loadings is None: continue

            for fwd_years in forward_years_list:
                fwd_end = t + pd.DateOffset(years=fwd_years)
                r_fwd_idx = s.index.intersection(
                    all_factors.loc[t:fwd_end].index)
                if len(r_fwd_idx) < max(6, fwd_years * 6): continue

                ri_fwd = (s.loc[r_fwd_idx]
                          - rf.loc[r_fwd_idx]).values
                fwd_mean = float(np.nanmean(ri_fwd)) * 12
                rf_mean  = float(rf.loc[r_fwd_idx].mean()) * 12

                row = {
                    'date':       t,
                    'portfolio':  port_name,
                    'fwd_years':  fwd_years,
                    'label':      label,
                    'fwd_exc':    fwd_mean,
                    'rf_ann':     rf_mean,
                    **{f'cm_{k}': v for k,v in cm.items()},
                    **loadings,
                }
                panels[fwd_years].append(row)

        t += pd.DateOffset(months=step_months)

    result = {}
    for fy in forward_years_list:
        df = pd.DataFrame(panels[fy])
        if len(df):
            df = df.sort_values(['date','portfolio']).reset_index(drop=True)
        result[fy] = df
        n = len(df)
        nd = df['date'].nunique() if n else 0
        np2 = df['portfolio'].nunique() if n else 0
        print(f"  {fy}-year forward: {n} obs "
              f"({np2} portfolios × {nd} dates)")
    return result

# ── Fama-MacBeth test ─────────────────────────────────────────────────────────

def fama_macbeth(panel_df, x_cols, y_col='fwd_exc', label=''):
    """
    Fama-MacBeth cross-sectional regression.
    For each date t: regress y on x cross-sectionally.
    Report time-series mean and t-stat of slope estimates.
    """
    df = panel_df.dropna(subset=x_cols + [y_col])
    dates = sorted(df['date'].unique())
    slopes = {x: [] for x in x_cols}

    for d in dates:
        sub = df[df['date'] == d]
        if len(sub) < len(x_cols) + 3: continue
        y = sub[y_col].values
        X = sm.add_constant(sub[x_cols].values)
        try:
            reg = sm.OLS(y, X).fit()
            for j, x in enumerate(x_cols):
                slopes[x].append(reg.params[j+1])
        except: pass

    results = {}
    for x in x_cols:
        s = np.array(slopes[x])
        if len(s) < 3:
            results[x] = {'mean': np.nan, 't': np.nan, 'p': np.nan, 'n': 0}
            continue
        mean = np.mean(s)
        se   = np.std(s, ddof=1) / np.sqrt(len(s))
        t    = mean / se if se > 0 else np.nan
        p    = 2 * (1 - stats.t.cdf(abs(t), df=len(s)-1)) if np.isfinite(t) else np.nan
        results[x] = {'mean': mean, 't': t, 'p': p, 'n': len(s)}
    return results

# ── Main test ─────────────────────────────────────────────────────────────────

def run_comoment_test(panel_df, fwd_years, label=''):
    df = panel_df.dropna(subset=['cm_coskew','cm_cokurt',
                                  'cm_beta','fwd_exc']).copy()
    n  = len(df)
    nd = df['date'].nunique()
    print(f"\n{'='*65}")
    print(f"Comoment Pricing Test — {label} {fwd_years}y forward "
          f"(N={n}, T={nd} dates)")
    print(f"{'='*65}")

    excess = df['fwd_exc'] - df['rf_ann']
    date_grp = df['date'].astype(str).values
    factors  = [c for c in ['load_Mkt-RF','load_SMB','load_HML',
                             'load_RMW','load_CMA','load_MOM']
                if c in df.columns]

    # ── Correlations ──────────────────────────────────────────────────────
    print(f"\n── Cross-sectional correlations with forward excess return ──")
    for col in ['cm_beta','cm_coskew','cm_cokurt'] + factors:
        if col not in df.columns: continue
        mask = df[col].notna() & excess.notna()
        c = np.corrcoef(df.loc[mask,col], excess[mask])[0,1]
        sig = '***' if abs(c)>0.15 else ('*' if abs(c)>0.08 else '')
        print(f"  corr({col:<18}, excess) = {c:+.4f} {sig}")

    # ── Fama-MacBeth ──────────────────────────────────────────────────────
    print(f"\n── Fama-MacBeth cross-sectional regressions ─────────────────")
    print(f"  {'Predictor':<40} {'Mean λ':>10} {'t-stat':>8} {'sig':>5}")
    print("  " + "-"*65)

    test_specs = [
        (['cm_beta'],                          'Beta only'),
        (['cm_coskew'],                        'Coskewness only'),
        (['cm_cokurt'],                        'Cokurtosis only'),
        (['cm_beta','cm_coskew','cm_cokurt'],  'Beta + coskew + cokurt'),
        (factors,                              'FF6 factors'),
        (factors+['cm_coskew','cm_cokurt'],    'FF6 + coskew + cokurt'),
    ]

    for x_cols, spec_label in test_specs:
        cols_avail = [c for c in x_cols if c in df.columns]
        if not cols_avail: continue
        df_tmp = df.copy()
        df_tmp['_y'] = excess.values
        fm = fama_macbeth(df_tmp, cols_avail, y_col='_y')
        for x in cols_avail:
            r = fm[x]
            sig = ('***' if r['p']<0.01
                   else ('**' if r['p']<0.05
                   else ('*' if r['p']<0.10 else '')))
            lbl = f"{spec_label}: {x.replace('cm_','').replace('load_','')}"
            print(f"  {lbl:<40} {r['mean']:>+10.4f} {r['t']:>+8.2f} {sig:>5}")

    # ── Panel OLS with clustered SE ───────────────────────────────────────
    print(f"\n── Panel OLS (clustered by date) — R² comparison ────────────")
    y = excess.values

    def fit_ols(X_df):
        X = sm.add_constant(X_df)
        return sm.OLS(y, X).fit(
            cov_type='cluster', cov_kwds={'groups': date_grp})

    specs = [
        (df[['cm_beta']],                      'Beta only'),
        (df[['cm_coskew','cm_cokurt']],         'Coskew + cokurt'),
        (df[['cm_beta','cm_coskew','cm_cokurt']],'Beta+coskew+cokurt'),
        (df[factors],                           'FF6 factors'),
        (df[factors+['cm_coskew','cm_cokurt']], 'FF6 + coskew + cokurt'),
    ]
    r2_factors = None
    for X_df, slabel in specs:
        try:
            reg = fit_ols(X_df)
            r2  = reg.rsquared
            if slabel == 'FF6 factors': r2_factors = r2
            pct = r2/r2_factors*100 if r2_factors else np.nan
            print(f"  {slabel:<35} R²={r2:.4f}  "
                  f"({pct:.1f}% of factor R²)" if r2_factors else
                  f"  {slabel:<35} R²={r2:.4f}")
        except Exception as e:
            print(f"  {slabel:<35} ERROR: {e}")

    # ── Factor mediation ──────────────────────────────────────────────────
    print(f"\n── Factor mediation by comoments ────────────────────────────")
    print(f"  {'Factor':<15} {'Without':>12} {'With comoments':>16} "
          f"{'Mediation%':>12}")
    print("  " + "-"*58)

    try:
        reg_A = fit_ols(df[factors])
        reg_D = fit_ols(df[factors + ['cm_coskew','cm_cokurt']])
        for f in factors:
            def get_bt(reg, fname):
                names = list(reg.model.exog_names)
                if fname not in names: return np.nan, np.nan
                i = names.index(fname)
                return float(reg.params[i]), float(reg.tvalues[i])
            bA, tA = get_bt(reg_A, f)
            bD, tD = get_bt(reg_D, f)
            med = (bA-bD)/bA*100 if np.isfinite(bA) and abs(bA)>1e-8 else np.nan
            sA = '*' if abs(tA)>2 else ''
            sD = '*' if abs(tD)>2 else ''
            fname_s = f.replace('load_','')
            print(f"  {fname_s:<15} {bA:>+10.4f}{sA:1s}  "
                  f"{bD:>+12.4f}{sD:1s}  {med:>10.1f}%")
    except Exception as e:
        print(f"  Error: {e}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    factors, mom, industries, deciles = fetch_data()
    all_factors = factors.join(mom, how='left').fillna(0)

    # Annual rebalancing, 5y lookback, test 1y 3y 5y forward
    print("\n── Industry portfolios ───────────────────────────────────────")
    panels_ind = build_panel(
        all_factors, industries, label='industry',
        lookback_years=5, forward_years_list=(1,3,5), step_months=12)

    print("\n── Factor decile portfolios ──────────────────────────────────")
    panels_dec = build_panel(
        all_factors, deciles, label='decile',
        lookback_years=5, forward_years_list=(1,3,5), step_months=12)

    # Save panels
    for label, panels in [('industry', panels_ind), ('decile', panels_dec)]:
        for fy, df in panels.items():
            if len(df):
                df.to_csv(f'lh_panel_{label}_{fy}y.csv', index=False)

    # Run tests
    for label, panels in [('decile', panels_dec), ('industry', panels_ind)]:
        for fy in (1, 3, 5):
            if fy in panels and len(panels[fy]) > 50:
                run_comoment_test(panels[fy], fy, label)

    print("\nDone.")

if __name__ == '__main__':
    main()
