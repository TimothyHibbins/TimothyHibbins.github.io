"""
Per-Period Correlation Embedding - Landmark MDS (all stocks)
============================================================

Scales the per-period correlation map to the FULL universe by landmark
(out-of-sample) MDS:

  1. Choose ~250 "landmark" stocks present in most windows.
  2. In each window, run full MDS on the landmark distance matrix
     (proper metric d = sqrt(2(1-corr))), Procrustes-aligned to the
     previous frame for smooth playback.
  3. Place EVERY other stock present in that window by its distances to
     the landmarks (out-of-sample projection). O(n * L), scales to thousands.

Stocks appear in a frame only when they have full data in that window,
so names enter/leave as they list and delist.

Output: cluster_embedding_timeseries.json
  { tickers:[all], frames:[{date, idx:[present indices], xy:[[x,y]...]}],
    clusters:{ticker:cid}, cluster_stats:{cid:{within_corr,mean_exc}} }
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.manifold import MDS
from sklearn.cluster import AgglomerativeClustering

WINDOW           = 36
STEP             = 3
N_LANDMARKS      = 250
LANDMARK_FRAC    = 0.80
WINSOR           = 0.01
N_PERSISTENT     = 30
MIN_COMEMBERSHIP = 12


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


def procrustes_align(X, ref):
    Xc = X - X.mean(0); Rc = ref - ref.mean(0)
    U, _, Vt = np.linalg.svd(Xc.T @ Rc)
    return Xc @ (U @ Vt) + ref.mean(0)


def corr_to_dist(M):
    C = np.corrcoef(M, rowvar=False)
    C = np.nan_to_num(C, nan=0.0)
    np.clip(C, -0.999, 0.999, out=C)
    np.fill_diagonal(C, 1.0)
    D = np.sqrt(2.0*(1.0-C))
    np.fill_diagonal(D, 0.0)
    return C, D


def place_by_landmarks(M_all, land_cols_idx, land_xy):
    Tn, n = M_all.shape
    Z = (M_all - M_all.mean(0)) / (M_all.std(0) + 1e-9)
    L = Z[:, land_cols_idx]
    corr = (Z.T @ L) / Tn
    np.clip(corr, -0.999, 0.999, out=corr)
    dist = np.sqrt(2.0*(1.0-corr))
    w = 1.0 / (dist**2 + 1e-3)
    k = min(8, land_xy.shape[0])
    if land_xy.shape[0] > k:
        part = np.argpartition(dist, k, axis=1)[:, :k]
        mask = np.zeros_like(w)
        rows = np.arange(n)[:, None]
        mask[rows, part] = 1.0
        w = w * mask
    w_sum = w.sum(1, keepdims=True) + 1e-12
    return (w @ land_xy) / w_sum


def load_persistent_clusters():
    cmap, stats = {}, {}
    npz = next((p for p in ['coassociation_matrix.npz',
        '/mnt/user-data/outputs/coassociation_matrix.npz'] if Path(p).exists()),
        None)
    if npz:
        d = np.load(npz, allow_pickle=True)
        tk, A, copres = list(d['tickers']), d['A'], d['copres']
        keep = np.where(np.diag(copres) >= MIN_COMEMBERSHIP)[0]
        dist = 1.0 - A[np.ix_(keep, keep)]
        np.fill_diagonal(dist, 0.0); dist = (dist+dist.T)/2
        lab = AgglomerativeClustering(n_clusters=N_PERSISTENT,
            metric='precomputed', linkage='average').fit_predict(dist)
        for j, gi in enumerate(keep):
            cmap[tk[gi].replace('.us','').replace('.US','').upper()] = int(lab[j])
    pr = next((p for p in ['cluster_diversification_pricing.csv',
        '/mnt/user-data/outputs/cluster_diversification_pricing.csv']
        if Path(p).exists()), None)
    if pr:
        for _, r in pd.read_csv(pr).iterrows():
            stats[int(r['cluster'])] = {
                'within_corr': round(float(r['within_corr']),3),
                'mean_exc': round(float(r['mean_exc'])*100,3)}
    return cmap, stats


def main():
    SR = load_returns()
    dates = SR.index[WINDOW::STEP]
    nW = len(dates)
    print(f"{nW} windows {dates[0].date()} to {dates[-1].date()}")

    present = pd.Series(0, index=SR.columns)
    slices = []
    for t in dates:
        tp = SR.index.get_loc(t)
        blk = SR.iloc[tp-WINDOW:tp]
        ok = blk.columns[blk.notna().all(axis=0)]
        present[ok] += 1
        slices.append((t, tp))
    frac = present/nW

    land = frac[frac >= LANDMARK_FRAC].sort_values(ascending=False)
    landmarks = land.head(N_LANDMARKS).index.tolist()
    if len(landmarks) < 30:
        landmarks = frac.sort_values(ascending=False).head(N_LANDMARKS).index.tolist()
    print(f"{len(landmarks)} landmarks (present >= {LANDMARK_FRAC:.0%})")

    all_tickers = list(SR.columns)
    tk_clean = [t.replace('.us','').replace('.US','').upper() for t in all_tickers]
    tk_to_i = {t: i for i, t in enumerate(all_tickers)}

    mds = MDS(n_components=2, dissimilarity='precomputed', random_state=0,
              n_init=1, max_iter=300, normalized_stress='auto')
    frames = []
    prev_land_xy = None

    for fi, (t, tp) in enumerate(slices):
        blk = SR.iloc[tp-WINDOW:tp]
        present_cols = blk.columns[blk.notna().all(axis=0)]
        present_set = set(present_cols)
        land_here = [c for c in landmarks if c in present_set]
        if len(land_here) < 20:
            continue
        Ml = np.column_stack([winsor(blk[c].values) for c in land_here])
        _, Dl = corr_to_dist(Ml)
        lxy = mds.fit_transform(Dl)
        if prev_land_xy is not None and prev_land_xy.shape == lxy.shape:
            lxy = procrustes_align(lxy, prev_land_xy)
        prev_land_xy = lxy

        cols = list(present_cols)
        Mall = np.column_stack([winsor(blk[c].values) for c in cols])
        land_local_idx = [cols.index(c) for c in land_here]
        xy = place_by_landmarks(Mall, land_local_idx, lxy)
        for li, c in enumerate(land_here):
            xy[cols.index(c)] = lxy[li]

        idx = [tk_to_i[c] for c in cols]
        frames.append({'date': str(t.date()), 'idx': idx,
                       'xy': xy.astype(np.float32)})
        if (fi+1) % 20 == 0:
            print(f"  {fi+1}/{nW} frames, {len(cols)} stocks this window...")

    allxy = np.vstack([f['xy'] for f in frames])
    ctr = allxy.mean(0); span = np.abs(allxy-ctr).max() or 1.0
    for f in frames:
        f['xy'] = ((f['xy']-ctr)/span).round(4).tolist()

    cmap, stats = load_persistent_clusters()
    clusters = {tk_clean[i]: cmap.get(tk_clean[i], -1)
                for i in range(len(tk_clean))}

    out = {'tickers': tk_clean, 'frames': frames, 'clusters': clusters,
           'cluster_stats': stats, 'window': WINDOW,
           'n_frames': len(frames), 'n_landmarks': len(landmarks)}
    with open('cluster_embedding_timeseries.json','w') as f:
        json.dump(out, f)
    sizes = [len(f['idx']) for f in frames]
    print(f"Wrote cluster_embedding_timeseries.json")
    print(f"  {len(frames)} frames, {min(sizes)}-{max(sizes)} stocks/frame, "
          f"{len(tk_clean)} total tickers")


if __name__ == '__main__':
    main()