"""
Per-Period Correlation Clustering: DBSCAN + Temporal Linking
============================================================

Clusters stocks based on their FACTOR-RESIDUAL correlations each window:
  1. Regress each stock on Mkt-RF, SMB, HML (FF3) in the rolling window
  2. Use the residuals for pairwise correlation — this removes the three
     dominant common factors so residual correlations reflect genuine
     sector/style co-movement ABOVE the known factors
  3. Classical MDS on residual distances
  4. DBSCAN on MDS coordinates to find dense clusters
  5. Temporal linking by Jaccard overlap

Why 3-factor residuals work where cross-sectional demeaning didn't:
  Cross-sectional mean only removes the equal-weighted market factor.
  SMB and HML are also massive common factors — after removing only the
  market, small-cap stocks still all co-move through the size factor,
  making ~50% of all pairs appear highly correlated. Removing all three
  FF factors leaves genuinely idiosyncratic sector/style clusters.
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.cluster import DBSCAN

WINDOW        = 36
STEP          = 6
EPS           = 0.55    # DBSCAN neighbourhood radius in MDS distance units
                        # eps=0.55 -> residual corr >= 0.85 to be neighbours
MIN_SAMPLES   = 8       # min stocks to form a core point / cluster
WINSOR        = 0.01
JACCARD_MIN   = 0.35    # min membership overlap to link clusters across windows


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


def load_ff():
    for p in ['ff_factors_cache.csv',
              '/mnt/user-data/outputs/ff_factors_cache.csv']:
        if Path(p).exists():
            ff = norm_idx(pd.read_csv(p, index_col=0, parse_dates=True))
            print(f"Loaded FF factors: {list(ff.columns)}")
            return ff / 100  # convert from % to decimal
    print("WARNING: ff_factors_cache.csv not found — falling back to "
          "market demeaning only")
    return None


def load_industries():
    for p in ['ticker_industries.csv',
              '/mnt/user-data/outputs/ticker_industries.csv']:
        if Path(p).exists():
            df = pd.read_csv(p)
            return dict(zip(df['ticker'], df['sector']))
    print("  (ticker_industries.csv not found — run fetch_industries.py for sector colour)")
    return {}


def winsor(a, pct=WINSOR):
    lo, hi = np.nanpercentile(a, pct*100), np.nanpercentile(a, (1-pct)*100)
    return np.clip(a, lo, hi)


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


def procrustes_align(X, ref):
    Xc = X - X.mean(0); Rc = ref - ref.mean(0)
    U, _, Vt = np.linalg.svd(Xc.T @ Rc)
    return Xc @ (U @ Vt) + ref.mean(0)


def main():
    SR = load_returns()
    FF = load_ff()
    industries = load_industries()
    dates = SR.index[WINDOW::STEP]
    nW = len(dates)
    print(f"{nW} windows {dates[0].date()} to {dates[-1].date()}")
    print(f"DBSCAN eps={EPS} (residual corr >= {1-EPS**2/2:.2f}), "
          f"min_samples={MIN_SAMPLES}")

    all_tickers = list(SR.columns)
    tk_clean = [t.replace('.us','').replace('.US','').upper() for t in all_tickers]
    tk_to_i = {t: i for i, t in enumerate(all_tickers)}

    frames = []
    prev_xy_by_ticker = {}
    prev_members = {}
    next_cluster_id = 0

    for fi, t in enumerate(dates):
        tp = SR.index.get_loc(t)
        blk = SR.iloc[tp-WINDOW:tp]
        cols = list(blk.columns[blk.notna().all(axis=0)])
        if len(cols) < MIN_SAMPLES * 2:
            continue
        M = np.column_stack([winsor(blk[c].values) for c in cols])

        # FF3 factor residualisation
        # Regress each stock on Mkt-RF, SMB, HML in the window
        # and use residuals for correlation
        if FF is not None:
            ff_blk = FF.loc[FF.index.intersection(blk.index)]
            ff_blk = ff_blk.reindex(blk.index)
            factors = []
            for f_col in ['Mkt-RF', 'SMB', 'HML']:
                if f_col in ff_blk.columns:
                    factors.append(ff_blk[f_col].values)
            if len(factors) >= 1:
                Xf = np.column_stack(factors)
                # add intercept
                Xf = np.column_stack([np.ones(len(Xf)), Xf])
                valid_rows = np.all(np.isfinite(Xf), axis=1)
                Mr = np.zeros_like(M)
                if valid_rows.sum() > len(factors) + 1:
                    try:
                        # OLS: beta = (X'X)^-1 X'Y, residual = Y - X*beta
                        Xv = Xf[valid_rows]
                        beta = np.linalg.lstsq(Xv, M[valid_rows], rcond=None)[0]
                        Mr[valid_rows] = M[valid_rows] - Xv @ beta
                        Mr[~valid_rows] = 0.0
                    except Exception:
                        Mr = M - M.mean(axis=1, keepdims=True)
                else:
                    Mr = M - M.mean(axis=1, keepdims=True)
            else:
                Mr = M - M.mean(axis=1, keepdims=True)
        else:
            # fallback: market demeaning only
            Mr = M - M.mean(axis=1, keepdims=True)

        C = np.corrcoef(Mr, rowvar=False)
        C = np.nan_to_num(C, nan=0.0)
        np.clip(C, -0.999, 0.999, out=C)
        np.fill_diagonal(C, 1.0)

        # proper metric distance matrix (high-dimensional)
        D_mat = np.sqrt(2.0*(1.0-C)); np.fill_diagonal(D_mat, 0.0)

        # MDS embedding — for VISUALISATION only
        gidx = [tk_to_i[c] for c in cols]
        prev_arr = None
        if prev_xy_by_ticker:
            tmp = np.zeros((len(cols),2)); have = 0
            for k,gi in enumerate(gidx):
                if gi in prev_xy_by_ticker:
                    tmp[k] = prev_xy_by_ticker[gi]; have += 1
            if have > len(cols)*0.4:
                prev_arr = tmp
        xy = classical_mds(D_mat, prev_arr)
        for k,gi in enumerate(gidx):
            prev_xy_by_ticker[gi] = xy[k]

        # DBSCAN on TRUE precomputed distances (not 2D projection)
        # This avoids the 2D compression artefact where MDS squashes
        # dissimilar points together, making everything look close.
        # eps here is a true correlation-distance: eps=0.55 means
        # residual corr >= 0.85 in actual correlation space.
        db = DBSCAN(eps=EPS, min_samples=MIN_SAMPLES,
                    metric='precomputed')
        raw_labels = db.fit_predict(D_mat)

        # this window's clusters as sets of global ticker idx
        this_members = {}
        for li, lab in enumerate(raw_labels):
            if lab >= 0:
                this_members.setdefault(lab, set()).add(gidx[li])

        # temporal linking via Jaccard
        assigned = {}
        used_prev = set()
        for comp, mem in sorted(this_members.items(),
                                key=lambda kv: -len(kv[1])):
            best_id, best_j = None, JACCARD_MIN
            for gid, pmem in prev_members.items():
                if gid in used_prev: continue
                inter = len(mem & pmem)
                if inter == 0: continue
                j = inter / len(mem | pmem)
                if j >= best_j:
                    best_j, best_id = j, gid
            if best_id is not None:
                assigned[comp] = best_id
                used_prev.add(best_id)
            else:
                assigned[comp] = next_cluster_id
                next_cluster_id += 1

        prev_members = {assigned[comp]: mem
                        for comp, mem in this_members.items()}

        cl_global = [assigned.get(lab, -1) if lab >= 0 else -1
                     for lab in raw_labels]

        # per-stock return this month (monthly %)
        if tp < len(SR):
            r_this = SR.iloc[tp][cols].values * 100
        else:
            r_this = np.full(len(cols), np.nan)

        frames.append({
            'date': str(t.date()),
            'idx': gidx,
            'xy': xy.astype(np.float32),
            'cl': [int(x) for x in cl_global],
            'ret': [round(float(x),2) if np.isfinite(x) else None
                    for x in r_this],
        })

        if (fi+1) % 20 == 0:
            ncl = len(set(c for c in cl_global if c>=0))
            nclustered = sum(1 for c in cl_global if c>=0)
            print(f"  {fi+1}/{nW}: {len(cols)} stocks, {ncl} clusters, "
                  f"{nclustered} clustered "
                  f"({100*nclustered/len(cols):.0f}%)")

    # normalise coordinates
    allxy = np.vstack([f['xy'] for f in frames])
    ctr = allxy.mean(0); span = np.abs(allxy-ctr).max() or 1.0
    for f in frames:
        f['xy'] = ((f['xy']-ctr)/span).round(4).tolist()

    # sector lookup: global ticker index -> sector name
    sectors = {tk_clean[i]: industries.get(tk_clean[i], 'Unknown')
               for i in range(len(tk_clean))}

    out = {'tickers': tk_clean, 'frames': frames, 'sectors': sectors,
           'window': WINDOW, 'n_frames': len(frames), 'eps': EPS}
    with open('cluster_embedding_timeseries.json','w') as f:
        json.dump(out, f)
    sizes = [len(f['idx']) for f in frames]
    ncls = [len(set(c for c in f['cl'] if c>=0)) for f in frames]
    all_ids = set(c for f in frames for c in f['cl'] if c>=0)
    print(f"\nWrote cluster_embedding_timeseries.json")
    print(f"  {len(frames)} frames, {min(sizes)}-{max(sizes)} stocks/frame")
    print(f"  clusters/frame: {min(ncls)}-{max(ncls)}, "
          f"{len(all_ids)} distinct cluster ids over time")
    print(f"\nTune EPS if needed:")
    print(f"  Too few clusters / everything grey -> lower EPS (try 0.45)")
    print(f"  Too many tiny clusters             -> raise EPS (try 0.65)")


if __name__ == '__main__':
    main()