"""
Minimum Idiosyncratic Variance Portfolio and True Beta Test
============================================================

Tests the hypothesis that the market cap weighted index conflates sectoral
idiosyncratic risk with systematic risk, producing a flat SML.

Method:
1. Estimate systematic risk via PCA on the equal-weighted return covariance
   matrix (independent of any index weights)
2. Construct the minimum idiosyncratic variance (MIV) portfolio that
   preserves systematic exposure while minimising idiosyncratic variance
3. Compute "true beta" for each portfolio as covariance with the MIV
4. Compare SML slope using true beta vs market cap beta
5. Test whether true beta is more predictive of returns than market beta

Uses Ken French 49 industry portfolios as the stock universe.
"""

import sys, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy import stats, optimize
from scipy.linalg import inv
import statsmodels.api as sm
from sklearn.decomposition import PCA
import requests, zipfile, io
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec

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
    factors = _make_df(
        _parse_monthly(_get_zip('F-F_Research_Data_5_Factors_2x3'), 7),
        ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
    print("  ✓ FF5 factors")

    mom = _make_df(
        _parse_monthly(_get_zip('F-F_Momentum_Factor'), 2),
        ['Date','MOM'])
    print("  ✓ Momentum")

    industries = _make_df(
        _parse_monthly(_get_zip('49_Industry_Portfolios'), 50),
        ['Date'] + [f'Ind{i+1}' for i in range(49)])
    print("  ✓ 49 industry portfolios")

    return factors, mom, industries

# ── Step 1: Estimate systematic factor via PCA ────────────────────────────────

def estimate_systematic_factor(R_exc, n_factors=1, method='pca'):
    """
    Estimate systematic factor(s) from the equal-weighted covariance matrix.
    This is independent of any index weights — no circularity.

    method='pca': first principal component(s) of return matrix
    method='equal_weight': equal-weighted average of all assets

    Returns:
      F: (T,) systematic factor time series
      betas: (N,) loadings of each asset on the systematic factor
      idio_var: (N,) idiosyncratic variance of each asset
    """
    R = R_exc.values  # T x N
    T, N = R.shape

    if method == 'equal_weight':
        F = R.mean(axis=1)
        # Regress each asset on F to get beta and idio variance
        betas = np.zeros(N)
        idio_var = np.zeros(N)
        for i in range(N):
            b = np.cov(R[:,i], F)[0,1] / np.var(F)
            betas[i] = b
            resid = R[:,i] - b * F
            idio_var[i] = np.var(resid)
        F_var = np.var(F)

    elif method == 'pca':
        # Standardise returns before PCA to avoid scale issues
        R_std = (R - R.mean(axis=0)) / (R.std(axis=0) + 1e-10)
        pca = PCA(n_components=n_factors)
        scores = pca.fit_transform(R_std)  # T x n_factors
        F = scores[:, 0]  # first PC

        # Rescale F to have same variance as equal-weighted index
        ew = R.mean(axis=1)
        F = F * (np.std(ew) / np.std(F))
        # Align sign: correlate with EW to ensure positive loading
        if np.corrcoef(F, ew)[0,1] < 0:
            F = -F

        betas = np.zeros(N)
        idio_var = np.zeros(N)
        for i in range(N):
            b = np.cov(R[:,i], F)[0,1] / np.var(F)
            betas[i] = b
            resid = R[:,i] - b * F
            idio_var[i] = np.var(resid)
        F_var = np.var(F)

    return F, betas, idio_var, F_var

# ── Step 2: Minimum Idiosyncratic Variance Portfolio ─────────────────────────

def compute_miv_portfolio(R_exc, betas, idio_var, F_var,
                          target_beta=1.0, method='analytical'):
    """
    Find portfolio weights w that minimise idiosyncratic variance
    while maintaining target systematic exposure (portfolio beta = target_beta).

    Constraints:
      w'beta = target_beta  (systematic exposure preserved)
      w'1 = 1               (fully invested)
      w >= 0                (long only — optional)

    The idiosyncratic variance of portfolio w is:
      w' * Sigma_idio * w
    where Sigma_idio = diag(idio_var) (assuming idiosyncratic returns
    are uncorrelated across assets — the strict factor model assumption)

    Analytical solution (without long-only constraint):
    Using Lagrange multipliers for:
      min w'Dw  s.t. w'beta=1, w'1=1
    where D = diag(idio_var)

    Returns: weights array (N,)
    """
    N = len(betas)
    D_inv = 1.0 / (idio_var + 1e-10)  # diagonal of D^{-1}

    if method == 'analytical':
        # Analytical solution via Lagrange multipliers
        # min w'Dw s.t. Aw = b where A = [beta', 1'], b = [target_beta, 1]
        # Solution: w = D^{-1}A'(AD^{-1}A')^{-1}b

        # Build constraint matrix A (2 x N) and vector b (2,)
        A = np.vstack([betas, np.ones(N)])  # 2 x N
        b_vec = np.array([target_beta, 1.0])

        # Compute D^{-1}A' (N x 2)
        DinvAt = np.column_stack([D_inv * betas, D_inv * np.ones(N)])

        # Compute A D^{-1} A' (2 x 2)
        ADinvAt = A @ DinvAt

        try:
            ADinvAt_inv = inv(ADinvAt)
            # w = D^{-1} A' (A D^{-1} A')^{-1} b
            w = DinvAt @ (ADinvAt_inv @ b_vec)
        except np.linalg.LinAlgError:
            print("  Singular matrix in analytical solution, falling back to QP")
            method = 'qp'

    if method == 'qp':
        # Numerical QP with long-only constraint
        from scipy.optimize import minimize

        def objective(w):
            return float(w @ (idio_var * w))  # w'Dw

        def objective_grad(w):
            return 2 * idio_var * w

        constraints = [
            {'type': 'eq', 'fun': lambda w: w @ betas - target_beta},
            {'type': 'eq', 'fun': lambda w: w.sum() - 1.0},
        ]
        bounds = [(0, None)] * N  # long only

        w0 = np.ones(N) / N
        res = optimize.minimize(
            objective, w0, jac=objective_grad,
            method='SLSQP', bounds=bounds, constraints=constraints,
            options={'ftol': 1e-10, 'maxiter': 1000})
        w = res.x

    return w

def compute_portfolio_return(R_exc, weights):
    """Compute portfolio return time series."""
    return R_exc.values @ weights

# ── Step 3: Compute true beta ─────────────────────────────────────────────────

def compute_true_beta(R_exc, miv_returns):
    """
    True beta: covariance of each asset with MIV portfolio,
    normalised by MIV variance.
    """
    N = R_exc.shape[1]
    miv_var = np.var(miv_returns)
    true_betas = np.zeros(N)
    for i in range(N):
        cov = np.cov(R_exc.values[:,i], miv_returns)[0,1]
        true_betas[i] = cov / miv_var
    return true_betas

def compute_market_beta(R_exc, market_returns):
    """Standard CAPM beta against market cap weighted index."""
    N = R_exc.shape[1]
    mkt_var = np.var(market_returns)
    betas = np.zeros(N)
    for i in range(N):
        cov = np.cov(R_exc.values[:,i], market_returns)[0,1]
        betas[i] = cov / mkt_var
    return betas

# ── Step 4: SML test ──────────────────────────────────────────────────────────

def run_sml_test(betas, mean_returns, label, rf_mean=0.0):
    """
    Test whether beta predicts returns cross-sectionally.
    Returns slope, t-stat, R².
    """
    excess = mean_returns - rf_mean
    X = sm.add_constant(betas)
    reg = sm.OLS(excess, X).fit()
    slope = reg.params[1]
    t     = reg.tvalues[1]
    r2    = reg.rsquared
    alpha = reg.params[0]
    return {
        'label': label,
        'alpha': alpha,
        'slope': slope,
        't_slope': t,
        'p_slope': reg.pvalues[1],
        'r2': r2,
    }

# ── Main analysis ─────────────────────────────────────────────────────────────

def main():
    factors, mom, industries = fetch_data()

    # Use post-1963 data (after compulsory disclosure)
    start = '1963-07-01'
    idx   = industries.index[industries.index >= start]
    ind   = industries.loc[idx].replace(-99.99, np.nan).dropna(axis=1, how='any')
    rf    = factors['RF'].loc[idx] / 100
    mkt   = factors['Mkt-RF'].loc[idx] / 100  # market excess return

    # Excess returns
    R_exc = ind.div(100).sub(rf, axis=0)
    R_exc = R_exc.dropna()
    rf    = rf.loc[R_exc.index]
    mkt   = mkt.loc[R_exc.index]

    N = R_exc.shape[1]
    T = R_exc.shape[0]
    print(f"\nAnalysis universe: {N} industries, {T} monthly obs "
          f"({R_exc.index[0].date()} to {R_exc.index[-1].date()})")

    # ── Factor structure ───────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("Step 1: Systematic Factor Estimation")
    print(f"{'='*60}")

    pca = PCA(n_components=5)
    R_std = (R_exc.values - R_exc.values.mean(axis=0)) / \
            (R_exc.values.std(axis=0) + 1e-10)
    pca.fit(R_std)
    evr = pca.explained_variance_ratio_
    print(f"\nPCA explained variance (equal-weighted covariance):")
    for i, v in enumerate(evr):
        print(f"  PC{i+1}: {v*100:.1f}%")
    print(f"  First 3 PCs: {evr[:3].sum()*100:.1f}% of total variance")

    # Compare: how much variance does market cap proxy explain?
    mkt_r2s = []
    for i in range(N):
        X = sm.add_constant(mkt.values)
        reg = sm.OLS(R_exc.values[:,i], X).fit()
        mkt_r2s.append(reg.rsquared)
    print(f"\nMarket cap index R² for industry returns:")
    print(f"  Mean: {np.mean(mkt_r2s):.3f}  "
          f"Min: {np.min(mkt_r2s):.3f}  Max: {np.max(mkt_r2s):.3f}")

    # ── Estimate with both methods ─────────────────────────────────────────
    results = {}
    for method in ['equal_weight', 'pca']:
        print(f"\n{'='*60}")
        print(f"Step 2: MIV Portfolio [{method}]")
        print(f"{'='*60}")

        F, betas_sys, idio_var, F_var = estimate_systematic_factor(
            R_exc, method=method)

        print(f"\nSystematic factor [{method}]:")
        print(f"  Mean: {F.mean()*12:.3f}  Std: {F.std()*np.sqrt(12):.3f}")
        print(f"  Corr with market: {np.corrcoef(F, mkt.values)[0,1]:.3f}")

        print(f"\nIdiosyncratic variance summary:")
        print(f"  Mean: {idio_var.mean()*12:.4f}  "
              f"Min: {idio_var.min()*12:.4f}  Max: {idio_var.max()*12:.4f}")

        # ── MIV portfolio (analytical, no short-sale constraint) ───────────
        w_miv = compute_miv_portfolio(
            R_exc, betas_sys, idio_var, F_var,
            target_beta=1.0, method='analytical')

        miv_ret = compute_portfolio_return(R_exc, w_miv)

        # Idiosyncratic variance of MIV vs equal-weighted vs market
        ew_ret  = R_exc.values.mean(axis=1)

        def port_idio_var(w, idio_v):
            return float(w @ (idio_v * w))

        w_ew  = np.ones(N) / N
        w_mkt_approx = np.ones(N) / N  # proxy — equal weight as mkt proxy

        idio_miv = port_idio_var(w_miv, idio_var)
        idio_ew  = port_idio_var(w_ew,  idio_var)

        print(f"\nIdiosyncratic variance comparison:")
        print(f"  Equal-weighted:   {idio_ew*12:.6f}")
        print(f"  MIV portfolio:    {idio_miv*12:.6f}")
        print(f"  Ratio MIV/EW:     {idio_miv/idio_ew:.4f}")

        # MIV portfolio composition
        top_idx = np.argsort(w_miv)[::-1]
        print(f"\nMIV portfolio top 10 weights:")
        cols = list(R_exc.columns)
        for i in top_idx[:10]:
            print(f"  {cols[i]:<8}: {w_miv[i]:>+8.4f}  "
                  f"(beta={betas_sys[i]:.2f}, "
                  f"idio_vol={np.sqrt(idio_var[i]*12)*100:.1f}%)")

        print(f"\nMIV portfolio beta to systematic factor: "
              f"{np.sum(w_miv * betas_sys):.4f}")

        # ── True beta ──────────────────────────────────────────────────────
        true_betas = compute_true_beta(R_exc, miv_ret)
        mkt_betas  = compute_market_beta(R_exc, mkt.values)

        print(f"\nBeta comparison [{method}]:")
        print(f"  {'Industry':<8} {'MIV beta':>10} {'Mkt beta':>10} {'Diff':>8}")
        print("  " + "-"*40)
        for i in range(min(10, N)):
            diff = true_betas[i] - mkt_betas[i]
            print(f"  {cols[i]:<8} {true_betas[i]:>10.3f} "
                  f"{mkt_betas[i]:>10.3f} {diff:>+8.3f}")

        corr_betas = np.corrcoef(true_betas, mkt_betas)[0,1]
        print(f"\n  Correlation between true and market beta: {corr_betas:.3f}")

        # ── SML comparison ─────────────────────────────────────────────────
        print(f"\n{'='*60}")
        print(f"Step 4: SML Test [{method}]")
        print(f"{'='*60}")

        mean_exc = R_exc.mean(axis=0).values * 12  # annualised
        rf_mean  = rf.mean() * 12

        sml_mkt  = run_sml_test(mkt_betas,  mean_exc,
                                 'Market beta',    rf_mean)
        sml_true = run_sml_test(true_betas, mean_exc,
                                 'True (MIV) beta', rf_mean)

        print(f"\n  {'Measure':<20} {'Alpha':>8} {'Slope':>8} "
              f"{'t-stat':>8} {'R²':>8}")
        print("  " + "-"*56)
        for s in [sml_mkt, sml_true]:
            sig = ('***' if s['p_slope']<0.01
                   else ('**' if s['p_slope']<0.05
                   else ('*' if s['p_slope']<0.10 else '')))
            print(f"  {s['label']:<20} {s['alpha']:>+8.4f} "
                  f"{s['slope']:>+8.4f} {s['t_slope']:>+7.2f}{sig:3s} "
                  f"{s['r2']:>8.4f}")

        # ── Rolling window test ────────────────────────────────────────────
        # Test whether true beta is more stable predictor over time
        print(f"\n── Rolling 5-year Fama-MacBeth [{method}] ─────────────")
        print(f"  Tests whether true beta predicts 1y forward returns "
              f"better than market beta")

        window = 60   # 5-year estimation window
        horizon = 12  # 1-year forward return

        fm_mkt_slopes  = []
        fm_true_slopes = []
        dates_fm = []

        for t in range(window, T - horizon, 12):
            # Estimation window
            R_est = R_exc.iloc[t-window:t]
            R_fwd = R_exc.iloc[t:t+horizon]
            mkt_est = mkt.iloc[t-window:t]

            F_t, betas_t, idio_t, Fvar_t = estimate_systematic_factor(
                R_est, method=method)
            w_t = compute_miv_portfolio(
                R_est, betas_t, idio_t, Fvar_t,
                target_beta=1.0, method='analytical')

            miv_t   = compute_portfolio_return(R_est, w_t)
            tb_t    = compute_true_beta(R_est, miv_t)
            mb_t    = compute_market_beta(R_est, mkt_est.values)

            fwd_exc = R_fwd.mean(axis=0).values * 12

            # Cross-sectional regression
            def cs_slope(betas, ret):
                if np.std(betas) < 1e-8: return np.nan
                return np.cov(betas, ret)[0,1] / np.var(betas)

            fm_mkt_slopes.append(cs_slope(mb_t, fwd_exc))
            fm_true_slopes.append(cs_slope(tb_t, fwd_exc))
            dates_fm.append(R_exc.index[t])

        fm_mkt  = np.array(fm_mkt_slopes)
        fm_true = np.array(fm_true_slopes)
        valid   = np.isfinite(fm_mkt) & np.isfinite(fm_true)

        def fm_tstat(slopes):
            s = slopes[np.isfinite(slopes)]
            return np.mean(s) / (np.std(s, ddof=1) / np.sqrt(len(s)))

        print(f"\n  Market beta:   mean slope={np.nanmean(fm_mkt):+.4f}  "
              f"t={fm_tstat(fm_mkt):+.2f}")
        print(f"  True beta:     mean slope={np.nanmean(fm_true):+.4f}  "
              f"t={fm_tstat(fm_true):+.2f}")
        print(f"  (Positive slope = steeper SML = beta is priced)")

        results[method] = {
            'true_betas': true_betas,
            'mkt_betas':  mkt_betas,
            'sml_mkt':    sml_mkt,
            'sml_true':   sml_true,
            'fm_mkt':     fm_mkt,
            'fm_true':    fm_true,
            'w_miv':      w_miv,
            'mean_exc':   mean_exc,
            'cols':       cols,
            'dates_fm':   dates_fm,
        }

    # ── Figure ─────────────────────────────────────────────────────────────
    print(f"\nGenerating figures...")

    fig = plt.figure(figsize=(16, 12))
    fig.patch.set_facecolor('#0d1117')
    gs = gridspec.GridSpec(2, 3, figure=fig, hspace=0.4, wspace=0.35)

    colors = {'pca': '#4b9cf5', 'equal_weight': '#f5a623'}
    methods = ['pca', 'equal_weight']
    method_labels = {'pca': 'PCA Factor', 'equal_weight': 'Equal-Weight Factor'}

    for col_idx, method in enumerate(methods):
        r = results[method]
        true_b = r['true_betas']
        mkt_b  = r['mkt_betas']
        exc    = r['mean_exc']
        color  = colors[method]

        # SML comparison
        ax = fig.add_subplot(gs[0, col_idx])
        ax.set_facecolor('#0d1117')

        b_range = np.linspace(min(mkt_b.min(), true_b.min()) - 0.1,
                              max(mkt_b.max(), true_b.max()) + 0.1, 100)

        # Fit lines
        for betas, label, lc, ls in [
                (mkt_b,  'Market beta', '#f5a623', '--'),
                (true_b, 'True beta',   '#4b9cf5', '-')]:
            X = sm.add_constant(betas)
            reg = sm.OLS(exc, X).fit()
            ax.plot(b_range,
                    reg.params[0] + reg.params[1]*b_range,
                    color=lc, linestyle=ls, linewidth=2,
                    label=f"{label} (slope={reg.params[1]:+.3f}, "
                          f"t={reg.tvalues[1]:+.1f})")

        # Scatter points coloured by true vs market beta diff
        diff = true_b - mkt_b
        sc = ax.scatter(true_b, exc, c=diff,
                       cmap='RdYlGn', s=40, alpha=0.7, zorder=5)
        plt.colorbar(sc, ax=ax, label='True β - Market β', pad=0.02)

        ax.axhline(0, color='#8892a4', linewidth=0.5, linestyle=':')
        ax.axvline(1, color='#8892a4', linewidth=0.5, linestyle=':')
        ax.set_xlabel('Beta', color='#8892a4', fontsize=9)
        ax.set_ylabel('Mean Annual Excess Return', color='#8892a4', fontsize=9)
        ax.set_title(f'SML: {method_labels[method]}',
                     color='#e6edf3', fontsize=10, pad=8)
        ax.legend(fontsize=7, facecolor='#1e2530', labelcolor='#e6edf3',
                  loc='upper left')
        ax.tick_params(colors='#8892a4', labelsize=8)
        for spine in ax.spines.values():
            spine.set_edgecolor('#1e2530')

    # Beta comparison scatter
    ax = fig.add_subplot(gs[0, 2])
    ax.set_facecolor('#0d1117')
    for method in methods:
        r = results[method]
        ax.scatter(r['mkt_betas'], r['true_betas'],
                  label=method_labels[method],
                  color=colors[method], alpha=0.7, s=40)
    lims = [min(ax.get_xlim()[0], ax.get_ylim()[0]),
            max(ax.get_xlim()[1], ax.get_ylim()[1])]
    ax.plot(lims, lims, color='#8892a4', linewidth=1, linestyle='--',
            label='45° line')
    ax.set_xlabel('Market Beta', color='#8892a4', fontsize=9)
    ax.set_ylabel('True (MIV) Beta', color='#8892a4', fontsize=9)
    ax.set_title('True vs Market Beta', color='#e6edf3', fontsize=10, pad=8)
    ax.legend(fontsize=7, facecolor='#1e2530', labelcolor='#e6edf3')
    ax.tick_params(colors='#8892a4', labelsize=8)
    for spine in ax.spines.values():
        spine.set_edgecolor('#1e2530')

    # Rolling Fama-MacBeth slopes
    for row_idx, method in enumerate(methods):
        ax = fig.add_subplot(gs[1, row_idx])
        ax.set_facecolor('#0d1117')
        r = results[method]
        dates = pd.DatetimeIndex(r['dates_fm'])
        fm_m = np.array(r['fm_mkt'])
        fm_t = np.array(r['fm_true'])
        valid = np.isfinite(fm_m) & np.isfinite(fm_t)

        ax.plot(dates[valid], fm_m[valid],
               color='#f5a623', alpha=0.7, linewidth=1.2,
               label=f"Market β (mean={np.nanmean(fm_m):+.3f})")
        ax.plot(dates[valid], fm_t[valid],
               color='#4b9cf5', alpha=0.7, linewidth=1.2,
               label=f"True β (mean={np.nanmean(fm_t):+.3f})")
        ax.axhline(0, color='#8892a4', linewidth=0.5, linestyle=':')
        ax.set_xlabel('Date', color='#8892a4', fontsize=9)
        ax.set_ylabel('Cross-sectional slope', color='#8892a4', fontsize=9)
        ax.set_title(f'Rolling SML Slope [{method_labels[method]}]',
                     color='#e6edf3', fontsize=10, pad=8)
        ax.legend(fontsize=7, facecolor='#1e2530', labelcolor='#e6edf3')
        ax.tick_params(colors='#8892a4', labelsize=8)
        for spine in ax.spines.values():
            spine.set_edgecolor('#1e2530')

    # MIV weights vs equal weights
    ax = fig.add_subplot(gs[1, 2])
    ax.set_facecolor('#0d1117')
    method = 'pca'
    r = results[method]
    w_miv = r['w_miv']
    w_ew  = np.ones(N) / N
    diff_w = w_miv - w_ew

    sorted_idx = np.argsort(diff_w)
    cols_sorted = [r['cols'][i] for i in sorted_idx]
    diffs_sorted = diff_w[sorted_idx]
    bar_colors = ['#f5a623' if d < 0 else '#4b9cf5' for d in diffs_sorted]

    # Show only most extreme 20 for readability
    show = 20
    idx_show = list(range(show//2)) + list(range(N-show//2, N))
    ax.barh([cols_sorted[i] for i in idx_show],
            [diffs_sorted[i] for i in idx_show],
            color=[bar_colors[i] for i in idx_show], alpha=0.8)
    ax.axvline(0, color='#8892a4', linewidth=0.5)
    ax.set_xlabel('MIV weight - Equal weight', color='#8892a4', fontsize=9)
    ax.set_title('MIV vs Equal Weight\n(most extreme industries)',
                 color='#e6edf3', fontsize=10, pad=8)
    ax.tick_params(colors='#8892a4', labelsize=7)
    for spine in ax.spines.values():
        spine.set_edgecolor('#1e2530')

    plt.suptitle(
        'Minimum Idiosyncratic Variance Portfolio & True Beta Test\n'
        'Does correcting for index concentration reveal a steeper SML?',
        color='#e6edf3', fontsize=13, fontweight='bold', y=0.98)

    plt.savefig('miv_true_beta_test.png', dpi=150, bbox_inches='tight',
                facecolor='#0d1117')
    print("  Saved: miv_true_beta_test.png")
    plt.close()

    print("\nDone.")

if __name__ == '__main__':
    main()
