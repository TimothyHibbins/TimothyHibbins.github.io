"""
Lambert-Hübner (2013) Full Replication — Individual Stocks
============================================================

Full methodology:
1. Download individual stock returns for S&P 500 constituents
2. Estimate coskewness and cokurtosis for each stock from lookback window
3. Sort stocks into comoment-sorted portfolios (long low coskew / short high)
4. Test whether comoment factor portfolios earn significant premiums
5. Test whether FF6 portfolio returns load on comoment factors
6. Test mediation: do comoments explain why FF6 factors earn premiums?

Data source: yfinance for individual stock returns (approx S&P 500 universe)
             Ken French for FF factors and test portfolios

Note: yfinance data has survivorship bias — only includes currently listed
stocks. For a cleaner test, CRSP via WRDS is needed. But this gives
a reasonable approximation for the purpose of replication.
"""

import sys, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy import stats
import statsmodels.api as sm
import requests, zipfile, io
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from pathlib import Path

try:
    import yfinance as yf
    HAS_YF = True
except ImportError:
    HAS_YF = False
    print("WARNING: yfinance not installed. Run: pip install yfinance")

# ── Configuration ─────────────────────────────────────────────────────────────

# S&P 500 tickers — using a representative subset spanning all sectors
# Full S&P 500 would be better but takes longer to download
def get_sp1500_tickers():
    """
    Fetch current S&P 1500 constituents from Wikipedia.
    Falls back to a hardcoded representative sample if unavailable.
    """
    import requests
    from io import StringIO

    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}

    def _fetch_wiki_tickers(url, col_hint='Symbol'):
        r = requests.get(url, headers=headers, timeout=15)
        tables = pd.read_html(StringIO(r.text))
        df = tables[0]
        for col in df.columns:
            if any(h in str(col).lower() for h in ['symbol','ticker']):
                tickers = df[col].dropna().tolist()
                return [str(t).replace('.','-').strip()
                        for t in tickers if str(t).strip()]
        return []

    all_tickers = []
    for name, url in [
        ('S&P 500', 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'),
        ('S&P 400', 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies'),
        ('S&P 600', 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies'),
    ]:
        try:
            tickers = _fetch_wiki_tickers(url)
            all_tickers.extend(tickers)
            print(f"  ✓ {name}: {len(tickers)} tickers")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    # Deduplicate and clean
    all_tickers = list(dict.fromkeys(
        t for t in all_tickers
        if t and len(t) <= 6 and t.replace('-','').isalpha()
    ))

    if len(all_tickers) < 100:
        print("  Wikipedia fetch insufficient, using hardcoded fallback...")
        all_tickers = FALLBACK_TICKERS

    print(f"  Total universe: {len(all_tickers)} tickers")
    return all_tickers


# Hardcoded fallback — representative S&P 1500 sample spanning all sectors
# S&P 500 (large cap)
_SP500 = [
    "AAPL","MSFT","NVDA","AVGO","AMD","ORCL","ADBE","AMAT","QCOM","TXN",
    "INTC","MU","KLAC","LRCX","SNPS","CDNS","FTNT","NOW","CRM","INTU",
    "PANW","CRWD","PLTR","ANSS","CTSH","GDDY","HPE","HPQ","IBM","JNPR",
    "GOOGL","GOOG","META","NFLX","TMUS","VZ","T","CMCSA","DIS","EA",
    "TTWO","FOXA","FOX","LYV","MTCH","PINS","WBD","PARA","OMC","IPG",
    "AMZN","TSLA","HD","MCD","NKE","SBUX","TJX","BKNG","MAR","CMG",
    "ORLY","AZO","BBY","EBAY","EXPE","GM","F","APTV","LVS","MGM",
    "PHM","DHI","LEN","TOL","NVR","POOL","ROST","TGT","LOW","DG",
    "DLTR","FIVE","ULTA","RH","WSM","HAS","MAT","PVH","RL","TPR",
    "WMT","COST","PG","KO","PEP","PM","MO","MDLZ","CL","GIS",
    "STZ","KHC","HRL","SJM","CAG","CPB","MKC","CHD","CLX","KMB",
    "WBA","EL","TSN","SFM","INGR","BG","ADM","FMC","IFF","HSY",
    "LLY","UNH","JNJ","MRK","ABBV","TMO","ABT","ISRG","AMGN","GILD",
    "VRTX","REGN","BSX","EW","ZBH","BAX","BDX","IDXX","IQV","DXCM",
    "BIIB","BMY","CI","DVA","HCA","HUM","MCK","MOH","PFE","CNC",
    "A","ALGN","ILMN","INCY","MTD","RMD","STE","HOLX","GEHC","RVTY",
    "JPM","V","MA","BAC","WFC","GS","MS","BLK","AXP","SPGI",
    "CB","MMC","AON","TRV","AFL","PRU","MET","AIG","ALL","PGR",
    "ICE","CME","NDAQ","CBOE","IVZ","BEN","TROW","NTRS","STT","BK",
    "USB","PNC","TFC","CFG","FITB","HBAN","KEY","MTB","RF","SCHW",
    "COF","DFS","SYF","ALLY","APO","KKR","CG","BX","ARES","C",
    "CAT","RTX","LMT","DE","UPS","HON","GE","MMM","ETN","ITW",
    "EMR","PH","ROK","DOV","AME","FTV","XYL","CARR","OTIS","TDY",
    "BA","GD","NOC","HII","TDG","HWM","AXON","LDOS","BAH","SAIC",
    "CSX","UNP","NSC","WAB","JBHT","EXPD","CHRW","XPO","SAIA","FDX",
    "ODFL","ADP","PAYX","CTAS","FAST","GWW","WSO","SWK","SNA","PCAR",
    "CMI","OSK","WCN","RSG","GFL","AGCO","TEX","GNRC","JCI","IR",
    "XOM","CVX","COP","SLB","PSX","VLO","MPC","EOG","HAL","OXY",
    "DVN","HES","MRO","APA","BKR","KMI","WMB","OKE","ET","EPD",
    "CTRA","PR","SM","RRC","EQT","TRGP","MMP","AM","CQP","LNG",
    "LIN","APD","ECL","NEM","FCX","NUE","VMC","MLM","ALB","CF",
    "MOS","PPG","SHW","AVY","SEE","PKG","IP","WRK","CC","OLN",
    "AA","KALU","ATI","CRS","HUN","EMN","RPM","FUL","ASH","NEU",
    "NEE","DUK","SO","D","AEP","EXC","SRE","PEG","ED","ES",
    "XEL","WEC","CMS","LNT","EVRG","NI","AES","ETR","FE","PPL",
    "AWK","WTRG","SJW","PCG","EIX","PNW","NWE","OTTER","AVA","NWN",
    "PLD","AMT","CCI","EQIX","PSA","O","WELL","DLR","EQR","AVB",
    "VTR","SPG","BXP","KIM","REG","NNN","STAG","COLD","CUBE","LSI",
    "MAA","UDR","CPT","ESS","NHI","OHI","DOC","SBRA","MPW","HR",
]

_SP400 = [
    "AKAM","ANET","CHKP","FFIV","FLEX","GLOB","GWRE","MANH","MKSI","NATI",
    "PEGA","QLYS","RGEN","SMCI","SYNA","TRMB","TYL","VIAV","WEX","DOCN",
    "BRZE","CFLT","GTLB","HUBS","PCTY","PAYC","AZPN","BMRN","CGNX","COHU",
    "DIOD","ENTG","FORM","ICHR","IPGP","MKSI","NXPI","ONTO","RMBS","UCTT",
    "ACAD","ALKS","CRVL","CTLT","ELAN","ENSG","GDRX","GMED","HIMS","LGND",
    "LMAT","MDXG","MGLN","MLAB","OMCL","PCRX","PDCO","PINC","PRVA","RDNT",
    "SAGE","SUPN","TNDM","USPH","UFPT","NVCR","PCRX","PRVB","XENE","ACLS",
    "AX","BOKF","CATY","CBSH","CFR","CMA","EWBC","FAF","FBP","GBCI",
    "HOPE","HTH","IBOC","INDB","LKFN","MBWM","NBTB","PACW","PRAA","RBCAA",
    "SBCF","SFBS","STBA","TCBI","TFIN","TOWN","TRMK","UMPQ","WAFD","WBS",
    "WSFS","WTFC","HTLF","FFBC","FULT","OKSB","OZRK","SEIC","SNV","UMBF",
    "AGCO","AIN","ALGT","ARCB","ASTE","ATR","AVAV","AWI","BCO","BERY",
    "BLD","BLDR","BMI","BWXT","CACI","CABO","CALM","CBRE","CDAY","CECO",
    "CENX","CFX","CPRT","CR","CSWI","DCI","DFIN","DY","EGP","ENS",
    "ESAB","ESE","EXPO","EXP","FELE","GNSS","HRI","HUBB","HURN","IIIN",
    "ABM","ACC","ACM","AEO","AFG","AIRC","AIT","ALRM","AMKR","AMPH",
    "AMWD","ANDE","APG","APOG","AR","ARCB","ARCH","ARWR","ASIX","ASO",
    "ATEC","ATH","BCO","BKH","BLMN","BOX","BRKL","BVS","CAKE","CARS",
    "CASY","CATO","CBT","CCOI","CCO","CDAY","CDK","CDNA","CENT","CENTA",
    "CFFI","CFR","CGNX","CHE","CHEF","CHGG","CHH","CHRS","CHX","CIEN",
]

_SP600 = [
    "ACLS","AEHR","ALTR","AMKR","AOSL","APPS","ATEN","ATNI","AVNW","AXTI",
    "BAND","BCPC","BLKB","CLFD","CMPR","COHU","EGHT","EMKR","EPAY","EVERI",
    "EVTC","EXTR","FIVN","FORM","FOUR","HLIT","HOLI","HSTM","IDCC","IMAX",
    "INMD","IRTC","JJSF","KFRC","KNSL","KRYS","LAKE","LANC","LAWS","LBRT",
    "LCII","AMED","AMPH","ANIK","ANIP","APLS","ATRC","ATRS","AUPH","AXNX",
    "AAME","ABCB","ACNB","AFBI","AKR","ALCO","AMNB","AMTB","AMWD","ANCX",
    "AAON","ACM","ACRX","ACV","ADUS","AEIS","AEO","AERI","AEVA","AFG",
    "AGCO","AGFS","AGO","AGR","AGRX","AGS","AGYS","AHCO","AIRC","AIT",
    "AJRD","AKR","AKTS","AKUS","ALCO","ALCY","ALDX","ALEC","ALGT","ALIO",
    "ALRM","ALRT","ALSE","ALTE","ALTI","ALVO","ALXO","AMAG","AMBC","AMNB",
    "AMRB","AMSF","AMTB","AMTD","AMWD","ANCX","ANDE","ANGI","ANGO","ANIK",
    "ANNX","AOUT","APEI","APEX","APLS","APLT","APOG","APTS","APY","ARAY",
    "ARCB","ARCC","ARCH","ARCB","AROW","ARS","ARWR","ASIX","ASTH","ASX",
    "ATCO","ATEC","ATEN","ATH","ATNI","ATRO","ATRC","ATRS","ATSG","ATUS",
    "ATXI","ATXS","AU","AUDC","AUID","AUPH","AURC","AURX","AUSS","AUTO",
    "AVAV","AVDL","AVEO","AVEN","AVHI","AVID","AVIG","AVIN","AVIR","AVIS",
    "AVNW","AVPT","AVRO","AVRP","AVTE","AVTR","AVTY","AVXL","AWH","AWI",
    "AWRE","AWX","AXDX","AXGN","AXL","AXNX","AXSM","AXTA","AXTI","AY",
    "AYRO","AYX","AZEK","AZPN","AZRE","AZTA","AZZ","BANF","BANR","BCAL",
    "BCBP","BCEI","BCLI","BCML","BCPC","BCSA","BCYC","BDSI","BDSX","BFIN",
    "BFST","BGCP","BGFV","BGS","BHVN","BKDT","BKE","BKNG","BKSC","BKSY",
    "BLBD","BLFS","BLMN","BLNK","BLPH","BLRX","BLUE","BLX","BMBL","BMEA",
    "BMRC","BMRN","BMTC","BNL","BNOX","BNST","BOCH","BODY","BOJA","BOLT",
]

FALLBACK_TICKERS = list(dict.fromkeys(_SP500 + _SP400 + _SP600))


# Use dynamic fetching at runtime
SP500_TICKERS = None  # will be populated in main()

START_DATE = "1990-01-01"
END_DATE   = "2024-12-31"
LOOKBACK_MONTHS = 60   # 5-year lookback for comoment estimation
FORWARD_MONTHS  = 12   # 1-year forward return
STEP_MONTHS     = 12   # annual rebalancing
N_SORT_DECILES  = 5    # sort into quintiles (Lambert-Hubner use deciles, we use 5)

# ── French data ───────────────────────────────────────────────────────────────

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

def fetch_ff_factors():
    """Fetch FF factors with multiple fallbacks."""

    # ── Fallback 1: pandas_datareader (uses FRED/Quandl mirror) ──────────
    try:
        import pandas_datareader.data as web
        print("  Fetching FF factors via pandas_datareader...")
        ff5 = web.DataReader('F-F_Research_Data_5_Factors_2x3', 'famafrench',
                              start='1963-01-01')[0]
        mom = web.DataReader('F-F_Momentum_Factor', 'famafrench',
                              start='1963-01-01')[0]
        ff5.index = pd.to_datetime([str(d) for d in ff5.index],
                                    format='%Y%m')
        mom.index = pd.to_datetime([str(d) for d in mom.index],
                                    format='%Y%m')
        ff5.columns = ['Mkt-RF','SMB','HML','RMW','CMA','RF']
        mom.columns = ['MOM']
        result = ff5.join(mom, how='left').fillna(0)
        result.to_csv('ff_factors_cache.csv')
        print(f"  ✓ FF factors: {result.shape[0]} months")
        return result
    except Exception as e:
        print(f"  pandas_datareader failed: {e}")

    # ── Fallback 2: local CSV cache from previous runs ────────────────────
    for cache_name in ['ff_factors_cache.csv',
                        'lh_panel_decile_3y.csv',
                        '../lh_panel_decile_3y.csv']:
        if Path(cache_name).exists():
            print(f"  Loading FF factors from cache: {cache_name}...")
            try:
                if cache_name == 'ff_factors_cache.csv':
                    df = pd.read_csv(cache_name, index_col=0,
                                     parse_dates=True)
                    return df
            except Exception:
                pass

    # ── Fallback 3: direct French website with longer timeout ─────────────
    print("  Trying French website (60s timeout)...")
    try:
        factors = _make_df(
            _parse_monthly(_get_zip_slow('F-F_Research_Data_5_Factors_2x3'), 7),
            ['Date','Mkt-RF','SMB','HML','RMW','CMA','RF'])
        mom = _make_df(
            _parse_monthly(_get_zip_slow('F-F_Momentum_Factor'), 2),
            ['Date','MOM'])
        result = factors.join(mom, how='left').fillna(0)
        result.to_csv('ff_factors_cache.csv')
        print(f"  ✓ FF factors: {result.shape[0]} months")
        return result
    except Exception as e:
        raise RuntimeError(
            f"Could not fetch FF factors. Install pandas_datareader: "
            f"pip install pandas_datareader\n"
            f"Or place ff_factors_cache.csv in the working directory.\n"
            f"Last error: {e}")


def _get_zip_slow(filename):
    """Version with longer timeout for slow connections."""
    url = f"{FF_BASE}/{filename}_CSV.zip"
    r = requests.get(url, headers=HEADERS, timeout=120)
    r.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    return zf.read(zf.namelist()[0]).decode('utf-8', errors='replace')

# ── Stock return download ─────────────────────────────────────────────────────

def download_stock_returns(tickers, start, end, cache_file='stock_returns_stooq.csv'):
    """Download monthly stock returns via yfinance with caching."""
    cache = Path(cache_file)
    if cache.exists():
        print(f"  Loading returns from {cache_file}...")
        try:
            df = pd.read_csv(cache_file, index_col=0, parse_dates=True)
            if isinstance(df, pd.DataFrame) and df.shape[1] >= 10:
                print(f"  ✓ Loaded {df.shape[1]} stocks, {df.shape[0]} months")
                return df
            else:
                print(f"  File invalid (shape={df.shape})")
                cache.unlink()
        except Exception as e:
            print(f"  File corrupted ({e})")
            cache.unlink()

    if not HAS_YF:
        raise ImportError("yfinance required for stock download")

    print(f"  Downloading {len(tickers)} stocks ({start} to {end})...")
    all_returns = {}
    failed = []
    for i, ticker in enumerate(tickers):
        try:
            data = yf.download(ticker, start=start, end=end,
                               interval='1mo', progress=False,
                               auto_adjust=True)
            if data is None or len(data) < 60:
                failed.append(ticker)
                continue
            # Handle MultiIndex columns from newer yfinance versions
            if isinstance(data.columns, pd.MultiIndex):
                data.columns = data.columns.get_level_values(0)
            if 'Close' not in data.columns:
                failed.append(ticker)
                continue
            prices = data['Close'].resample('ME').last()
            if isinstance(prices, pd.DataFrame):
                prices = prices.iloc[:, 0]  # take first column if MultiIndex
            prices = prices.dropna()
            if len(prices) < 60:
                failed.append(ticker)
                continue
            ret = prices.pct_change().dropna()
            all_returns[ticker] = ret
            if (i+1) % 20 == 0:
                print(f"    {i+1}/{len(tickers)} done...")
        except Exception as e:
            failed.append(ticker)

    if failed:
        print(f"  Failed: {failed}")

    # Build DataFrame robustly — align on common index, skip scalars
    # Filter to series with enough observations
    valid_returns = {k: v for k, v in all_returns.items()
                     if isinstance(v, pd.Series) and len(v) >= 60}
    if not valid_returns:
        raise ValueError("No valid stock return series downloaded")

    # Find common date range
    all_indices = [v.index for v in valid_returns.values()]
    common_idx = all_indices[0]
    for idx in all_indices[1:]:
        common_idx = common_idx.union(idx)

    df = pd.DataFrame(valid_returns, index=common_idx)
    # Convert period index if needed
    if hasattr(df.index, 'to_timestamp'):
        df.index = df.index.to_timestamp('M')
    else:
        df.index = pd.DatetimeIndex(df.index)
        df.index = df.index.to_period('M').to_timestamp('M')
    df.to_csv(cache_file)
    print(f"  Saved to {cache_file}. Shape: {df.shape}")
    return df

# ── Comoment estimation ───────────────────────────────────────────────────────

def estimate_comoments_stock(ri_exc, rm_exc):
    """
    Estimate beta, coskewness, cokurtosis for a single stock.
    R_i = a + b*rm + c*rm^2 + d*rm^3

    Returns dict or None.
    """
    ri = np.array(ri_exc, dtype=float)
    rm = np.array(rm_exc, dtype=float)
    mask = np.isfinite(ri) & np.isfinite(rm)
    if mask.sum() < 36: return None
    ri_c = ri[mask]; rm_c = rm[mask]

    # Standardise market return
    rm_s = (rm_c - rm_c.mean()) / (rm_c.std() + 1e-10)

    X = sm.add_constant(pd.DataFrame({
        'rm':  rm_s,
        'rm2': rm_s**2,
        'rm3': rm_s**3,
    }))
    try:
        reg = sm.OLS(ri_c, X).fit()
        return {
            'beta':    float(reg.params.get('rm',   np.nan)),
            'coskew':  float(reg.params.get('rm2',  np.nan)),
            'cokurt':  float(reg.params.get('rm3',  np.nan)),
            'alpha':   float(reg.params.get('const',np.nan)),
            'r2':      float(reg.rsquared),
            'n':       int(mask.sum()),
        }
    except: return None

# ── Comoment-sorted portfolio construction ───────────────────────────────────

def construct_comoment_portfolios(stock_returns, ff_factors,
                                  lookback=LOOKBACK_MONTHS,
                                  forward=FORWARD_MONTHS,
                                  step=STEP_MONTHS,
                                  n_groups=N_SORT_DECILES):
    """
    At each rebalance date:
    1. Estimate coskewness and cokurtosis for each stock from lookback window
    2. Sort stocks into n_groups portfolios by coskewness and cokurtosis
    3. Record equal-weighted portfolio returns over forward window

    Returns:
      coskew_factor: long bottom / short top coskewness quintile return series
      cokurt_factor: long bottom / short top cokurtosis quintile return series
      portfolio_df:  monthly returns for all quintile portfolios
    """
    rm  = ff_factors['Mkt-RF'] / 100
    rf  = ff_factors['RF']     / 100

    # Align dates — normalise to month-end timestamps
    # yfinance and French data may use different day-of-month conventions
    sr_idx = stock_returns.index.to_period('M').to_timestamp('M')
    ff_idx = ff_factors.index.to_period('M').to_timestamp('M')

    stock_returns = stock_returns.copy()
    stock_returns.index = sr_idx
    ff_factors_aligned = ff_factors.copy()
    ff_factors_aligned.index = ff_idx

    rm = ff_factors_aligned['Mkt-RF'] / 100
    rf = ff_factors_aligned['RF']     / 100

    common_idx = stock_returns.index.intersection(ff_factors_aligned.index)
    print(f"\n  Date alignment: {len(common_idx)} common months")
    print(f"  Stock returns: {stock_returns.index[0].date()} "
          f"to {stock_returns.index[-1].date()}")
    print(f"  FF factors:    {ff_factors_aligned.index[0].date()} "
          f"to {ff_factors_aligned.index[-1].date()}")
    print(f"  Common:        {common_idx[0].date() if len(common_idx) else 'NONE'} "
          f"to {common_idx[-1].date() if len(common_idx) else 'NONE'}")

    if len(common_idx) < lookback + forward:
        raise ValueError(f"Insufficient overlapping dates: {len(common_idx)} "
                         f"(need at least {lookback + forward})")

    SR = stock_returns.loc[common_idx]
    rm = rm.loc[common_idx]
    rf = rf.loc[common_idx]
    ff_factors = ff_factors_aligned  # update reference

    start_idx = lookback
    dates = SR.index[start_idx:-forward:step]
    print(f"  Rebalance dates: {len(dates)} "
          f"({dates[0].date() if len(dates) else 'none'} "
          f"to {dates[-1].date() if len(dates) else 'none'})")

    coskew_port_returns  = {g: [] for g in range(1, n_groups+1)}
    cokurt_port_returns  = {g: [] for g in range(1, n_groups+1)}
    coskew_factor_rets   = []
    cokurt_factor_rets   = []
    factor_dates         = []

    print(f"\n  Constructing comoment portfolios ({len(dates)} rebalance dates)...")

    for t_idx, t in enumerate(dates):
        # Lookback window
        t_pos    = SR.index.get_loc(t)
        lb_start = t_pos - lookback
        lb_end   = t_pos
        fwd_end  = min(t_pos + forward, len(SR))

        SR_lb = SR.iloc[lb_start:lb_end]
        rm_lb = rm.iloc[lb_start:lb_end]
        SR_fwd = SR.iloc[lb_end:fwd_end]
        rf_fwd = rf.iloc[lb_end:fwd_end]

        # Estimate comoments for each stock
        comoments = {}
        for ticker in SR.columns:
            ri_exc = SR_lb[ticker].values - rf.iloc[lb_start:lb_end].values
            rm_exc = rm_lb.values
            cm = estimate_comoments_stock(ri_exc, rm_exc)
            if cm is not None and np.isfinite(cm['coskew']):
                comoments[ticker] = cm

        if len(comoments) < n_groups * 3:
            continue

        tickers_sorted_coskew = sorted(comoments.keys(),
                                        key=lambda t: comoments[t]['coskew'])
        tickers_sorted_cokurt = sorted(comoments.keys(),
                                        key=lambda t: comoments[t]['cokurt'])

        n = len(tickers_sorted_coskew)
        group_size = n // n_groups

        def port_return(tickers_in_port, SR_fwd, rf_fwd):
            """Equal-weighted forward return for a set of tickers."""
            valid = [t for t in tickers_in_port
                     if t in SR_fwd.columns and SR_fwd[t].notna().all()]
            if not valid: return np.nan
            ew_ret = SR_fwd[valid].mean(axis=1)
            # Annualise monthly returns
            return float((1 + ew_ret).prod()**(12/len(ew_ret)) - 1)

        # Coskewness portfolios
        for g in range(1, n_groups+1):
            lo = (g-1) * group_size
            hi = g * group_size if g < n_groups else n
            port_tickers = tickers_sorted_coskew[lo:hi]
            r = port_return(port_tickers, SR_fwd, rf_fwd)
            coskew_port_returns[g].append((t, r))

        # Cokurtosis portfolios
        for g in range(1, n_groups+1):
            lo = (g-1) * group_size
            hi = g * group_size if g < n_groups else n
            port_tickers = tickers_sorted_cokurt[lo:hi]
            r = port_return(port_tickers, SR_fwd, rf_fwd)
            cokurt_port_returns[g].append((t, r))

        # Factor returns: long bottom quintile / short top quintile
        # Compute directly from current iteration's port_return calls
        # rather than indexing the accumulated list
        def get_quintile_ret(tickers_sorted, SR_fwd, rf_fwd, quintile, n_g):
            n = len(tickers_sorted)
            gs = n // n_g
            lo = (quintile-1)*gs
            hi = quintile*gs if quintile < n_g else n
            return port_return(tickers_sorted[lo:hi], SR_fwd, rf_fwd)

        r_low_cs  = get_quintile_ret(tickers_sorted_coskew, SR_fwd, rf_fwd,
                                      1, n_groups)
        r_high_cs = get_quintile_ret(tickers_sorted_coskew, SR_fwd, rf_fwd,
                                      n_groups, n_groups)
        r_low_ck  = get_quintile_ret(tickers_sorted_cokurt, SR_fwd, rf_fwd,
                                      1, n_groups)
        r_high_ck = get_quintile_ret(tickers_sorted_cokurt, SR_fwd, rf_fwd,
                                      n_groups, n_groups)

        cs_spread = r_low_cs - r_high_cs                     if np.isfinite(r_low_cs) and np.isfinite(r_high_cs)                     else np.nan
        ck_spread = r_low_ck - r_high_ck                     if np.isfinite(r_low_ck) and np.isfinite(r_high_ck)                     else np.nan

        coskew_factor_rets.append(cs_spread)
        cokurt_factor_rets.append(ck_spread)
        factor_dates.append(t)

        if (t_idx+1) % 5 == 0:
            print(f"    {t_idx+1}/{len(dates)} dates processed...")

    # Build time series
    # Normalise factor dates to month-end to match FF factors index
    factor_idx = pd.DatetimeIndex(factor_dates).to_period('M').to_timestamp('M')

    coskew_factor = pd.Series(coskew_factor_rets, index=factor_idx,
                               name='COSKEW_FACTOR')
    cokurt_factor = pd.Series(cokurt_factor_rets, index=factor_idx,
                               name='COKURT_FACTOR')

    print(f"  Factor index sample (normalised): {list(factor_idx[:3])}")
    print(f"  FF factors index sample: {list(ff_factors.index[:3])}")
    overlap = factor_idx.intersection(ff_factors.index)
    print(f"  Overlapping dates: {len(overlap)}")

    # Build portfolio return DataFrames
    def build_port_df(port_rets_dict):
        df = {}
        for g, rets in port_rets_dict.items():
            dates_g = [r[0] for r in rets]
            vals_g  = [r[1] for r in rets]
            df[f'Q{g}'] = pd.Series(vals_g, index=pd.DatetimeIndex(dates_g))
        return pd.DataFrame(df)

    cs_ports = build_port_df(coskew_port_returns)
    ck_ports = build_port_df(cokurt_port_returns)

    print(f"\n  Factor construction summary:")
    print(f"  factor_dates: {len(factor_dates)} entries")
    if factor_dates:
        print(f"  Date range: {factor_dates[0].date()} to {factor_dates[-1].date()}")
    print(f"  coskew_factor_rets non-nan: "
          f"{sum(1 for x in coskew_factor_rets if np.isfinite(x))}")
    print(f"  cokurt_factor_rets non-nan: "
          f"{sum(1 for x in cokurt_factor_rets if np.isfinite(x))}")
    if factor_dates:
        print(f"  Sample coskew spreads: {coskew_factor_rets[:5]}")
    print(f"  FF factors index sample: {list(ff_factors.index[:3])}")

    return coskew_factor, cokurt_factor, cs_ports, ck_ports

# ── Test 1: Do comoment factors earn significant premiums? ────────────────────

def test_comoment_factor_premiums(coskew_factor, cokurt_factor, ff_factors):
    """
    Test whether comoment-sorted zero-investment portfolios earn positive returns.
    Also test whether they survive controlling for FF6 factors.
    """
    print(f"\n{'='*60}")
    print("Test 1: Comoment Factor Premiums")
    print(f"{'='*60}")

    common = coskew_factor.index.intersection(cokurt_factor.index)\
                                 .intersection(ff_factors.index)
    print(f"  coskew_factor index sample: {list(coskew_factor.index[:3]) if len(coskew_factor)>0 else 'EMPTY'}")
    print(f"  coskew_factor dropna: {len(coskew_factor.dropna())} obs")
    print(f"  ff_factors index sample: {list(ff_factors.index[:3])}")
    print(f"  common dates: {len(common)}")
    if len(common) < 10:
        print("  Insufficient overlapping observations")
        return

    cs = coskew_factor.loc[common].dropna()
    ck = cokurt_factor.loc[common].dropna()
    ff = ff_factors.loc[common] / 100

    print(f"\n  N observations: {len(cs)}")
    print(f"\n  {'Factor':<20} {'Mean':>8} {'Std':>8} {'t-stat':>8} {'sig':>5}")
    print("  " + "-"*52)

    for name, series in [("Coskewness factor", cs),
                          ("Cokurtosis factor", ck)]:
        s = series.dropna()
        if len(s) < 5: continue
        mean = s.mean()
        std  = s.std(ddof=1)
        t    = mean / (std / np.sqrt(len(s)))
        p    = 2*(1-stats.t.cdf(abs(t), df=len(s)-1))
        sig  = '***' if p<0.01 else ('**' if p<0.05 else ('*' if p<0.10 else ''))
        print(f"  {name:<20} {mean:>+8.4f} {std:>8.4f} {t:>+8.2f} {sig:>5}")

    # Alpha from FF6
    print(f"\n  FF6 alpha of comoment factors:")
    ff_cols = ['Mkt-RF','SMB','HML','RMW','CMA','MOM']
    ff_cols = [c for c in ff_cols if c in ff.columns]

    for name, series in [("Coskewness", cs), ("Cokurtosis", ck)]:
        s = series.dropna()
        common2 = s.index.intersection(ff.index)
        y = s.loc[common2].values
        X = sm.add_constant(ff.loc[common2][ff_cols].values)
        try:
            reg = sm.OLS(y, X).fit()
            alpha = reg.params[0]
            t_a   = reg.tvalues[0]
            p_a   = reg.pvalues[0]
            sig   = '***' if p_a<0.01 else ('**' if p_a<0.05
                    else ('*' if p_a<0.10 else ''))
            print(f"  {name:<20} alpha={alpha:>+8.4f}  "
                  f"t={t_a:>+6.2f}{sig}  R²={reg.rsquared:.3f}")
        except: pass

# ── Test 2: Do comoment-sorted portfolios price FF test assets? ───────────────

def test_comoment_pricing(coskew_factor, cokurt_factor, ff_norm,
                           cs_ports, ck_ports):
    """
    Test whether loadings on comoment factors price the comoment-sorted
    portfolios themselves, and test the quintile return spread.
    """
    print(f"\n{'='*60}")
    print("Test 2: Comoment Portfolio Return Spreads")
    print(f"{'='*60}")

    print(f"\n  Coskewness-sorted quintile returns (annualised):")
    print(f"  {'Quintile':<12} {'Mean ret':>10} {'Std':>8} {'t-stat':>8}")
    print("  " + "-"*42)
    for col in sorted(cs_ports.columns):
        s = cs_ports[col].dropna()
        if len(s) < 5: continue
        mean = s.mean(); std = s.std(ddof=1)
        t = mean/(std/np.sqrt(len(s))) if std>0 else np.nan
        print(f"  {col:<12} {mean:>+10.4f} {std:>8.4f} {t:>+8.2f}")

    # Spread: Q1 - Q5
    common = cs_ports['Q1'].dropna().index.intersection(
             cs_ports[f'Q{N_SORT_DECILES}'].dropna().index)
    if len(common) > 5:
        spread = (cs_ports['Q1'].loc[common] -
                  cs_ports[f'Q{N_SORT_DECILES}'].loc[common])
        t = spread.mean()/(spread.std(ddof=1)/np.sqrt(len(spread)))
        print(f"\n  Q1-Q5 spread: {spread.mean():>+.4f}  t={t:>+.2f}")
        sig = '***' if abs(t)>3 else ('**' if abs(t)>2 else
              ('*' if abs(t)>1.65 else 'n.s.'))
        print(f"  Significance: {sig}")

    print(f"\n  Cokurtosis-sorted quintile returns (annualised):")
    print(f"  {'Quintile':<12} {'Mean ret':>10} {'Std':>8} {'t-stat':>8}")
    print("  " + "-"*42)
    for col in sorted(ck_ports.columns):
        s = ck_ports[col].dropna()
        if len(s) < 5: continue
        mean = s.mean(); std = s.std(ddof=1)
        t = mean/(std/np.sqrt(len(s))) if std>0 else np.nan
        print(f"  {col:<12} {mean:>+10.4f} {std:>8.4f} {t:>+8.2f}")

# ── Test 3: Do comoments mediate FF factors? ──────────────────────────────────

def test_factor_mediation_comoment(coskew_factor, cokurt_factor, ff_norm):
    """
    The key test: do FF factor returns load on comoment factors?
    If SMB, HML, RMW, CMA have significant loadings on coskewness and
    cokurtosis factors, this means the factor premiums can be explained
    by comoment exposure — the factors ARE comoment risk in disguise.

    This is the reverse of the mediation we've been running:
    here we regress factor RETURNS on comoment factors.
    """
    print(f"\n{'='*60}")
    print("Test 3: Do FF Factor Returns Load on Comoment Factors?")
    print("(This tests whether factors ARE comoment exposure)")
    print(f"{'='*60}")

    common = coskew_factor.index\
             .intersection(cokurt_factor.index)\
             .intersection(ff_norm.index)
    common = common[common >= max(coskew_factor.dropna().index[0],
                                   cokurt_factor.dropna().index[0])]

    cs = coskew_factor.loc[common].dropna()
    ck = cokurt_factor.loc[common].dropna()
    common2 = cs.index.intersection(ck.index)
    cs = cs.loc[common2]; ck = ck.loc[common2]
    ff = ff_norm.loc[common2] / 100

    X_cm = sm.add_constant(pd.DataFrame({
        'COSKEW': cs.values,
        'COKURT': ck.values,
    }, index=common2))

    ff_norm_to_test = ['Mkt-RF','SMB','HML','RMW','CMA','MOM']
    ff_norm_to_test = [f for f in ff_norm_to_test if f in ff.columns]

    print(f"\n  N = {len(common2)} annual observations")
    print(f"\n  {'Factor':<8} {'α':>8} {'β_CS':>8} {'t_CS':>7} "
          f"{'β_CK':>8} {'t_CK':>7} {'R²':>6} {'Both sig?':>10}")
    print("  " + "-"*72)

    for f in ff_norm_to_test:
        y = ff[f].values
        try:
            reg = sm.OLS(y, X_cm.values).fit()
            alpha = reg.params[0]
            b_cs  = reg.params[1]; t_cs = reg.tvalues[1]; p_cs = reg.pvalues[1]
            b_ck  = reg.params[2]; t_ck = reg.tvalues[2]; p_ck = reg.pvalues[2]
            r2    = reg.rsquared
            sig_cs = '*' if p_cs<0.10 else ''
            sig_ck = '*' if p_ck<0.10 else ''
            both = 'YES' if (p_cs<0.10 and p_ck<0.10) else \
                   ('CS' if p_cs<0.10 else ('CK' if p_ck<0.10 else 'no'))
            print(f"  {f:<8} {alpha:>+8.4f} {b_cs:>+8.4f} "
                  f"{t_cs:>+6.2f}{sig_cs:1s} "
                  f"{b_ck:>+8.4f} {t_ck:>+6.2f}{sig_ck:1s} "
                  f"{r2:>6.3f} {both:>10}")
        except Exception as e:
            print(f"  {f:<8} ERROR: {e}")

    print(f"\n  Interpretation:")
    print(f"  Positive β_CS: factor loads positively on coskewness factor")
    print(f"  (more negative coskewness stocks earn more — consistent with")
    print(f"  the factor premium being coskewness compensation)")

# ── Test 4: Cross-sectional test on comoment portfolios ──────────────────────

def test_cross_sectional_pricing(cs_ports, ck_ports, coskew_factor,
                                  cokurt_factor, ff_norm):
    """
    Fama-MacBeth cross-sectional test:
    - Test assets: comoment-sorted portfolios
    - Factors: coskewness factor, cokurtosis factor, FF6
    - Test whether factor loadings predict portfolio returns
    """
    print(f"\n{'='*60}")
    print("Test 4: Cross-sectional Pricing of Comoment Portfolios")
    print(f"{'='*60}")

    # Stack cs and ck portfolios as test assets
    all_ports = {}
    for col in cs_ports.columns:
        all_ports[f'CS_{col}'] = cs_ports[col]
    for col in ck_ports.columns:
        all_ports[f'CK_{col}'] = ck_ports[col]

    ports_df = pd.DataFrame(all_ports)
    common = ports_df.index\
             .intersection(coskew_factor.index)\
             .intersection(ff_norm.index)
    common = common.dropna() if hasattr(common, 'dropna') else common
    common = [d for d in common if
              not pd.isna(coskew_factor.get(d, np.nan)) and
              not pd.isna(cokurt_factor.get(d, np.nan))]
    if len(common) < 8:
        print("  Insufficient data for cross-sectional test")
        return

    ports_df = ports_df.loc[common]
    cs_f     = coskew_factor.loc[common]
    ck_f     = cokurt_factor.loc[common]
    ff       = ff_norm.loc[common] / 100

    # Time-series pass: estimate factor loadings for each portfolio
    factors_dict = {
        'COSKEW': cs_f.values,
        'COKURT': ck_f.values,
    }
    for fc in ['Mkt-RF','SMB','HML','RMW','CMA','MOM']:
        if fc in ff.columns:
            factors_dict[fc] = ff[fc].values

    loadings = {}
    mean_rets = {}
    for port in ports_df.columns:
        y = ports_df[port].values
        valid = np.isfinite(y)
        if valid.sum() < 8: continue
        X = sm.add_constant(np.column_stack([
            factors_dict[f][valid] for f in factors_dict
        ]))
        try:
            reg = sm.OLS(y[valid], X).fit()
            loadings[port] = dict(zip(
                ['const'] + list(factors_dict.keys()),
                reg.params))
            mean_rets[port] = float(np.mean(y[valid]))
        except: pass

    if len(loadings) < 5:
        print("  Insufficient portfolios with valid loadings")
        return

    load_df = pd.DataFrame(loadings).T
    ret_series = pd.Series(mean_rets)

    print(f"\n  N test portfolios: {len(load_df)}")
    print(f"\n  Cross-sectional regression: mean return on factor loadings")
    print(f"\n  {'Factor':<12} {'λ (premium)':>12} {'t-stat':>8} {'sig':>5}")
    print("  " + "-"*44)

    factors_to_price = ['COSKEW','COKURT','Mkt-RF','SMB','HML']
    for f in factors_to_price:
        if f not in load_df.columns: continue
        x = load_df[f].values
        y = ret_series.values
        valid = np.isfinite(x) & np.isfinite(y)
        if valid.sum() < 5: continue
        slope = np.cov(x[valid], y[valid])[0,1] / np.var(x[valid])
        resid = y[valid] - slope*x[valid]
        se    = np.sqrt(np.var(resid,ddof=2)/np.var(x[valid])/valid.sum())
        t     = slope/se if se>0 else np.nan
        p     = 2*(1-stats.t.cdf(abs(t),df=valid.sum()-2)) if np.isfinite(t) else 1
        sig   = '***' if p<0.01 else ('**' if p<0.05 else ('*' if p<0.10 else ''))
        print(f"  {f:<12} {slope:>+12.4f} {t:>+8.2f} {sig:>5}")


# ── Test 5: Fama-MacBeth on 25 size/BTM portfolios ───────────────────────────

def fetch_25_portfolios():
    """Fetch French 25 size/BTM portfolios with multiple fallbacks."""

    # ── Fallback 1: local cache ───────────────────────────────────────────
    cache = Path('25_portfolios_cache.csv')
    if cache.exists():
        try:
            df = pd.read_csv(cache, index_col=0, parse_dates=True)
            if df.shape[1] >= 20:
                print(f"  ✓ Loaded 25 portfolios from cache: {df.shape}")
                return df / 100
        except Exception:
            pass

    # ── Fallback 2: pandas_datareader ─────────────────────────────────────
    try:
        import pandas_datareader.data as web
        print("  Fetching 25 size/BTM portfolios via pandas_datareader...")
        df = web.DataReader('25_Portfolios_5x5', 'famafrench',
                             start='1963-01-01')[0]
        df.index = pd.to_datetime([str(d) for d in df.index], format='%Y%m')
        df.to_csv(cache)
        print(f"  ✓ 25 portfolios: {df.shape}")
        return df / 100
    except Exception as e:
        print(f"  pandas_datareader failed: {e}")

    # ── Fallback 3: direct download from French library ───────────────────
    try:
        print("  Fetching 25 portfolios directly from French library...")
        FF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"
        HEADERS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
        url = f"{FF_BASE}/25_Portfolios_5x5_CSV.zip"
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        content = zf.read(zf.namelist()[0]).decode('utf-8', errors='replace')

        # Parse the monthly value-weighted returns table
        lines = content.split('\n')
        rows = []
        in_vw = False
        for line in lines:
            s = line.strip().rstrip(',')
            if 'Average Value Weighted Returns' in s:
                in_vw = True; continue
            if in_vw and 'Average Equal Weighted' in s:
                break
            if not in_vw: continue
            if not s: continue
            parts = [p.strip() for p in s.split(',')]
            if len(parts) >= 26:
                try:
                    date = int(parts[0])
                    if 192601 <= date <= 210012:
                        vals = []
                        for p in parts[1:26]:
                            try:
                                v = float(p)
                                vals.append(np.nan if v in (-99.99,-999.) else v)
                            except: vals.append(np.nan)
                        rows.append([date] + vals)
                except: pass

        cols = ['Date'] + [f'P{i+1}' for i in range(25)]
        df = pd.DataFrame(rows, columns=cols)
        df['Date'] = pd.to_datetime(df['Date'].astype(str), format='%Y%m')
        df = df.set_index('Date').sort_index()
        df.to_csv(cache)
        print(f"  ✓ 25 portfolios: {df.shape}")
        return df / 100
    except Exception as e:
        print(f"  Direct download failed: {e}")
        return None


def test_fama_macbeth_25portfolios(coskew_factor, cokurt_factor, ff_norm):
    """
    Lambert-Hubner main test: price 25 size/BTM portfolios with comoment factors.
    Time-series pass: estimate loadings for each portfolio.
    Cross-sectional pass: test whether loadings predict mean returns.
    """
    print(f"\n{'='*65}")
    print("Test 5: Fama-MacBeth on 25 Size/BTM Portfolios")
    print("(Lambert-Hubner main test — independent test assets)")
    print(f"{'='*65}")

    port25 = fetch_25_portfolios()
    if port25 is None:
        return

    rf_monthly = ff_norm['RF'] / 100

    # Expand annual comoment factors to monthly
    cs_annual = coskew_factor.dropna()
    ck_annual = cokurt_factor.dropna()
    cs_vals, ck_vals = {}, {}
    for date, val in cs_annual.items():
        for m in range(1, 13):
            try:
                mdate = pd.Timestamp(year=date.year, month=m, day=1) +                         pd.offsets.MonthEnd(0)
                cs_vals[mdate] = val
                ck_vals[mdate] = float(ck_annual.get(date, np.nan))
            except: pass
    cs_monthly = pd.Series(cs_vals)
    ck_monthly = pd.Series(ck_vals)

    # Normalise all indices to month-end timestamps before intersection
    def norm_idx(df_or_series):
        if isinstance(df_or_series, pd.Series):
            df_or_series = df_or_series.copy()
            df_or_series.index = df_or_series.index.to_period('M').to_timestamp('M')
        else:
            df_or_series = df_or_series.copy()
            df_or_series.index = df_or_series.index.to_period('M').to_timestamp('M')
        return df_or_series

    port25     = norm_idx(port25)
    cs_monthly = norm_idx(cs_monthly)
    ck_monthly = norm_idx(ck_monthly)
    # ff_norm already normalised in main()

    common_ts = port25.index.intersection(ff_norm.index)                             .intersection(cs_monthly.index)                             .intersection(ck_monthly.index)
    common_ts = common_ts.sort_values()

    print(f"  port25 index sample:     {list(port25.index[:2])}")
    print(f"  ff_norm index sample:    {list(ff_norm.index[:2])}")
    print(f"  cs_monthly index sample: {list(cs_monthly.index[:2])}")
    print(f"  Monthly overlap: {len(common_ts)} months")

    if len(common_ts) < 60:
        print("  Insufficient overlap — need 60+ months")
        return

    print(f"  ({common_ts[0].date()} to {common_ts[-1].date()})")

    p25   = port25.loc[common_ts]
    ff_ts = ff_norm.loc[common_ts] / 100
    cs_ts = cs_monthly.loc[common_ts]
    ck_ts = ck_monthly.loc[common_ts]
    rf_ts = ff_ts['RF']

    # Time-series pass
    loadings, alphas_4m, alphas_ff3, r2_4m, r2_ff3, mean_exc = {}, {}, {}, {}, {}, {}
    for port in p25.columns:
        ri_exc = p25[port] - rf_ts
        valid = ri_exc.notna() & ff_ts['Mkt-RF'].notna() &                 cs_ts.notna() & ck_ts.notna()
        if valid.sum() < 36: continue
        y = ri_exc[valid].values

        X4 = sm.add_constant(np.column_stack([
            ff_ts['Mkt-RF'][valid], cs_ts[valid], ck_ts[valid]]))
        Xff = sm.add_constant(np.column_stack([
            ff_ts['Mkt-RF'][valid], ff_ts['SMB'][valid], ff_ts['HML'][valid]]))
        Xall = sm.add_constant(np.column_stack([
            ff_ts['Mkt-RF'][valid], ff_ts['SMB'][valid], ff_ts['HML'][valid],
            cs_ts[valid], ck_ts[valid]]))
        try:
            r4  = sm.OLS(y, X4).fit()
            rff = sm.OLS(y, Xff).fit()
            rall= sm.OLS(y, Xall).fit()
            loadings[port] = {
                'b_MKT_4m': r4.params[1],  'b_CS': r4.params[2],
                'b_CK':     r4.params[3],
                'b_MKT_ff': rff.params[1], 'b_SMB': rff.params[2],
                'b_HML':    rff.params[3],
                'b_MKT_c':  rall.params[1],'b_SMB_c': rall.params[2],
                'b_HML_c':  rall.params[3],'b_CS_c':  rall.params[4],
                'b_CK_c':   rall.params[5],
            }
            alphas_4m[port]  = float(r4.params[0]) * 12
            alphas_ff3[port] = float(rff.params[0]) * 12
            r2_4m[port]      = float(r4.rsquared)
            r2_ff3[port]     = float(rff.rsquared)
            mean_exc[port]   = float(ri_exc[valid].mean()) * 12
        except: pass

    ld = pd.DataFrame(loadings).T
    ret = pd.Series(mean_exc)
    n = len(ld)
    print(f"  Portfolios with valid loadings: {n}")
    if n < 10: return

    print(f"\n  Average time-series R²:")
    print(f"    Four-moment: {np.mean(list(r2_4m.values())):.4f}")
    print(f"    FF3:         {np.mean(list(r2_ff3.values())):.4f}")

    print(f"\n  Mean absolute pricing error (alpha × 12):")
    print(f"    Four-moment: {np.mean(np.abs(list(alphas_4m.values()))):.4f}")
    print(f"    FF3:         {np.mean(np.abs(list(alphas_ff3.values()))):.4f}")

    # Cross-sectional regressions
    print(f"\n  Cross-sectional risk premia (λ):")
    print(f"  {'Model':<32} {'Factor':<8} {'λ':>8} {'t':>7} {'sig':>5}")
    print("  " + "-"*60)

    def cs_reg_print(cols, label):
        X = ld[cols].values
        y = ret.loc[ld.index].values
        ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
        if ok.sum() < 8: return np.nan
        Xv = sm.add_constant(X[ok])
        reg = sm.OLS(y[ok], Xv).fit()
        for j, col in enumerate(cols):
            b = reg.params[j+1]; t = reg.tvalues[j+1]; p = reg.pvalues[j+1]
            sig = '***' if p<0.01 else ('**' if p<0.05 else ('*' if p<0.10 else ''))
            fname = col.replace('b_','').replace('_4m','').replace('_ff','').replace('_c','')
            lbl = label if j==0 else ''
            print(f"  {lbl:<32} {fname:<8} {b:>+8.4f} {t:>+7.2f} {sig:>5}")
        print()
        return reg.rsquared

    r2a = cs_reg_print(['b_MKT_4m','b_CS','b_CK'],     'Model A: Four-moment')
    r2b = cs_reg_print(['b_MKT_ff','b_SMB','b_HML'],   'Model B: FF3')
    r2c = cs_reg_print(['b_MKT_c','b_SMB_c','b_HML_c',
                         'b_CS_c','b_CK_c'],            'Model C: Combined')

    print(f"  R² comparison: 4-moment={r2a:.3f}  FF3={r2b:.3f}  Combined={r2c:.3f}")
    if r2c and r2b:
        print(f"  Comoments add over FF3: {r2c > r2b} "
              f"(ΔR²={r2c-r2b:+.3f})")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Lambert-Hübner Replication — Individual Stocks")
    print("=" * 55)

    # ── Data ──────────────────────────────────────────────────────────────
    print("\nFetching factor data...")
    ff_factors = fetch_ff_factors()
    print(f"  ✓ FF6 factors: {ff_factors.shape[0]} months")

    print("\nFetching S&P 1500 ticker universe...")
    tickers = get_sp1500_tickers()

    print("\nDownloading stock returns...")
    stock_returns = download_stock_returns(
        tickers, START_DATE, END_DATE)
    print(f"  ✓ {stock_returns.shape[1]} stocks, "
          f"{stock_returns.shape[0]} months")

    # ── Construct comoment factor portfolios ──────────────────────────────
    coskew_factor, cokurt_factor, cs_ports, ck_ports = \
        construct_comoment_portfolios(stock_returns, ff_factors)

    n_cs = coskew_factor.dropna().shape[0]
    n_ck = cokurt_factor.dropna().shape[0]
    print(f"\n  Coskewness factor: {n_cs} obs")
    print(f"  Cokurtosis factor: {n_ck} obs")
    if n_cs == 0:
        print("  WARNING: No valid coskewness factor observations produced.")
        print("  Possible causes:")
        print("  - Forward window too short (increase FORWARD_MONTHS?)")
        print("  - Too few stocks with sufficient history in lookback window")
        print("  - Stock return dates don't align with factor dates")
        # Show first few dates and what happened
        print(f"  Stock returns date range: {stock_returns.index[0].date()} "
              f"to {stock_returns.index[-1].date()}" if 'stock_returns' in dir()
              else "  (stock_returns not in scope)")

    # ── Tests ─────────────────────────────────────────────────────────────
    # Normalise FF factors index to month-end to match comoment factor dates
    ff_norm = ff_factors.copy()
    ff_norm.index = ff_norm.index.to_period('M').to_timestamp('M')

    test_comoment_factor_premiums(coskew_factor, cokurt_factor, ff_norm)
    test_comoment_pricing(coskew_factor, cokurt_factor, ff_norm,
                          cs_ports, ck_ports)
    test_factor_mediation_comoment(coskew_factor, cokurt_factor, ff_norm)
    test_cross_sectional_pricing(cs_ports, ck_ports, coskew_factor,
                                  cokurt_factor, ff_norm)
    test_fama_macbeth_25portfolios(coskew_factor, cokurt_factor, ff_norm)

    # ── Figure ─────────────────────────────────────────────────────────────
    fig = plt.figure(figsize=(14, 10))
    fig.patch.set_facecolor('#0d1117')
    gs = gridspec.GridSpec(2, 2, figure=fig, hspace=0.4, wspace=0.35)

    ACCENT = "#4b9cf5"; WARM = "#f5a623"; GREEN = "#63e6a0"
    MUTED_C = "#8892a4"; DARK_C = "#0d1117"; TEXT_C = "#e6edf3"

    def style_ax(ax, title):
        ax.set_facecolor('#161b22')
        ax.set_title(title, color=TEXT_C, fontsize=10, pad=8)
        ax.tick_params(colors=MUTED_C, labelsize=8)
        for spine in ax.spines.values():
            spine.set_edgecolor('#21262d')

    # Plot 1: Coskewness quintile returns
    ax1 = fig.add_subplot(gs[0,0])
    qs = [f'Q{i}' for i in range(1,N_SORT_DECILES+1)]
    means = [cs_ports[q].mean() if q in cs_ports.columns else 0 for q in qs]
    colors_bar = [ACCENT if m>0 else '#f87171' for m in means]
    ax1.bar(qs, means, color=colors_bar, alpha=0.8, edgecolor='none')
    ax1.axhline(0, color=MUTED_C, linewidth=0.5)
    ax1.set_xlabel("Coskewness Quintile (Q1=most negative)", color=MUTED_C, fontsize=8)
    ax1.set_ylabel("Mean Annual Return", color=MUTED_C, fontsize=8)
    style_ax(ax1, "Coskewness-Sorted Portfolio Returns")

    # Plot 2: Cokurtosis quintile returns
    ax2 = fig.add_subplot(gs[0,1])
    means_ck = [ck_ports[q].mean() if q in ck_ports.columns else 0 for q in qs]
    colors_ck = [ACCENT if m>0 else '#f87171' for m in means_ck]
    ax2.bar(qs, means_ck, color=colors_ck, alpha=0.8, edgecolor='none')
    ax2.axhline(0, color=MUTED_C, linewidth=0.5)
    ax2.set_xlabel("Cokurtosis Quintile", color=MUTED_C, fontsize=8)
    ax2.set_ylabel("Mean Annual Return", color=MUTED_C, fontsize=8)
    style_ax(ax2, "Cokurtosis-Sorted Portfolio Returns")

    # Plot 3: Factor time series
    ax3 = fig.add_subplot(gs[1,0])
    cs_clean = coskew_factor.dropna()
    ck_clean = cokurt_factor.dropna()
    ax3.plot(cs_clean.index, cs_clean.cumsum(), color=ACCENT,
             linewidth=1.5, label='Coskewness factor (cumulative)')
    ax3.plot(ck_clean.index, ck_clean.cumsum(), color=WARM,
             linewidth=1.5, label='Cokurtosis factor (cumulative)')
    ax3.axhline(0, color=MUTED_C, linewidth=0.5, linestyle=':')
    ax3.legend(fontsize=7, facecolor='#1e2530', labelcolor=TEXT_C)
    ax3.set_xlabel("Date", color=MUTED_C, fontsize=8)
    ax3.set_ylabel("Cumulative return", color=MUTED_C, fontsize=8)
    style_ax(ax3, "Comoment Factor Cumulative Returns")

    # Plot 4: FF factor loadings on comoment factors
    ax4 = fig.add_subplot(gs[1,1])
    common = coskew_factor.dropna().index\
             .intersection(cokurt_factor.dropna().index)\
             .intersection(ff_factors.index)
    if len(common) > 5:
        cs = coskew_factor.loc[common].values
        ck = cokurt_factor.loc[common].values
        ff_test = ff_factors.loc[common] / 100
        X = sm.add_constant(np.column_stack([cs, ck]))
        ff_to_plot = ['SMB','HML','RMW','CMA','MOM']
        ff_to_plot = [f for f in ff_to_plot if f in ff_test.columns]
        cs_coefs = []; ck_coefs = []
        for f in ff_to_plot:
            try:
                reg = sm.OLS(ff_test[f].values, X).fit()
                cs_coefs.append(reg.params[1])
                ck_coefs.append(reg.params[2])
            except:
                cs_coefs.append(0); ck_coefs.append(0)
        x_pos = np.arange(len(ff_to_plot))
        w = 0.35
        ax4.bar(x_pos-w/2, cs_coefs, w, color=ACCENT, alpha=0.8,
                label='β on coskewness factor')
        ax4.bar(x_pos+w/2, ck_coefs, w, color=WARM, alpha=0.8,
                label='β on cokurtosis factor')
        ax4.set_xticks(x_pos); ax4.set_xticklabels(ff_to_plot, fontsize=8)
        ax4.axhline(0, color=MUTED_C, linewidth=0.5)
        ax4.legend(fontsize=7, facecolor='#1e2530', labelcolor=TEXT_C)
        ax4.set_ylabel("Factor loading", color=MUTED_C, fontsize=8)
        style_ax(ax4, "FF Factor Loadings on Comoment Factors")

    plt.suptitle(
        "Lambert-Hübner Replication: Comoment Risk and Factor Premiums\n"
        "Individual Stock Universe (~120 S&P 500 stocks, 1990-2024)",
        color=TEXT_C, fontsize=12, fontweight='bold', y=0.98)

    plt.savefig('lh_individual_stocks.png', dpi=150,
                bbox_inches='tight', facecolor='#0d1117')
    print("\n  Saved: lh_individual_stocks.png")
    plt.close()

    print("\nDone.")

if __name__ == '__main__':
    main()