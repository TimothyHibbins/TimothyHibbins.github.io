"""
Persistent Cluster Pricing Test (Consensus Clustering)
=======================================================

Fixes the identity problem in the naive cluster test: clusters discovered
fresh each window have no identity across time, so we cannot accumulate a
return time series for any specific cluster.

SOLUTION: consensus / co-association clustering.
  1. On each rolling window, spectral-cluster the stocks (as before).
  2. Build an N x N CO-ASSOCIATION matrix A where A[i,j] = fraction of
     windows (in which both i and j were present) that they landed in the
     same cluster.
  3. Cluster A ONCE to get PERSISTENT clusters: groups of stocks that
     repeatedly co-cluster across the whole sample, even as their exact
     membership and internal correlation drift over time.
  4. For each persistent cluster, compute its full-sample average monthly
     EXCESS return over the market, plus its time-averaged within-corr,
     between-corr, and size.
  5. Test the theory: does excess return line up with the correlation
     structure? Each persistent cluster is now ONE observation with a
     well-estimated mean — exactly what the theory predicts about.

THEORY RECAP
------------
A cluster earns a return above the equity premium when it is internally
correlated (hurts diversification), distinct from the market (avoidable),
and of intermediate size. Every priced cluster's individual stocks should
earn more than the market on average. Crucially we now test RAW excess
return per persistent cluster, not a cross-sectional quintile sort.

We also allow that factors may be UNIONS of several smaller sector-specific
clusters (e.g. small-caps = many sector small-cap pockets), which the
consensus method can reveal.
"""

import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.cluster import SpectralClustering, AgglomerativeClustering
import statsmodels.api as sm
import requests, zipfile, io

# ── Config ──────────────────────────────────────────────────────────────────
STOCK_RETURNS_FILE = 'stock_returns_stooq.csv'
WINDOW             = 36
STEP               = 3
N_CLUSTERS_WIN     = 20     # k per window
N_PERSISTENT       = 30     # number of consensus clusters to extract
MIN_STOCKS_PER_WIN = 200
MIN_CLUSTER_SIZE   = 5
MIN_COMEMBERSHIP   = 12     # require stocks co-present in >= this many windows
WINSOR             = 0.01

FF_BASE  = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
HEADERS  = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}


# ── Data loading (shared with cluster_pricing_test) ─────────────────────────
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
    ff.to_csv(cache)
    return norm_idx(ff)


def load_stock_returns():
    for path in [STOCK_RETURNS_FILE,
                 f'/mnt/user-data/outputs/{STOCK_RETURNS_FILE}']:
        if Path(path).exists():
            print(f"  Loading {path}...")
            df = norm_idx(pd.read_csv(path, index_col=0, parse_dates=True))
            print(f"  ✓ {df.shape[1]} stocks, {df.shape[0]} months")
            return df
    raise FileNotFoundError(f"{STOCK_RETURNS_FILE} not found")


def winsorize(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct * 100), np.nanpercentile(a, (1 - pct) * 100)
    return np.clip(a, lo, hi)


# ── Step 1-2: build co-association matrix ───────────────────────────────────
def build_coassociation(SR, ff):
    """
    Returns:
      tickers      : list of all tickers that appeared in any window
      A            : co-association matrix (n x n), A[i,j] in [0,1]
      copresent    : count matrix of how often i,j were both present
    """
    print(f"\n  Building co-association matrix over rolling windows...")
    rf = ff['RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]
    T = len(common)
    dates = SR.index[WINDOW:T - 1:STEP]

    all_tickers = list(SR.columns)
    tick_idx = {t: i for i, t in enumerate(all_tickers)}
    n = len(all_tickers)

    # Use float32 to keep memory manageable for large n
    same = np.zeros((n, n), dtype=np.float32)
    copres = np.zeros((n, n), dtype=np.float32)

    for di, t in enumerate(dates):
        t_pos = SR.index.get_loc(t)
        win = SR.iloc[t_pos - WINDOW:t_pos]
        valid = win.columns[win.notna().all(axis=0)]
        if len(valid) < MIN_STOCKS_PER_WIN:
            continue
        idx = np.array([tick_idx[c] for c in valid])
        W = win[valid].values
        Ww = np.column_stack([winsorize(W[:, j]) for j in range(W.shape[1])])
        C = np.nan_to_num(np.corrcoef(Ww, rowvar=False), nan=0.0)
        np.fill_diagonal(C, 1.0)

        k = min(N_CLUSTERS_WIN, max(2, len(valid) // MIN_CLUSTER_SIZE))
        try:
            labels = SpectralClustering(
                n_clusters=k, affinity='precomputed',
                assign_labels='kmeans', random_state=0
            ).fit_predict(np.abs(C))
        except Exception:
            continue

        # update co-presence for all pairs in this window
        copres[np.ix_(idx, idx)] += 1.0

        # update same-cluster counts
        for c in np.unique(labels):
            members = idx[labels == c]
            if len(members) < 2:
                continue
            same[np.ix_(members, members)] += 1.0

        if (di + 1) % 20 == 0:
            print(f"    {di+1}/{len(dates)} windows processed...")

    # co-association = fraction of co-present windows in same cluster
    with np.errstate(divide='ignore', invalid='ignore'):
        A = np.where(copres > 0, same / copres, 0.0)
    np.fill_diagonal(A, 1.0)
    print(f"  ✓ Co-association matrix built ({n} stocks)")
    return all_tickers, A, copres


# ── Step 3: extract persistent clusters ─────────────────────────────────────
def extract_persistent_clusters(tickers, A, copres):
    """
    Cluster the co-association matrix once. Only keep stocks that were
    co-present with others in enough windows to have a reliable signal.
    """
    print(f"\n  Extracting {N_PERSISTENT} persistent consensus clusters...")
    n = len(tickers)

    # Keep stocks present in enough windows (diagonal of copres = #windows present)
    present = np.diag(copres)
    keep = np.where(present >= MIN_COMEMBERSHIP)[0]
    print(f"  {len(keep)}/{n} stocks present in >= {MIN_COMEMBERSHIP} windows")
    if len(keep) < N_PERSISTENT * MIN_CLUSTER_SIZE:
        print("  Warning: few stocks survive co-membership filter")

    Asub = A[np.ix_(keep, keep)]
    # distance = 1 - co-association, for agglomerative clustering
    dist = 1.0 - Asub
    np.fill_diagonal(dist, 0.0)

    labels_sub = AgglomerativeClustering(
        n_clusters=N_PERSISTENT, metric='precomputed', linkage='average'
    ).fit_predict(dist)

    # map back to full ticker list
    cluster_members = {}
    for c in np.unique(labels_sub):
        members_local = keep[labels_sub == c]
        if len(members_local) >= MIN_CLUSTER_SIZE:
            cluster_members[c] = [tickers[i] for i in members_local]

    sizes = sorted([len(v) for v in cluster_members.values()], reverse=True)
    print(f"  ✓ {len(cluster_members)} clusters with >= {MIN_CLUSTER_SIZE} "
          f"members")
    print(f"  Cluster sizes: {sizes}")
    return cluster_members


# ── Step 4-5: price persistent clusters ─────────────────────────────────────
def price_persistent_clusters(SR, ff, cluster_members):
    """
    For each persistent cluster compute over the full sample:
      mean_exc    : mean monthly equal-weighted excess return over EW market
      within_corr : time-averaged within-cluster correlation
      between_corr: time-averaged correlation with non-members
      size        : number of members
      market_corr : time-averaged correlation with EW market
    Then test whether mean_exc is explained by the correlation structure.
    """
    print(f"\n  Pricing persistent clusters over full sample...")
    rf  = ff['RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]; rf = rf.loc[common]

    # EW market each month (across all available stocks)
    ew_market = SR.mean(axis=1)

    rows = []
    for c, members in cluster_members.items():
        members = [m for m in members if m in SR.columns]
        if len(members) < MIN_CLUSTER_SIZE:
            continue
        sub = SR[members]

        # monthly EW cluster return
        clust_ret = sub.mean(axis=1)
        exc = (clust_ret - ew_market).dropna()
        if len(exc) < 24:
            continue
        mean_exc = exc.mean()
        t_exc = mean_exc / (exc.std(ddof=1) / np.sqrt(len(exc)))

        # correlation structure, averaged over non-overlapping 36m blocks
        within_list, between_list, mktcorr_list = [], [], []
        others = [col for col in SR.columns if col not in members]
        # sample a subset of "others" for speed
        rng = np.random.default_rng(0)
        if len(others) > 300:
            others = list(rng.choice(others, 300, replace=False))

        idx_all = SR.index
        for start in range(0, len(idx_all) - WINDOW, WINDOW):
            blk = SR.iloc[start:start + WINDOW]
            mem_blk = blk[members].dropna(axis=1, how='any')
            if mem_blk.shape[1] < 3:
                continue
            Cm = np.corrcoef(mem_blk.values, rowvar=False)
            iu = np.triu_indices(Cm.shape[0], k=1)
            if len(iu[0]):
                within_list.append(np.nanmean(Cm[iu]))

            oth_blk = blk[others].dropna(axis=1, how='any')
            if oth_blk.shape[1] >= 3 and mem_blk.shape[1] >= 1:
                # cross-correlation members vs others
                M = mem_blk.values
                O = oth_blk.values
                # standardise
                Mz = (M - M.mean(0)) / (M.std(0) + 1e-9)
                Oz = (O - O.mean(0)) / (O.std(0) + 1e-9)
                cross = (Mz.T @ Oz) / len(M)
                between_list.append(np.nanmean(cross))

            mkt_blk = ew_market.iloc[start:start + WINDOW]
            mc = [np.corrcoef(mem_blk.iloc[:, j], mkt_blk)[0, 1]
                  for j in range(mem_blk.shape[1])]
            mktcorr_list.append(np.nanmean(mc))

        if not within_list:
            continue
        rows.append({
            'cluster':      int(c),
            'size':         len(members),
            'within_corr':  float(np.nanmean(within_list)),
            'between_corr': float(np.nanmean(between_list)) if between_list else np.nan,
            'market_corr':  float(np.nanmean(mktcorr_list)),
            'mean_exc':     float(mean_exc),
            't_exc':        float(t_exc),
            'n_months':     len(exc),
        })

    df = pd.DataFrame(rows)
    if len(df) == 0:
        print("  No clusters could be priced")
        return df

    df['isolation'] = df['within_corr'] - df['between_corr']
    df['frac_size'] = df['size'] / SR.shape[1]

    print(f"\n  Persistent cluster summary (sorted by mean excess return):")
    print(f"  {'clust':>5} {'size':>5} {'within':>7} {'between':>8} "
          f"{'isol':>6} {'mktcorr':>8} {'exc%/mo':>8} {'t':>6}")
    print("  " + "-" * 62)
    for _, r in df.sort_values('mean_exc', ascending=False).iterrows():
        print(f"  {int(r['cluster']):>5} {int(r['size']):>5} "
              f"{r['within_corr']:>7.3f} {r['between_corr']:>8.3f} "
              f"{r['isolation']:>6.3f} {r['market_corr']:>8.3f} "
              f"{r['mean_exc']*100:>+8.3f} {r['t_exc']:>+6.2f}")

    # ── Cross-cluster test: does correlation structure explain excess? ────
    print(f"\n── Cross-Cluster Regression: excess return on structure ─────")
    print(f"  Each persistent cluster is one observation.")
    valid = df.dropna(subset=['within_corr', 'between_corr', 'isolation',
                              'frac_size', 'mean_exc'])
    if len(valid) >= 8:
        # univariate correlations first
        print(f"\n  Univariate correlations with mean excess return:")
        for col in ['within_corr', 'between_corr', 'isolation',
                    'market_corr', 'frac_size']:
            c = np.corrcoef(valid[col], valid['mean_exc'])[0, 1]
            print(f"    {col:<14} corr = {c:+.3f}")

        # multivariate
        X = sm.add_constant(valid[['within_corr', 'between_corr',
                                   'frac_size']].values)
        reg = sm.OLS(valid['mean_exc'].values, X).fit()
        print(f"\n  Multivariate OLS (mean_exc ~ within + between + size):")
        names = ['const', 'within_corr', 'between_corr', 'frac_size']
        for nm, b, t in zip(names, reg.params, reg.tvalues):
            sig = ('***' if abs(t) > 2.58 else ('**' if abs(t) > 1.96
                   else ('*' if abs(t) > 1.65 else '')))
            print(f"    {nm:<14} {b:>+10.4f}  t={t:>+6.2f}{sig}")
        print(f"    R² = {reg.rsquared:.3f}, N = {len(valid)} clusters")

        print(f"\n  Theory predicts: within +, between -, isolation +")
        print(f"  (highly internally correlated, market-distinct clusters")
        print(f"   should earn MORE than the market)")

    # ── Aggregate test: do clusters on average beat the market? ───────────
    print(f"\n── Aggregate Test: average cluster excess return ────────────")
    pos = (df['mean_exc'] > 0).sum()
    print(f"  {pos}/{len(df)} clusters earned positive excess return")
    avg = df['mean_exc'].mean()
    print(f"  Mean excess across clusters: {avg*100:+.3f}%/mo "
          f"({avg*1200:+.2f}%/yr)")
    print(f"  (Equal-weighted market is the benchmark, so this nets to ~0")
    print(f"   by construction unless cluster sizes are uneven — the")
    print(f"   dispersion across clusters is what matters)")

    return df


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    print("Persistent Cluster Pricing Test (consensus clustering)")
    print("=" * 66)

    print("\nLoading factor data...")
    ff = load_ff_factors()
    print(f"  ✓ {ff.shape[0]} months")

    print("\nLoading stock returns...")
    SR = load_stock_returns()

    # cache the co-association matrix since it's expensive
    coassoc_cache = Path('coassociation_matrix.npz')
    if coassoc_cache.exists():
        print("\nLoading cached co-association matrix...")
        d = np.load(coassoc_cache, allow_pickle=True)
        tickers = list(d['tickers'])
        A = d['A']
        copres = d['copres']
        print(f"  ✓ {len(tickers)} stocks")
    else:
        tickers, A, copres = build_coassociation(SR, ff)
        np.savez_compressed(coassoc_cache, tickers=np.array(tickers),
                            A=A, copres=copres)
        print(f"  Saved co-association matrix")

    cluster_members = extract_persistent_clusters(tickers, A, copres)

    df = price_persistent_clusters(SR, ff, cluster_members)
    if df is not None and len(df) > 0:
        df.to_csv('persistent_cluster_pricing.csv', index=False)
        print(f"\n  Saved to persistent_cluster_pricing.csv")

    print("\nDone.")


if __name__ == '__main__':
    main()
