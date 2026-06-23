"""
Inspect Extreme Cluster Membership
==================================

Loads the cached co-association matrix, reconstructs the same persistent
consensus clusters (identical settings to cluster_diversification_test.py),
and prints the member tickers for the clusters of interest so we can see
what they actually are.

Clusters of interest from the pricing run:
  HIGH return, LOW within-corr (diffuse winners):   17, 21, 1
  LOW  return, HIGH within-corr (tight losers):     15, 16, 27, 26
  The giant puzzle cluster:                          28
"""

import numpy as np
from pathlib import Path
from sklearn.cluster import AgglomerativeClustering

N_PERSISTENT     = 30
MIN_CLUSTER_SIZE = 5
MIN_COMEMBERSHIP = 12

INTEREST = [17, 21, 1, 15, 16, 27, 26, 28, 19, 23]
SHOW_MAX = 60   # max tickers to print per cluster


def main():
    cache = Path('coassociation_matrix.npz')
    if not cache.exists():
        cache = Path('/mnt/user-data/outputs/coassociation_matrix.npz')
    if not cache.exists():
        print("coassociation_matrix.npz not found — run the cluster test first")
        return

    d = np.load(cache, allow_pickle=True)
    tickers = list(d['tickers'])
    A = d['A']
    copres = d['copres']
    print(f"Loaded co-association matrix: {len(tickers)} stocks")

    present = np.diag(copres)
    keep = np.where(present >= MIN_COMEMBERSHIP)[0]
    Asub = A[np.ix_(keep, keep)]
    dist = 1.0 - Asub
    np.fill_diagonal(dist, 0.0)

    labels = AgglomerativeClustering(
        n_clusters=N_PERSISTENT, metric='precomputed', linkage='average'
    ).fit_predict(dist)

    # rebuild cluster -> tickers exactly as the pricing script did
    members = {}
    for c in np.unique(labels):
        ml = keep[labels == c]
        if len(ml) >= MIN_CLUSTER_SIZE:
            members[int(c)] = [tickers[i] for i in ml]

    print(f"{len(members)} clusters reconstructed\n")

    for c in INTEREST:
        if c not in members:
            print(f"Cluster {c}: (not present)\n")
            continue
        mem = members[c]
        # strip any .us suffix and uppercase for readability
        clean = sorted(m.replace('.us', '').replace('.US', '').upper()
                       for m in mem)
        print(f"{'='*66}")
        print(f"Cluster {c}  —  {len(mem)} stocks")
        print(f"{'='*66}")
        shown = clean[:SHOW_MAX]
        # print in rows of 10
        for i in range(0, len(shown), 10):
            print("  " + "  ".join(f"{t:<7}" for t in shown[i:i+10]))
        if len(clean) > SHOW_MAX:
            print(f"  ... and {len(clean)-SHOW_MAX} more")
        print()


if __name__ == '__main__':
    main()
