"""
Cluster Diversification-Cost Test (Equal-Weighted, Marginal Variance)
=====================================================================

Replaces raw within-correlation with the quantity the theory is actually
about: each cluster's MARGINAL CONTRIBUTION to portfolio variance, and
whether UNDERWEIGHTING the cluster lowers or raises portfolio variance.

THEORY
------
A cluster earns a return above the equity premium only if it is a
"removable correlated lump": underweighting it (relative to the
diversified base portfolio) REDUCES total portfolio variance. Such
clusters get sold until their price falls enough that expected return
compensates the marginal investor for the residual risk.

  - Beta / whole market: cannot be underweighted without concentrating
    into fewer names -> underweighting RAISES variance -> no isolated
    premium (it bleeds into everything).
  - Tiny cluster: underweighting barely changes variance -> no premium.
  - Intermediate removable cluster: underweighting LOWERS variance ->
    investors do it -> price falls -> premium emerges.

KEY QUANTITY: diversification gain from dropping the cluster.
For an equal-weighted base portfolio P over N stocks, compare:
    var(P)                       full equal-weighted portfolio
    var(P_without_cluster)       EW portfolio over non-cluster stocks
A cluster is "removable / variance-reducing" if
    var(P_without_cluster) < var(P)
i.e. dropping it improved diversification. We also compute the marginal
risk contribution of the cluster within P.

PREDICTION
----------
Clusters whose removal lowers variance (removable) should earn HIGHER
subsequent returns than clusters whose removal raises variance.
This is the theory-faithful version of the test. If the sign is still
inverted (removable clusters earn LESS), the effect is the low-risk
anomaly, not a diversification-cost premium — and that conclusion is
robust to cap-weighting.

Uses persistent consensus clusters from coassociation_matrix.npz if
present, else discovers clusters per window.

Data: Stooq monthly returns (equal-weighted throughout).
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
N_CLUSTERS_WIN     = 20
N_PERSISTENT       = 30
MIN_STOCKS_PER_WIN = 200
MIN_CLUSTER_SIZE   = 5
MIN_COMEMBERSHIP   = 12
WINSOR             = 0.01

FF_BASE  = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
HEADERS  = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}


# ── Data loading ────────────────────────────────────────────────────────────
def _get_zip(filename, timeout=60):
    r = requests.get(f"{FF_BASE}/{filename}_CSV.zip", headers=HEADERS,
                     timeout=timeout)
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


# ── Marginal variance contribution ──────────────────────────────────────────
def diversification_metrics(R_win, member_mask):
    """
    R_win: WINDOW x n matrix of returns (winsorised), columns = stocks
    member_mask: boolean length-n, True for cluster members

    Returns dict with:
      var_full        : variance of EW portfolio over all n stocks
      var_without     : variance of EW portfolio over NON-members only
      div_gain        : var_full - var_without  (>0 = removal lowers var =
                        removable / variance-reducing cluster)
      mrc             : marginal risk contribution of the cluster to var_full
                        = w_c * Cov(cluster_ret, full_port) / var_full
                        (fraction of portfolio variance attributable to the
                        cluster; compare to the cluster's weight share)
      weight_share    : fraction of names in the cluster
      excess_mrc      : mrc - weight_share (>0 = contributes MORE risk than
                        its weight = risk-concentrating)
    """
    n = R_win.shape[1]
    w_all = np.full(n, 1.0 / n)

    port_full = R_win @ w_all
    var_full = np.var(port_full)

    others = ~member_mask
    n_oth = others.sum()
    if n_oth < 2:
        return None
    w_oth = np.zeros(n)
    w_oth[others] = 1.0 / n_oth
    port_without = R_win @ w_oth
    var_without = np.var(port_without)

    # cluster portfolio (EW within cluster)
    n_mem = member_mask.sum()
    if n_mem < 1:
        return None
    w_c = np.zeros(n)
    w_c[member_mask] = 1.0 / n_mem
    clust_ret = R_win @ w_c
    weight_share = n_mem / n

    cov_cp = np.cov(clust_ret, port_full)[0, 1]
    mrc = weight_share * cov_cp / var_full if var_full > 0 else np.nan

    return {
        'var_full':     var_full,
        'var_without':  var_without,
        'div_gain':     var_full - var_without,
        'mrc':          mrc,
        'weight_share': weight_share,
        'excess_mrc':   mrc - weight_share,
    }


# ── Consensus clusters (reuse cached coassociation if present) ──────────────
def build_or_load_consensus(SR, ff):
    cache = Path('coassociation_matrix.npz')
    if cache.exists():
        print("\n  Loading cached co-association matrix...")
        d = np.load(cache, allow_pickle=True)
        tickers, A, copres = list(d['tickers']), d['A'], d['copres']
        print(f"  ✓ {len(tickers)} stocks")
    else:
        print("\n  Building co-association matrix (no cache found)...")
        tickers, A, copres = _build_coassoc(SR, ff)
        np.savez_compressed(cache, tickers=np.array(tickers),
                            A=A, copres=copres)

    present = np.diag(copres)
    keep = np.where(present >= MIN_COMEMBERSHIP)[0]
    Asub = A[np.ix_(keep, keep)]
    dist = 1.0 - Asub
    np.fill_diagonal(dist, 0.0)
    labels = AgglomerativeClustering(
        n_clusters=N_PERSISTENT, metric='precomputed', linkage='average'
    ).fit_predict(dist)

    members = {}
    for c in np.unique(labels):
        ml = keep[labels == c]
        if len(ml) >= MIN_CLUSTER_SIZE:
            members[int(c)] = [tickers[i] for i in ml]
    print(f"  ✓ {len(members)} persistent clusters")
    return members


def _build_coassoc(SR, ff):
    rf = ff['RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]
    T = len(common)
    dates = SR.index[WINDOW:T - 1:STEP]
    tickers = list(SR.columns)
    ti = {t: i for i, t in enumerate(tickers)}
    n = len(tickers)
    same = np.zeros((n, n), dtype=np.float32)
    copres = np.zeros((n, n), dtype=np.float32)
    for di, t in enumerate(dates):
        tp = SR.index.get_loc(t)
        win = SR.iloc[tp - WINDOW:tp]
        valid = win.columns[win.notna().all(axis=0)]
        if len(valid) < MIN_STOCKS_PER_WIN:
            continue
        idx = np.array([ti[c] for c in valid])
        W = win[valid].values
        Ww = np.column_stack([winsorize(W[:, j]) for j in range(W.shape[1])])
        C = np.nan_to_num(np.corrcoef(Ww, rowvar=False), nan=0.0)
        np.fill_diagonal(C, 1.0)
        k = min(N_CLUSTERS_WIN, max(2, len(valid) // MIN_CLUSTER_SIZE))
        try:
            labels = SpectralClustering(
                n_clusters=k, affinity='precomputed',
                assign_labels='kmeans', random_state=0).fit_predict(np.abs(C))
        except Exception:
            continue
        copres[np.ix_(idx, idx)] += 1.0
        for c in np.unique(labels):
            m = idx[labels == c]
            if len(m) >= 2:
                same[np.ix_(m, m)] += 1.0
        if (di + 1) % 20 == 0:
            print(f"    {di+1}/{len(dates)} windows...")
    with np.errstate(divide='ignore', invalid='ignore'):
        A = np.where(copres > 0, same / copres, 0.0)
    np.fill_diagonal(A, 1.0)
    return tickers, A, copres


# ── Price persistent clusters by diversification metrics ────────────────────
def price_by_diversification(SR, ff, members):
    print(f"\n  Pricing clusters by marginal variance contribution...")
    rf = ff['RF'] / 100
    common = SR.index.intersection(rf.index)
    SR = SR.loc[common]; rf = rf.loc[common]
    T = len(common)

    member_set_all = {c: set(m for m in mem if m in SR.columns)
                      for c, mem in members.items()}

    # precompute member index sets
    rows = []
    for c, mem in members.items():
        mem = [m for m in mem if m in SR.columns]
        if len(mem) < MIN_CLUSTER_SIZE:
            continue

        # Benchmark each cluster against its COMPLEMENT (all non-members),
        # not the EW market. The EW-market benchmark attenuates the true
        # cluster-vs-rest difference by a factor (n_others/N), which biases
        # large clusters toward zero excess. Complement benchmark is the
        # clean size-independent contrast: clust_ret - complement_ret.
        non_mem = [col for col in SR.columns if col not in set(mem)]
        clust_ret = SR[mem].mean(axis=1)
        comp_ret  = SR[non_mem].mean(axis=1)
        exc = (clust_ret - comp_ret).dropna()
        if len(exc) < 24:
            continue
        mean_exc = exc.mean()
        t_exc = mean_exc / (exc.std(ddof=1) / np.sqrt(len(exc)))

        # also store raw cluster and complement returns for inspection
        raw_clust = clust_ret.mean()
        raw_comp  = comp_ret.mean()

        # time-averaged diversification metrics over non-overlapping windows
        dg, mrc, exmrc, wsh, within = [], [], [], [], []
        idx_all = SR.index
        for start in range(0, len(idx_all) - WINDOW, WINDOW):
            blk = SR.iloc[start:start + WINDOW]
            valid = blk.columns[blk.notna().all(axis=0)]
            if len(valid) < MIN_STOCKS_PER_WIN:
                continue
            mem_in = [m for m in mem if m in valid]
            if len(mem_in) < 3:
                continue
            cols = list(valid)
            R = np.column_stack([winsorize(blk[c].values) for c in cols])
            mask = np.array([c in set(mem_in) for c in cols])
            met = diversification_metrics(R, mask)
            if met is None:
                continue
            dg.append(met['div_gain'])
            mrc.append(met['mrc'])
            exmrc.append(met['excess_mrc'])
            wsh.append(met['weight_share'])
            # within-corr for reference
            sub = np.corrcoef(R[:, mask], rowvar=False)
            iu = np.triu_indices(sub.shape[0], k=1)
            if len(iu[0]):
                within.append(np.nanmean(sub[iu]))

        if not dg:
            continue
        rows.append({
            'cluster':      c,
            'size':         len(mem),
            'mean_exc':     mean_exc,
            't_exc':        t_exc,
            'raw_clust':    raw_clust,
            'raw_comp':     raw_comp,
            'div_gain':     np.mean(dg),        # >0 = removable (var-reducing)
            'mrc':          np.mean(mrc),
            'excess_mrc':   np.mean(exmrc),     # >0 = risk-concentrating
            'weight_share': np.mean(wsh),
            'within_corr':  np.mean(within) if within else np.nan,
            'n_months':     len(exc),
        })

    df = pd.DataFrame(rows)
    if len(df) == 0:
        print("  No clusters priced")
        return df

    print(f"\n  {'clust':>5} {'size':>5} {'div_gain':>10} {'exMRC':>8} "
          f"{'within':>7} {'clust%':>7} {'comp%':>7} {'diff%':>7} {'t':>6}")
    print("  " + "-" * 70)
    for _, r in df.sort_values('mean_exc', ascending=False).iterrows():
        print(f"  {int(r['cluster']):>5} {int(r['size']):>5} "
              f"{r['div_gain']*1e4:>+10.3f} {r['excess_mrc']:>+8.3f} "
              f"{r['within_corr']:>7.3f} {r['raw_clust']*100:>+7.3f} "
              f"{r['raw_comp']*100:>+7.3f} {r['mean_exc']*100:>+7.3f} "
              f"{r['t_exc']:>+6.2f}")
    print(f"  (diff = clust - complement, the size-independent contrast)")
    print(f"  (div_gain x1e4; >0 = removing cluster LOWERS variance = "
          f"removable)")
    print(f"  (exMRC >0 = cluster contributes more risk than its weight)")

    # ── The key test ──────────────────────────────────────────────────────
    print(f"\n── Key Test: does removability predict the premium? ─────────")
    print(f"  Theory: removable clusters (div_gain>0) should earn MORE.")
    valid = df.dropna(subset=['div_gain', 'excess_mrc', 'mean_exc'])
    if len(valid) >= 8:
        print(f"\n  Univariate correlations with mean excess return:")
        for col in ['div_gain', 'mrc', 'excess_mrc', 'within_corr',
                    'weight_share']:
            cc = np.corrcoef(valid[col], valid['mean_exc'])[0, 1]
            print(f"    {col:<14} corr = {cc:+.3f}")

        print(f"\n  Split by removability:")
        rem = valid[valid['div_gain'] > 0]
        non = valid[valid['div_gain'] <= 0]
        if len(rem) and len(non):
            print(f"    Removable    (div_gain>0): {len(rem)} clusters, "
                  f"mean exc {rem['mean_exc'].mean()*100:+.3f}%/mo")
            print(f"    Non-removable(div_gain<=0): {len(non)} clusters, "
                  f"mean exc {non['mean_exc'].mean()*100:+.3f}%/mo")
            diff = rem['mean_exc'].mean() - non['mean_exc'].mean()
            print(f"    Difference: {diff*100:+.3f}%/mo "
                  f"(theory predicts POSITIVE)")

        # multivariate
        X = sm.add_constant(valid[['div_gain', 'excess_mrc',
                                   'weight_share']].values)
        reg = sm.OLS(valid['mean_exc'].values, X).fit()
        print(f"\n  Multivariate OLS (exc ~ div_gain + excess_mrc + weight):")
        for nm, b, t in zip(['const', 'div_gain', 'excess_mrc',
                             'weight_share'], reg.params, reg.tvalues):
            sig = ('***' if abs(t) > 2.58 else ('**' if abs(t) > 1.96
                   else ('*' if abs(t) > 1.65 else '')))
            print(f"    {nm:<14} {b:>+12.4f}  t={t:>+6.2f}{sig}")
        print(f"    R² = {reg.rsquared:.3f}, N = {len(valid)}")

    return df


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    print("Cluster Diversification-Cost Test (equal-weighted, marginal var)")
    print("=" * 66)
    print("\nLoading factor data...")
    ff = load_ff_factors()
    print(f"  ✓ {ff.shape[0]} months")
    print("\nLoading stock returns...")
    SR = load_stock_returns()

    members = build_or_load_consensus(SR, ff)
    df = price_by_diversification(SR, ff, members)
    if df is not None and len(df) > 0:
        df.to_csv('cluster_diversification_pricing.csv', index=False)
        print(f"\n  Saved to cluster_diversification_pricing.csv")
    print("\nDone.")


if __name__ == '__main__':
    main()