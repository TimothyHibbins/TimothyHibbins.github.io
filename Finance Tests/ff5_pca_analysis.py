"""
FF5 PCA Analysis: Testing whether Fama-French factors collapse to a single
systematic risk dimension, and whether factor premia are concentrated in bad states.

Usage:
    pip install pandas numpy scikit-learn statsmodels requests
    python ff5_pca_analysis.py
"""

import sys
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
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
import statsmodels.api as sm
import warnings
warnings.filterwarnings('ignore')


# ── 1. DATA ───────────────────────────────────────────────────────────────────

def fetch_ff_data():
    import requests, zipfile, io

    def get_ff_csv(filename):
        url = f"https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/{filename}_CSV.zip"
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=30)
        r.raise_for_status()
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        return zf.read(zf.namelist()[0]).decode('utf-8', errors='replace')

    def parse_ff_csv(content, n_data_cols):
        lines = content.split('\n')
        data_lines, in_data = [], False
        for line in lines:
            stripped = line.strip().rstrip(',')
            if not stripped:
                if in_data:
                    break
                continue
            parts = [p.strip() for p in stripped.split(',')]
            parts = [p for p in parts if p]
            if parts and parts[0].isdigit() and len(parts[0]) == 6:
                in_data = True
                if len(parts) >= n_data_cols:
                    data_lines.append(parts[:n_data_cols])
            elif in_data:
                break
        return data_lines

    def make_df(rows, col_names):
        df = pd.DataFrame(rows, columns=col_names)
        df['Date'] = pd.to_datetime(df['Date'].str.strip(), format='%Y%m')
        return df.set_index('Date').astype(float)

    print("Fetching FF5 factors...")
    factor_rows = parse_ff_csv(get_ff_csv('F-F_Research_Data_5_Factors_2x3'), 7)
    factors_raw = make_df(factor_rows, ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])

    print("Fetching 25 size/BM portfolios...")
    port_rows = parse_ff_csv(get_ff_csv('25_Portfolios_5x5'), 26)
    ports_raw = make_df(port_rows, ['Date'] + [f'P{i+1}' for i in range(25)])

    print("Fetching 49 industry portfolios...")
    ind_rows = parse_ff_csv(get_ff_csv('49_Industry_Portfolios'), 50)
    inds_raw = make_df(ind_rows, ['Date'] + [f'Ind{i+1}' for i in range(49)])
    inds_raw = inds_raw.replace(-99.99, np.nan).replace(-999.0, np.nan)

    return factors_raw, ports_raw, inds_raw


# ── 2. PREPARATION ────────────────────────────────────────────────────────────

def prepare(factors_raw, portfolios_raw):
    common = factors_raw.index.intersection(portfolios_raw.index)
    factors = factors_raw.loc[common]
    rf = factors['RF']
    port_excess = portfolios_raw.loc[common].subtract(rf, axis=0)
    port_excess = port_excess.replace(-99.99, np.nan).replace(-999.0, np.nan)
    mkt = factors['Mkt-RF']
    alpha_factors = factors[['SMB','HML','RMW','CMA']]
    return mkt, alpha_factors, port_excess, common


# ── 3. PCA ────────────────────────────────────────────────────────────────────

def run_pca(alpha_factors):
    scaler = StandardScaler()
    scaled = scaler.fit_transform(alpha_factors)
    pca = PCA()
    pca.fit(scaled)
    scores = pd.DataFrame(
        pca.transform(scaled),
        index=alpha_factors.index,
        columns=[f'PC{i+1}' for i in range(4)]
    )
    print("\n── PCA: Variance Explained ──────────────────────────────────────")
    cumvar = 0
    for i, var in enumerate(pca.explained_variance_ratio_):
        cumvar += var
        print(f"  PC{i+1}: {var*100:5.1f}%  (cumulative: {cumvar*100:5.1f}%)")
    print("\n── Factor Loadings on Each PC ───────────────────────────────────")
    print(f"  {'Factor':>6}" + "".join(f"  {'PC'+str(i+1):>7}" for i in range(4)))
    for j, factor in enumerate(alpha_factors.columns):
        print(f"  {factor:>6}" + "".join(f"  {pca.components_[i][j]:>+7.3f}" for i in range(4)))
    return pca, scores


# ── 4. REGRESSIONS ────────────────────────────────────────────────────────────

def run_regressions(mkt, regressors_dict, port_excess, label):
    print(f"\n── Model Comparison: {label} ─────────────────────────")
    print(f"  {'Model':<24} {'Mean R²':>8} {'Mean|α|%':>10} {'Mean|t(α)|':>11} {'%sig α':>7}")
    print("  " + "-" * 64)
    results = {}
    for name, regressors in regressors_dict.items():
        if isinstance(regressors, pd.DataFrame) and regressors.empty:
            X = sm.add_constant(mkt.to_frame())
        else:
            X = sm.add_constant(pd.concat([mkt, regressors], axis=1))
        X = X.dropna()
        r2s, alphas, t_alphas = [], [], []
        for col in port_excess.columns:
            y = port_excess[col].dropna()
            idx = X.index.intersection(y.index)
            if len(idx) < 100:
                continue
            res = sm.OLS(y.loc[idx], X.loc[idx]).fit()
            r2s.append(res.rsquared)
            alphas.append(res.params['const'])
            t_alphas.append(res.tvalues['const'])
        if not r2s:
            continue
        r = {
            'mean_r2':          np.mean(r2s),
            'mean_abs_alpha':   np.mean(np.abs(alphas)) * 100,
            'mean_abs_t_alpha': np.mean(np.abs(t_alphas)),
            'pct_sig_alpha':    np.mean(np.abs(t_alphas) > 2) * 100,
        }
        results[name] = r
        print(f"  {name:<24} {r['mean_r2']:>8.4f} {r['mean_abs_alpha']:>10.4f} "
              f"{r['mean_abs_t_alpha']:>11.3f} {r['pct_sig_alpha']:>6.1f}%")
    return results


# ── 5. INCREMENTAL F-TESTS ────────────────────────────────────────────────────

def incremental_f_tests(mkt, scores, port_excess, label):
    print(f"\n── Incremental F-tests ({label}) ─────────────────────")
    base = [mkt]
    for i in range(1, 5):
        new_pc = scores[f'PC{i}']
        X_r = sm.add_constant(pd.concat(base, axis=1).dropna())
        X_f = sm.add_constant(pd.concat(base + [new_pc], axis=1).dropna())
        f_stats = []
        for col in port_excess.columns:
            y = port_excess[col].dropna()
            idx = X_r.index.intersection(X_f.index).intersection(y.index)
            if len(idx) < 100:
                continue
            rss_r = sm.OLS(y.loc[idx], X_r.loc[idx]).fit().ssr
            res_f = sm.OLS(y.loc[idx], X_f.loc[idx]).fit()
            f_stats.append(((rss_r - res_f.ssr) / 1) / (res_f.ssr / res_f.df_resid))
        avg_f = np.mean(f_stats)
        sig = "***" if avg_f > 10 else ("**" if avg_f > 5 else ("*" if avg_f > 3 else "  "))
        print(f"  Adding PC{i}: avg F = {avg_f:7.2f} {sig}")
        base.append(new_pc)


# ── 6. INTERPRET ──────────────────────────────────────────────────────────────

def interpret(results_25, results_49, pca):
    print("\n── Key Comparison ───────────────────────────────────────────────")
    for label, results in [('25 size/BM ports', results_25), ('49 industry ports', results_49)]:
        if 'FF5 (benchmark)' not in results or 'Mkt + PC1' not in results:
            continue
        r2_ff5 = results['FF5 (benchmark)']['mean_r2']
        r2_pc1 = results['Mkt + PC1']['mean_r2']
        gap    = r2_ff5 - r2_pc1
        pct    = (1 - gap / r2_ff5) * 100
        print(f"  {label}: FF5 R²={r2_ff5:.4f}  PC1 R²={r2_pc1:.4f}  "
              f"gap={gap:.4f}  PC1 captures {pct:.1f}% of FF5 power")
    print(f"\n  PC1 share of factor variance: {pca.explained_variance_ratio_[0]*100:.1f}%")


# ── 7. REGIME ANALYSIS ────────────────────────────────────────────────────────

def regime_analysis(mkt, alpha_factors, scores):
    df = pd.concat([mkt, alpha_factors, scores], axis=1).dropna()

    # Regime definitions
    q25 = df['Mkt-RF'].quantile(0.25)
    df['bad_market'] = df['Mkt-RF'] < q25
    df['mkt_vol'] = df['Mkt-RF'].rolling(24).std()
    df['high_vol'] = df['mkt_vol'] > df['mkt_vol'].median()

    recession_periods = [
        ('1969-12','1970-11'), ('1973-11','1975-03'), ('1980-01','1980-07'),
        ('1981-07','1982-11'), ('1990-07','1991-03'), ('2001-03','2001-11'),
        ('2007-12','2009-06'), ('2020-02','2020-04'),
    ]
    df['recession'] = False
    for start, end in recession_periods:
        df.loc[(df.index >= start) & (df.index <= end), 'recession'] = True

    factors_of_interest = ['SMB','HML','RMW','CMA']
    pcs_of_interest     = ['PC1','PC2','PC3']

    # 1. Factor mean returns by regime
    print("\n── Factor Mean Monthly Returns by Regime ────────────────────────")
    print(f"  {'Factor':<6}  {'All':>7}  {'Bad Mkt':>8}  {'Good Mkt':>9}  {'Recession':>10}  {'High Vol':>9}")
    print("  " + "-" * 60)
    for f in factors_of_interest:
        print(f"  {f:<6}  "
              f"{df[f].mean():>+7.3f}  "
              f"{df.loc[df['bad_market'],f].mean():>+8.3f}  "
              f"{df.loc[~df['bad_market'],f].mean():>+9.3f}  "
              f"{df.loc[df['recession'],f].mean():>+10.3f}  "
              f"{df.loc[df['high_vol'],f].mean():>+9.3f}")

    # 2. Conditional PC correlations
    print("\n── PC Pairwise Correlations: Unconditional vs Bad States ────────")
    print(f"  {'Pair':<12}  {'Unconditional':>14}  {'Bad Market':>11}  {'Recession':>10}  {'High Vol':>9}")
    print("  " + "-" * 62)
    for p1, p2 in [('PC1','PC2'),('PC1','PC3'),('PC2','PC3')]:
        print(f"  {p1+'/'+p2:<12}  "
              f"{df[p1].corr(df[p2]):>+14.4f}  "
              f"{df.loc[df['bad_market'],[p1,p2]].corr().iloc[0,1]:>+11.4f}  "
              f"{df.loc[df['recession'],[p1,p2]].corr().iloc[0,1]:>+10.4f}  "
              f"{df.loc[df['high_vol'],[p1,p2]].corr().iloc[0,1]:>+9.4f}")

    # 3. Simultaneous factor crashes
    print("\n── Simultaneous Factor Crashes ──────────────────────────────────")
    bad_q = pd.DataFrame({f: df[f] < df[f].quantile(0.25) for f in factors_of_interest})
    n_bad = bad_q.sum(axis=1)
    for k in range(5):
        label = f"ALL {len(factors_of_interest)}" if k == 4 else str(k)
        count = (n_bad == k).sum()
        pct   = (n_bad == k).mean() * 100
        print(f"  {label} factors in bottom quartile: {count:4d} months ({pct:.1f}%)")
    print(f"  (Expected if fully independent: {0.25**4*100:.2f}%)")

    # 4. Recession premium concentration
    print("\n── Recession Premium Concentration ─────────────────────────────")
    rec_months = df['recession'].sum()
    print(f"  Recession months: {rec_months} of {len(df)} ({rec_months/len(df)*100:.1f}%)\n")
    print(f"  {'Factor':<6}  {'Total premium':>14}  {'Recession share':>16}  Interpretation")
    print("  " + "-" * 70)
    for f in factors_of_interest:
        total = df[f].sum()
        rec   = df.loc[df['recession'], f].sum()
        share = rec / total if total != 0 else float('nan')
        interp = "concentrated in recessions" if share > 0.3 else (
                 "LOST in recessions"         if share < 0  else "spread evenly")
        print(f"  {f:<6}  {total:>+14.2f}  {share:>+15.1%}  {interp}")

    # 5. Factor-market correlation: bad vs good states
    print("\n── Factor-Market Correlation: Bad vs Good States ────────────────")
    print(f"  {'Factor':<6}  {'Overall':>8}  {'Bad Mkt':>8}  {'Good Mkt':>9}  {'Ratio':>8}")
    print("  " + "-" * 50)
    for f in factors_of_interest:
        overall   = df[f].corr(df['Mkt-RF'])
        bad_corr  = df.loc[df['bad_market'],  [f,'Mkt-RF']].corr().iloc[0,1]
        good_corr = df.loc[~df['bad_market'], [f,'Mkt-RF']].corr().iloc[0,1]
        ratio     = bad_corr / good_corr if good_corr != 0 else float('nan')
        print(f"  {f:<6}  {overall:>+8.4f}  {bad_corr:>+8.4f}  {good_corr:>+9.4f}  {ratio:>+8.3f}")

    # Summary
    print("\n── Regime Summary ───────────────────────────────────────────────")
    print("  If conditional PC correlations spike in bad states AND factor")
    print("  crashes cluster simultaneously, the orthogonal PCs are not truly")
    print("  independent in the economically relevant sense — they share a")
    print("  single bad-state risk dimension. This would rescue the single-")
    print("  factor proof while explaining the empirical multi-dimensionality.")
    print("  If crashes are genuinely independent, the multi-factor structure")
    print("  is real and the theoretical framework has an unresolved gap.")


# ── 8. MAIN ───────────────────────────────────────────────────────────────────

def main():
    print("=" * 65)
    print("FF5 PCA Analysis: Is there only one systematic risk factor?")
    print("=" * 65)

    factors_raw, ports_raw, inds_raw = fetch_ff_data()
    mkt, alpha_factors, port_excess_25, common_25 = prepare(factors_raw, ports_raw)
    mkt, alpha_factors, port_excess_49, common_49 = prepare(factors_raw, inds_raw)

    print(f"\n25-portfolio data: {common_25[0].strftime('%Y-%m')} to {common_25[-1].strftime('%Y-%m')} ({len(common_25)} months)")
    print(f"49-portfolio data: {common_49[0].strftime('%Y-%m')} to {common_49[-1].strftime('%Y-%m')} ({len(common_49)} months)")

    pca, scores = run_pca(alpha_factors)

    models = {
        'FF5 (benchmark)':  alpha_factors,
        'Mkt only':         pd.DataFrame(index=mkt.index),
        'Mkt + PC1':        scores[['PC1']],
        'Mkt + PC1+PC2':    scores[['PC1','PC2']],
        'Mkt + PC1-PC3':    scores[['PC1','PC2','PC3']],
        'Mkt + all PCs':    scores[['PC1','PC2','PC3','PC4']],
    }

    results_25 = run_regressions(mkt, models, port_excess_25, "25 size/BM portfolios (biased)")
    incremental_f_tests(mkt, scores, port_excess_25, "25 size/BM portfolios")

    results_49 = run_regressions(mkt, models, port_excess_49, "49 industry portfolios (unbiased)")
    incremental_f_tests(mkt, scores, port_excess_49, "49 industry portfolios")

    interpret(results_25, results_49, pca)

    print("\n" + "=" * 65)
    print("REGIME-CONDITIONAL ANALYSIS")
    print("=" * 65)
    regime_analysis(mkt, alpha_factors, scores)

    print("\nDone.")


if __name__ == '__main__':
    main()