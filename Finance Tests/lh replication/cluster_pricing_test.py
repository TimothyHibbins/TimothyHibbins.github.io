"""
Cluster Discovery and Pricing Test
===================================

Tests a diversification-cost theory of factor premiums:

THEORY
------
The equity premium exists because market risk is perfectly non-diversifiable.
Beyond the market, correlated CLUSTERS of stocks command isolated premiums
when they are:
  - internally correlated enough to hurt diversification (high within-corr)
  - distinct enough from the market to be avoidable (low between-corr)
  - of INTERMEDIATE size — large enough that not holding them costs
    diversification, small enough that holding them concentrates risk

The premium is predicted to be:
  - increasing in within-cluster correlation
  - decreasing in between-cluster (market) correlation
  - NON-MONOTONE in cluster size: rises then falls. Very small clusters
    are negligible for diversification (no premium); very large clusters
    bleed their premium into everything (can't be avoided -> no isolated
    premium, the beta limiting case).

PREDICTION TESTED
-----------------
Clusters with high within-corr, low between-corr, and intermediate size
should earn higher subsequent returns. We:
  1. Discover clusters from the return correlation matrix (spectral),
     re-clustered on each rolling window.
  2. Characterise each cluster by within-corr, between-corr, size.
  3. Predict each cluster's premium from theory.
  4. Form portfolios long high-predicted-premium clusters, short low,
     and test whether realised next-period returns line up.

SEPARATE TEST (factor clustering)
---------------------------------
For known factors (size, value, momentum), measure how much more
correlated the stocks loading on each factor are with each other than
with the market / average stock, and relate that "clustering strength"
to the factor's realised premium.

Data: Stooq monthly returns (stock_returns_stooq.csv), reused from the
LH replication pipeline.
"""

import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.cluster import SpectralClustering
import statsmodels.api as sm
import requests, zipfile, io

# ── Config ──────────────────────────────────────────────────────────────────
STOCK_RETURNS_FILE = 'stock_returns_stooq.csv'
WINDOW             = 36     # months to estimate correlation / clusters
HOLD               = 1      # months held after clustering (rebalance monthly)
STEP               = 3      # recluster every STEP months (speed)
N_CLUSTERS         = 20     # k for spectral clustering
MIN_STOCKS_PER_WIN = 200    # require this many stocks with full data in window
MIN_CLUSTER_SIZE   = 5      # ignore clusters smaller than this
WINSOR             = 0.01   # winsorise returns for robust correlation

FF_BASE  = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
HEADERS  = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}


# ── Data loading ────────────────────────────────────────────────────────────
def _get_zip(filename, timeout=60):
    url = f"{FF_BASE}/{filename}_CSV.zip"
    r = requests.get(url, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    return zf.read(zf.namelist()[0]).decode('utf-8', errors='replace')


def _parse_monthly(content, n_cols):
    rows, in_data = [], False
    for line in content.split('\n'):
        s = line.strip().rstrip(',')
        if not s:
            if in_data:
                break
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
                            vals.append(np.nan if v in (-99.99, -999.) else v)
                        except Exception:
                            vals.append(np.nan)
                    rows.append([date] + vals)
                    in_data = True
            except Exception:
                pass
    return rows


def _make_df(rows, cols):
    df = pd.DataFrame(rows, columns=cols)
    df['Date'] = pd.to_datetime(df['Date'].astype(str), format='%Y%m')
    return df.set_index('Date').sort_index()


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def load_ff_factors():
    cache = Path('ff_factors_cache.csv')
    if cache.exists():
        return norm_idx(pd.read_csv(cache, index_col=0, parse_dates=True))
    ff = _make_df(_parse_monthly(
        _get_zip('F-F_Research_Data_5_Factors_2x3'), 7),
        ['Date', 'Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA', 'RF'])
    try:
        mom = _make_df(_parse_monthly(_get_zip('F-F_Momentum_Factor'), 2),
                       ['Date', 'MOM'])
        ff = ff.join(mom, how='left')
    except Exception:
        pass
    ff.to_csv(cache)
    return norm_idx(ff)


def load_stock_returns():
    for path in [STOCK_RETURNS_FILE,
                 f'/mnt/user-data/outputs/{STOCK_RETURNS_FILE}']:
        if Path(path).exists():
            print(f"  Loading {path}...")
            df = pd.read_csv(path, index_col=0, parse_dates=True)
            df = norm_idx(df)
            print(f"  ✓ {df.shape[1]} stocks, {df.shape[0]} months")
            return df
    raise FileNotFoundError(
        f"{STOCK_RETURNS_FILE} not found — run stooq_preprocess.py first")


# ── Cluster characterisation ────────────────────────────────────────────────
def winsorize(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct * 100), np.nanpercentile(a, (1 - pct) * 100)
    return np.clip(a, lo, hi)


def cluster_stats(corr, labels, market_corr):
    """
    For each cluster compute:
      within_corr  : mean pairwise correlation among members
      between_corr : mean correlation of members with non-members
      size         : number of members
      market_corr  : mean correlation of members with the market proxy
    `corr` is the NxN correlation matrix, `labels` is length-N cluster ids,
    `market_corr` is length-N correlation of each stock with the EW market.
    """
    stats = {}
    N = corr.shape[0]
    for c in np.unique(labels):
        members = np.where(labels == c)[0]
        if len(members) < MIN_CLUSTER_SIZE:
            continue
        others = np.where(labels != c)[0]

        # within: upper triangle of submatrix
        sub = corr[np.ix_(members, members)]
        iu = np.triu_indices(len(members), k=1)
        within = np.nanmean(sub[iu]) if len(iu[0]) > 0 else np.nan

        # between: members vs others
        if len(others) > 0:
            between = np.nanmean(corr[np.ix_(members, others)])
        else:
            between = np.nan

        stats[c] = {
            'size':        len(members),
            'within_corr': within,
            'between_corr': between,
            'market_corr': float(np.nanmean(market_corr[members])),
            'members':     members,
        }
    return stats


def predicted_premium(within, between, size, N_total,
                      tol=1.0):
    """
    Theory-driven premium prediction (unitless score, monotone-mapped to
    expected return ranking only — magnitude is not calibrated).

    Components:
      isolation   = within - between
                    (how much the cluster stands apart -> diversification cost)
      avoidability= 1 - (between / within) clipped to [0,1]
                    (low between relative to within = easy to avoid = isolated
                     premium can exist)
      size_term   = non-monotone in fractional size f = size / N_total:
                    peaks at intermediate f, -> 0 as f->0 (negligible) and
                    as f->1 (bleeds into market). Use f*(1-f) shape, which
                    is 0 at both ends and max at f=0.5, scaled by 4 so peak=1.

    premium_score = isolation * avoidability * size_term / tol
    """
    if not np.isfinite(within) or not np.isfinite(between):
        return np.nan
    isolation = within - between
    if within <= 0:
        avoidability = 0.0
    else:
        avoidability = np.clip(1.0 - between / within, 0.0, 1.0)
    f = size / N_total
    size_term = 4.0 * f * (1.0 - f)   # 0 at f=0,1 ; 1 at f=0.5
    return isolation * avoidability * size_term / tol


# ── Main cluster pricing test ───────────────────────────────────────────────
def cluster_pricing_test(SR, ff):
    print(f"\n{'='*66}")
    print(f"Cluster Discovery & Pricing Test")
    print(f"{'='*66}")
    print(f"  window={WINDOW}m  recluster every {STEP}m  k={N_CLUSTERS}")

    rf = ff['RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]
    rf = rf.loc[common]
    T = len(common)

    dates = SR.index[WINDOW:T - HOLD:STEP]
    print(f"  {len(dates)} rebalance dates "
          f"({dates[0].date()} to {dates[-1].date()})")

    # Collect, for each cluster at each date: predicted premium and
    # realised next-period equal-weighted return.
    records = []

    for di, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)
        win = SR.iloc[t_pos - WINDOW:t_pos]

        # keep stocks with complete data in the window
        valid_cols = win.columns[win.notna().all(axis=0)]
        if len(valid_cols) < MIN_STOCKS_PER_WIN:
            continue
        W = win[valid_cols].values  # WINDOW x n
        n = W.shape[1]

        # winsorise each stock's returns for robust correlation
        Ww = np.column_stack([winsorize(W[:, j]) for j in range(n)])

        # correlation matrix
        C = np.corrcoef(Ww, rowvar=False)
        C = np.nan_to_num(C, nan=0.0)
        np.fill_diagonal(C, 1.0)

        # market proxy = equal-weighted average of window stocks
        mkt_win = Ww.mean(axis=1)
        market_corr = np.array([
            np.corrcoef(Ww[:, j], mkt_win)[0, 1] for j in range(n)])
        market_corr = np.nan_to_num(market_corr, nan=0.0)

        # spectral clustering on the affinity = |corr| (must be non-negative)
        affinity = np.abs(C)
        k = min(N_CLUSTERS, max(2, n // MIN_CLUSTER_SIZE))
        try:
            sc = SpectralClustering(
                n_clusters=k, affinity='precomputed',
                assign_labels='kmeans', random_state=0)
            labels = sc.fit_predict(affinity)
        except Exception:
            continue

        stats = cluster_stats(C, labels, market_corr)
        if not stats:
            continue

        # next-period return for each cluster (equal-weighted excess)
        next_pos = t_pos  # return realised over month t (the rebalance month)
        next_rets = SR.iloc[next_pos][valid_cols].values
        rf_t = rf.iloc[next_pos]

        for c, st in stats.items():
            members = st['members']
            r = next_rets[members]
            r = r[np.isfinite(r)]
            if len(r) < MIN_CLUSTER_SIZE:
                continue
            realised = float(np.mean(r) - rf_t)
            pred = predicted_premium(
                st['within_corr'], st['between_corr'],
                st['size'], n)
            if not np.isfinite(pred):
                continue
            records.append({
                'date':         t,
                'within_corr':  st['within_corr'],
                'between_corr': st['between_corr'],
                'isolation':    st['within_corr'] - st['between_corr'],
                'market_corr':  st['market_corr'],
                'size':         st['size'],
                'frac_size':    st['size'] / n,
                'pred_premium': pred,
                'realised_exc': realised,
            })

        if (di + 1) % 20 == 0:
            print(f"    {di+1}/{len(dates)} dates, {len(records)} "
                  f"cluster-obs...")

    df = pd.DataFrame(records)
    print(f"\n  Collected {len(df)} cluster-month observations")
    if len(df) < 100:
        print("  Insufficient data for reliable inference")
        return df

    # ── Test 1: does predicted premium forecast realised return? ──────────
    print(f"\n── Test 1: Predicted vs Realised Cluster Premium ────────────")
    print(f"  Fama-MacBeth: each rebalance month, regress cluster realised")
    print(f"  excess return on predicted premium across clusters; average")
    print(f"  the slope over time.")

    slopes, r2s = [], []
    for t, grp in df.groupby('date'):
        if len(grp) < 5:
            continue
        x = grp['pred_premium'].values
        y = grp['realised_exc'].values
        if np.std(x) < 1e-9:
            continue
        X = sm.add_constant(x)
        reg = sm.OLS(y, X).fit()
        slopes.append(reg.params[1])
        r2s.append(reg.rsquared)

    slopes = np.array(slopes)
    if len(slopes) >= 3:
        m = slopes.mean()
        se = slopes.std(ddof=1) / np.sqrt(len(slopes))
        t_stat = m / se
        print(f"\n  Mean FM slope (pred -> realised): {m:+.4f}")
        print(f"  t-stat: {t_stat:+.2f}   ({len(slopes)} months)")
        print(f"  Mean cross-sectional R²: {np.mean(r2s):.4f}")
        print(f"  Positive slope = theory's premium ranking is correct")

    # ── Test 2: sort clusters by predicted premium, compare returns ───────
    print(f"\n── Test 2: Quintile Sort on Predicted Premium ───────────────")
    print(f"  Each month sort clusters into quintiles by predicted premium,")
    print(f"  measure equal-weighted realised excess return per quintile.")

    q_rets = {q: [] for q in range(5)}
    for t, grp in df.groupby('date'):
        if len(grp) < 10:
            continue
        try:
            q = pd.qcut(grp['pred_premium'], 5, labels=False,
                        duplicates='drop')
        except Exception:
            continue
        grp = grp.assign(q=q)
        for qi in range(5):
            sel = grp[grp['q'] == qi]['realised_exc']
            if len(sel) > 0:
                q_rets[qi].append(sel.mean())

    print(f"\n  {'Quintile':<12} {'Mean exc %/mo':>14} {'annualised %':>14}")
    print("  " + "-" * 42)
    means = []
    for qi in range(5):
        if q_rets[qi]:
            m = np.mean(q_rets[qi])
            means.append(m)
            print(f"  Q{qi+1} {'(low)' if qi==0 else ('(high)' if qi==4 else ''):<8}"
                  f" {m*100:>13.3f} {m*1200:>13.2f}")
    if len(means) == 5:
        spread = means[4] - means[0]
        # t-test on the monthly Q5-Q1 spread series
        q5 = np.array(q_rets[4]); q1 = np.array(q_rets[0])
        L = min(len(q5), len(q1))
        sp = q5[:L] - q1[:L]
        t_sp = sp.mean() / (sp.std(ddof=1) / np.sqrt(len(sp)))
        print(f"\n  Q5 - Q1 spread: {spread*100:+.3f}%/mo "
              f"({spread*1200:+.2f}%/yr), t={t_sp:+.2f}")

    # ── Test 3: which characteristic drives the premium? ──────────────────
    print(f"\n── Test 3: Premium Drivers (multivariate FM) ────────────────")
    print(f"  Regress realised excess return on within-corr, between-corr,")
    print(f"  and frac_size + frac_size² (to capture non-monotonicity).")

    coefs = {k: [] for k in ['within', 'between', 'size', 'size_sq']}
    for t, grp in df.groupby('date'):
        if len(grp) < 8:
            continue
        X = np.column_stack([
            grp['within_corr'].values,
            grp['between_corr'].values,
            grp['frac_size'].values,
            grp['frac_size'].values ** 2,
        ])
        y = grp['realised_exc'].values
        if np.any(np.std(X, axis=0) < 1e-9):
            continue
        try:
            reg = sm.OLS(y, sm.add_constant(X)).fit()
            coefs['within'].append(reg.params[1])
            coefs['between'].append(reg.params[2])
            coefs['size'].append(reg.params[3])
            coefs['size_sq'].append(reg.params[4])
        except Exception:
            continue

    print(f"\n  {'Characteristic':<16} {'Mean coef':>12} {'t':>8}")
    print("  " + "-" * 38)
    for name, key in [('within_corr', 'within'),
                      ('between_corr', 'between'),
                      ('frac_size', 'size'),
                      ('frac_size²', 'size_sq')]:
        arr = np.array(coefs[key])
        arr = arr[np.isfinite(arr)]
        if len(arr) < 3:
            continue
        m = arr.mean()
        t = m / (arr.std(ddof=1) / np.sqrt(len(arr)))
        sig = ('***' if abs(t) > 2.58 else ('**' if abs(t) > 1.96
               else ('*' if abs(t) > 1.65 else '')))
        print(f"  {name:<16} {m:>+12.4f} {t:>+7.2f}{sig}")

    print(f"\n  Theory predicts: within +, between -, size_sq - (concave,")
    print(f"  peaking at intermediate size).")

    return df


# ── Factor clustering test ──────────────────────────────────────────────────
def factor_clustering_test(SR, ff):
    """
    For each known factor, measure how much more correlated the stocks at
    the extremes of that characteristic are with each other than the
    average stock pair, and relate that to the factor's realised premium.

    Without firm characteristics in the Stooq data, we proxy factor
    membership by return-based sorts:
      - size proxy: trailing volatility is correlated with small size;
        but we instead use a market-beta sort and a trailing-return
        (momentum) sort which ARE computable from returns alone.
      - momentum: trailing 12-1 month return
      - low-vol: trailing volatility
      - beta: trailing market beta

    For each factor we form the top and bottom decile each month, measure
    within-decile correlation vs the average pairwise correlation, and the
    realised long-short premium. Then relate clustering strength to premium.
    """
    print(f"\n{'='*66}")
    print(f"Factor Clustering Test (return-based factor proxies)")
    print(f"{'='*66}")
    print(f"  Question: are stocks sharing a factor loading more correlated")
    print(f"  with each other than average — and does clustering strength")
    print(f"  track the factor premium?")

    rf  = ff['RF'] / 100
    mkt = ff['Mkt-RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]; rf = rf.loc[common]; mkt = mkt.loc[common]
    T = len(common)

    factor_defs = ['momentum', 'lowvol', 'beta']
    results = {f: {'within': [], 'avg': [], 'premium': []} for f in factor_defs}

    dates = SR.index[WINDOW:T - 1:STEP]
    for di, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)
        win = SR.iloc[t_pos - WINDOW:t_pos]
        valid = win.columns[win.notna().all(axis=0)]
        if len(valid) < MIN_STOCKS_PER_WIN:
            continue
        W = win[valid]
        Ww = np.column_stack([winsorize(W.values[:, j])
                              for j in range(W.shape[1])])
        C = np.nan_to_num(np.corrcoef(Ww, rowvar=False), nan=0.0)
        iu = np.triu_indices(C.shape[0], k=1)
        avg_pair = np.nanmean(C[iu])

        next_ret = SR.iloc[t_pos][valid].values
        rf_t = rf.iloc[t_pos]

        # compute the characteristic for each stock
        chars = {}
        # momentum: cumulative return months [-12,-1] within window
        if WINDOW >= 12:
            mom = (1 + W.iloc[-12:-1]).prod(axis=0) - 1
            chars['momentum'] = mom.values
        # low vol: negative of trailing stdev (high = low vol)
        chars['lowvol'] = -W.std(axis=0).values
        # beta: covariance with mkt over window / var(mkt)
        mkt_win = mkt.iloc[t_pos - WINDOW:t_pos].values
        vm = np.var(mkt_win)
        betas = np.array([np.cov(W.values[:, j], mkt_win)[0, 1] / vm
                          for j in range(W.shape[1])])
        chars['beta'] = betas

        for fname, cvals in chars.items():
            if fname not in results:
                continue
            order = np.argsort(cvals)
            d = max(MIN_CLUSTER_SIZE, len(order) // 10)
            low_idx = order[:d]
            high_idx = order[-d:]

            # within-correlation of the high decile (the "factor cluster")
            sub = C[np.ix_(high_idx, high_idx)]
            iu2 = np.triu_indices(len(high_idx), k=1)
            within_high = np.nanmean(sub[iu2]) if len(iu2[0]) else np.nan

            # realised long-short premium (high - low), equal weighted
            r_high = np.nanmean(next_ret[high_idx]) - rf_t
            r_low  = np.nanmean(next_ret[low_idx]) - rf_t
            prem = r_high - r_low

            if np.isfinite(within_high) and np.isfinite(prem):
                results[fname]['within'].append(within_high)
                results[fname]['avg'].append(avg_pair)
                results[fname]['premium'].append(prem)

        if (di + 1) % 30 == 0:
            print(f"    {di+1}/{len(dates)} dates...")

    print(f"\n  {'Factor':<12} {'within-corr':>12} {'avg-pair':>10} "
          f"{'excess clust':>13} {'premium %/mo':>13} {'prem t':>8}")
    print("  " + "-" * 70)
    summary = []
    for fname in factor_defs:
        w = np.array(results[fname]['within'])
        a = np.array(results[fname]['avg'])
        p = np.array(results[fname]['premium'])
        if len(p) < 10:
            continue
        within_m = np.nanmean(w)
        avg_m = np.nanmean(a)
        excess_clustering = within_m - avg_m
        prem_m = np.nanmean(p)
        prem_t = prem_m / (np.nanstd(p, ddof=1) / np.sqrt(len(p)))
        summary.append((fname, excess_clustering, prem_m, prem_t))
        print(f"  {fname:<12} {within_m:>12.4f} {avg_m:>10.4f} "
              f"{excess_clustering:>+13.4f} {prem_m*100:>+12.3f} "
              f"{prem_t:>+7.2f}")

    # relationship between clustering strength and premium magnitude
    if len(summary) >= 3:
        ec = np.array([s[1] for s in summary])
        pm = np.array([abs(s[2]) for s in summary])
        if np.std(ec) > 1e-9:
            corr = np.corrcoef(ec, pm)[0, 1]
            print(f"\n  Corr(excess-clustering, |premium|) across factors: "
                  f"{corr:+.3f}")
            print(f"  Theory predicts positive: more clustering -> larger "
                  f"premium")

    return results


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    print("Cluster Pricing Test — diversification-cost theory of premiums")
    print("=" * 66)

    print("\nLoading factor data...")
    ff = load_ff_factors()
    print(f"  ✓ {ff.shape[0]} months of FF factors")

    print("\nLoading stock returns...")
    SR = load_stock_returns()

    df = cluster_pricing_test(SR, ff)
    if df is not None and len(df) > 0:
        df.to_csv('cluster_pricing_panel.csv', index=False)
        print(f"\n  Saved cluster panel to cluster_pricing_panel.csv")

    factor_clustering_test(SR, ff)

    print("\nDone.")


if __name__ == '__main__':
    main()
