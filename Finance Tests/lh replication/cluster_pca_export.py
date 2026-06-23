"""
PCA Risk Decomposition Export — Overlapping Risk Components
===========================================================

For each rolling window:
  1. Compute correlation matrix from raw returns (no factor removal).
     MDS position will reflect raw co-movement including all factors.
  2. Apply Marchenko-Pastur law to find K: keep only eigenvalues above
     the noise threshold λ_max = (1 + sqrt(n/T))^2.
     K is determined endogenously per window.
  3. For each stock, compute variance fractions:
       frac_k = loading_k^2 * λ_k / sum_all(loading^2 * λ)
     where the denominator is the total explained + residual variance.
     Residual (idiosyncratic) = 1 - sum_k(frac_k).
  4. MDS on raw correlation distance d = sqrt(2(1-corr)).
     Procrustes-aligned to previous frame.
  5. Track component identities across windows by correlation of
     eigenvectors (aligned by maximum inner product matching).

Output: cluster_pca_timeseries.json
  { tickers, frames:[{date, idx, xy, fracs:[[f1,f2,...,fidio],...]}],
    n_components_max, window, n_frames }

fracs[i] = list of variance fractions for stock i in this frame,
last element is always the idiosyncratic residual.
Components are indexed 0..K-1 consistently across frames via tracking.
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.manifold import MDS

WINDOW        = 36
STEP          = 3
MAX_STOCKS    = 600
N_TRACK       = 10
WINSOR        = 0.01
MP_MULTIPLIER = 0.4  # Marchenko-Pastur threshold multiplier.
                     # 1.0 = standard (only clearly reliable components).
                     # 0.5 = recover sector-level components (more noise risk).
                     # With n=600, T=36: noise ceiling ~30.
                     # Sector eigenvalues are typically 5-15 — lower to 0.4
                     # to recover them, or lower MAX_STOCKS to ~150 so
                     # n/T drops and the threshold falls naturally.


def norm_idx(df):
    df = df.copy()
    df.index = pd.to_datetime(df.index).to_period('M').to_timestamp('M')
    return df


def load_returns():
    for p in ['stock_returns_stooq.csv',
              '/mnt/user-data/outputs/stock_returns_stooq.csv']:
        if Path(p).exists():
            print(f"Loading {p}...")
            return norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
    raise FileNotFoundError("stock_returns_stooq.csv not found")


def winsor(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct*100), np.nanpercentile(a, (1-pct)*100)
    return np.clip(a, lo, hi)


def marchenko_pastur_max(n, T, sigma2=1.0):
    """Maximum eigenvalue expected from pure noise (Marchenko-Pastur)."""
    q = T / n
    return sigma2 * (1 + 1/np.sqrt(q))**2 * MP_MULTIPLIER


def procrustes_align(X, ref):
    Xc = X - X.mean(0); Rc = ref - ref.mean(0)
    U, _, Vt = np.linalg.svd(Xc.T @ Rc)
    return Xc @ (U @ Vt) + ref.mean(0)


def classical_mds(D, prev=None):
    n = D.shape[0]
    D2 = D**2
    J = np.eye(n) - np.ones((n,n))/n
    B = -0.5 * J @ D2 @ J
    vals, vecs = np.linalg.eigh(B)
    order = np.argsort(vals)[::-1][:2]
    L = np.sqrt(np.clip(vals[order], 0, None))
    xy = vecs[:, order] * L
    if prev is not None and prev.shape == xy.shape:
        xy = procrustes_align(xy, prev)
    return xy


def match_components(prev_vecs, curr_vecs):
    """
    Match current eigenvectors to previous ones by maximum absolute
    inner product. Returns permutation of current indices aligned to
    previous, and sign corrections.
    prev_vecs, curr_vecs: (n, K) matrices, columns are eigenvectors.
    Returns aligned curr_vecs (same shape, reordered+sign-corrected).
    """
    Kp = prev_vecs.shape[1]
    Kc = curr_vecs.shape[1]
    K = min(Kp, Kc)
    overlap = np.abs(prev_vecs[:, :K].T @ curr_vecs[:, :K])  # Kp x Kc
    aligned = np.zeros_like(curr_vecs)
    used = set()
    order = []
    for i in range(K):
        # find best match for prev component i among unused current components
        row = overlap[i].copy()
        for j in used:
            row[j] = -1
        best_j = int(np.argmax(row))
        used.add(best_j)
        order.append(best_j)
    # reorder current vecs to match previous
    aligned_vecs = curr_vecs.copy()
    for new_i, old_j in enumerate(order):
        sign = 1 if (prev_vecs[:, new_i] @ curr_vecs[:, old_j]) >= 0 else -1
        aligned_vecs[:, new_i] = sign * curr_vecs[:, old_j]
    # any extra current components beyond K go at the end unmatched
    extra = [j for j in range(Kc) if j not in set(order)]
    for ei, ej in enumerate(extra):
        if K+ei < Kc:
            aligned_vecs[:, K+ei] = curr_vecs[:, ej]
    return aligned_vecs


def main():
    SR = load_returns()
    dates = SR.index[WINDOW::STEP]
    nW = len(dates)
    print(f"{nW} windows, {dates[0].date()} to {dates[-1].date()}")

    # presence count for capping
    presence = pd.Series(0, index=SR.columns)
    for t in dates:
        tp = SR.index.get_loc(t)
        blk = SR.iloc[tp-WINDOW:tp]
        ok = blk.columns[blk.notna().all(axis=0)]
        presence[ok] += 1
    # most-present tickers for the cap
    top_tickers = presence.sort_values(ascending=False).head(MAX_STOCKS).index

    all_tickers = list(SR.columns)
    tk_clean = [t.replace('.us','').replace('.US','').upper() for t in all_tickers]
    tk_to_i = {t: i for i, t in enumerate(all_tickers)}

    frames = []
    prev_xy = {}    # global_idx -> [x,y]
    prev_vecs = None  # (n_prev, K_prev) aligned eigenvectors from last window
    max_K_seen = 0

    for fi, t in enumerate(dates):
        tp = SR.index.get_loc(t)
        blk = SR.iloc[tp-WINDOW:tp]
        # stocks with complete data this window, capped to top_tickers
        present = blk.columns[blk.notna().all(axis=0)]
        cols = [c for c in present if c in set(top_tickers)]
        if len(cols) < 10:
            continue
        n = len(cols)
        T = WINDOW
        M = np.column_stack([winsor(blk[c].values) for c in cols])

        # raw correlation matrix
        C = np.corrcoef(M, rowvar=False)
        C = np.nan_to_num(C, nan=0.0)
        np.clip(C, -0.999, 0.999, out=C)
        np.fill_diagonal(C, 1.0)

        # eigendecomposition
        vals, vecs = np.linalg.eigh(C)
        # sort descending
        order = np.argsort(vals)[::-1]
        vals = vals[order]; vecs = vecs[:, order]

        # Marchenko-Pastur threshold
        mp_max = marchenko_pastur_max(n, T, sigma2=1.0)
        K = int(np.sum(vals > mp_max))
        K = max(1, min(K, N_TRACK))
        max_K_seen = max(max_K_seen, K)

        # align eigenvectors to previous window's components
        curr_vecs_K = vecs[:, :K].copy()  # n x K
        if prev_vecs is not None and prev_vecs.shape[0] == n:
            curr_vecs_K = match_components(prev_vecs[:, :min(K, prev_vecs.shape[1])],
                                           curr_vecs_K)
        prev_vecs = curr_vecs_K

        # variance fractions per stock per component
        # var_k(stock i) = loading_{ik}^2 * lambda_k
        # total variance = 1 (diagonal of C)
        # systematic fraction k = loading_{ik}^2 * lambda_k
        # idiosyncratic = 1 - sum_k(loading_{ik}^2 * lambda_k)
        fracs = []
        for i in range(n):
            sys_fracs = []
            for k in range(K):
                f = (curr_vecs_K[i, k]**2) * vals[k]
                sys_fracs.append(max(0.0, f))
            total_sys = sum(sys_fracs)
            idio = max(0.0, 1.0 - total_sys)
            # normalise so fracs sum to 1
            total = total_sys + idio
            if total > 0:
                sys_fracs = [f/total for f in sys_fracs]
                idio = idio/total
            fracs.append([round(f, 4) for f in sys_fracs] + [round(idio, 4)])

        # MDS on RAW correlation distance (not residual)
        D = np.sqrt(2.0*(1.0-C)); np.fill_diagonal(D, 0.0)
        gidx = [tk_to_i[c] for c in cols]
        prev_arr = None
        if prev_xy:
            tmp = np.zeros((n, 2)); have = 0
            for ki, gi in enumerate(gidx):
                if gi in prev_xy:
                    tmp[ki] = prev_xy[gi]; have += 1
            if have > n*0.4:
                prev_arr = tmp
        xy = classical_mds(D, prev_arr)
        for ki, gi in enumerate(gidx):
            prev_xy[gi] = xy[ki]

        frames.append({
            'date': str(t.date()),
            'idx': gidx,
            'xy': xy.astype(np.float32),
            'fracs': fracs,
            'K': K,
        })
        if (fi+1) % 20 == 0:
            print(f"  {fi+1}/{nW}: {n} stocks, K={K} components")

    # normalise coordinates
    allxy = np.vstack([f['xy'] for f in frames])
    ctr = allxy.mean(0); span = np.abs(allxy-ctr).max() or 1.0
    for f in frames:
        f['xy'] = ((f['xy']-ctr)/span).round(4).tolist()

    # load market returns for the miniature chart
    mkt_series = {}
    for p in ['ff_factors_cache.csv',
              '/mnt/user-data/outputs/ff_factors_cache.csv']:
        if Path(p).exists():
            ff = pd.read_csv(p, index_col=0, parse_dates=True)
            ff.index = pd.to_datetime(ff.index).to_period('M').to_timestamp('M')
            for d_frame in dates:
                if d_frame in ff.index:
                    mkt_series[str(d_frame.date())] = round(
                        float(ff.loc[d_frame, 'Mkt-RF']) / 100, 5)
            print(f"  Loaded {len(mkt_series)} market return observations")
            break

    out = {'tickers': tk_clean, 'frames': frames,
           'mkt_series': mkt_series,
           'n_components_max': max_K_seen,
           'mp_multiplier': MP_MULTIPLIER,
           'window': WINDOW, 'n_frames': len(frames)}
    with open('cluster_pca_timeseries.json', 'w') as f:
        json.dump(out, f)
    print(f"\nWrote cluster_pca_timeseries.json")
    print(f"  {len(frames)} frames, max K={max_K_seen} components")
    print(f"  Tune MAX_STOCKS for speed vs coverage")


if __name__ == '__main__':
    main()