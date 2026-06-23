"""
FT Stock Picking Game — Full Pipeline
======================================
1. Resolve ISINs → tickers via OpenFIGI (free, no auth required)
2. Fetch 1 year of daily price data via yfinance
3. Compute empirical upper tail dependence matrix
4. Cluster stocks by tail dependence
5. Select N_PORTFOLIOS maximally decorrelated portfolios
6. Output results table + CSV

Usage:
    pip install yfinance pandas numpy scipy scikit-learn requests tabulate pyarrow
    python ft_portfolios.py
"""

import warnings
warnings.filterwarnings("ignore")

import time, json, requests
import numpy as np
import pandas as pd
import yfinance as yf
from itertools import combinations
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform
from tabulate import tabulate
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────

N_PORTFOLIOS      = 8
TAIL_THRESH       = 0.90        # top-10% up days = "tail move"
WEIGHTS           = [0.25, 0.25, 0.25, 0.20, 0.05]
WEIGHT_LABELS     = ["25%", "25%", "25%", "20%", "5%"]
MIN_DATA_COVERAGE = 0.80
TICKER_CACHE      = Path("ft_tickers_resolved.csv")
PRICE_CACHE       = Path("ft_prices.csv")

# ── Full ISIN universe scraped from FT game ────────────────────────────────────

RAW_ISINS = """US5949181045,Microsoft
US0231351067,Amazon.com
US67066G1040,NVIDIA
US02079K1079,Alphabet C
US30303M1027,Meta Platforms A
US0846707026,Berkshire Hathaway B
US88160R1014,Tesla
US91324P1021,UnitedHealth Group
US5324571083,Eli Lilly
US46625H1005,JP Morgan Chase
US30231G1022,Exxon Mobil
US4781601046,Johnson & Johnson
US92826C8394,Visa
US7427181091,Procter & Gamble
US11135F1012,Broadcom
US57636Q1040,Mastercard
US4370761029,Home Depot
US1667641005,Chevron
US58933Y1055,Merck & Co
US00287Y1091,AbbVie
US7134481081,PepsiCo
US22160K1051,Costco Wholesale
US00724F1012,Adobe
US1912161007,Coca-Cola
US17275R1023,Cisco Systems
US9311421039,Walmart
US8835561023,Thermo Fisher Scientific
US5801351017,McDonald's
US7170811035,Pfizer
US79466L3024,Salesforce
US0605051046,Bank Of America
IE00B4BNMY34,Accenture A
US20030N1019,Comcast A
IE000S9YS762,Linde
US64110L1061,Netflix
US0028241000,Abbott Laboratories
US68389X1054,Oracle
US2358511028,Danaher
US0079031078,Advanced Micro Devices
US9497461015,Wells Fargo
US2546871060,Walt Disney
US8825081040,Texas Instruments
US7181721090,Philip Morris
US92343V1044,Verizon Communications
US4612021034,Intuit
US20825C1045,ConocoPhillips
US1491231015,Caterpillar
US0311621009,Amgen
US65339F1012,NextEra Energy
US4581401001,Intel
US9078181081,Union Pacific
US5486611073,Lowe's
US4592001014,IBM
US1101221083,Bristol-Myers Squibb
US78409V1044,S&P Global
US75513E1010,RTX
US4385161066,Honeywell International
US0970231058,Boeing
US9113121068,United Parcel Service
US3696043013,GE Aerospace
US7475251036,QUALCOMM
US0382221051,Applied Materials
US6541061031,Nike
US74340W1036,Prologis
US81762P1021,ServiceNow
US09857L1089,Booking
US8552441094,Starbucks
US6174464486,Morgan Stanley
US0367521038,Elevance Health
IE00BTN1Y115,Medtronic
US38141G1040,Goldman Sachs
US2441991054,Deere & Co.
US0530151036,Automatic Data Processing
US5398301094,Lockheed Martin
US8725401090,TJX Companies
US00206R1023,AT&T
US09290D1019,BlackRock
US46120E6023,Intuitive Surgical
US6092071058,Mondelez International A
US3755581036,Gilead Sciences
US5717481023,Marsh & McLennan Companies
US0258161092,American Express
US8636671013,Stryker
US75886F1075,Regeneron Pharmaceuticals
US92532F1003,Vertex Pharmaceuticals
IE00B8KQN827,Eaton
US5128073062,Lam Research
US0326541051,Analog Devices
US8085131055,Charles Schwab
US1266501006,CVS Health
US98978V1035,Zoetis A
US1255231003,Cigna
CH0044328745,Chubb
US03027X1000,American Tower REIT
AN8068571086,SLB
US1729674242,Citigroup
US0758871091,Becton Dickinson
US02209S1033,Altria Group
US7433151039,Progressive
US8725901040,T-Mobile US
US3377381088,Fiserv
US8425871071,Southern Company
US26875P1012,EOG Resources
US1011371077,Boston Scientific
US12572Q1058,CME Group A
US29444U7000,Equinix
US5951121038,Micron Technology
US26441C2044,Duke Energy
US6974351057,Palo Alto Networks
US70450Y1038,PayPal
IE00BLP1HW54,Aon
US8716071076,Synopsys
US4523081093,Illinois Tool Works
US4824801009,KLA
US4435106079,Hubbell
US45866F1049,Intercontinental Exchange
US0091581068,Air Products
US8243481061,Sherwin-Williams
US1273871087,Cadence Design Systems
US1264081035,CSX
US6668071029,Northrop Grumman
US1941621039,Colgate-Palmolive
US56585A1025,Marathon Petroleum
US4448591028,Humana
US31428X1063,FedEx
US94106L1098,Waste Management
US58155Q1031,McKesson
US87612E1064,Target
US67103H1077,O'Reilly Automotive
US40412C1018,HCA Healthcare
US35671D8570,Freeport-McMoRan
US2910111044,Emerson Electric
US88579Y1010,3M
US6153691059,Moody's
US7766961061,Roper Technologies
US1696561059,Chipotle Mexican Grill
US7185461040,Phillips 66
US5719032022,Marriott International A
US7010941042,Parker-Hannifin
US0320951017,Amphenol
US3695501086,General Dynamics
US9029733048,U.S. Bancorp
NL0009538784,NXP Semiconductors
US3635761097,Arthur J. Gallagher
US6558441084,Norfolk Southern
US6934751057,PNC Financial Services Group
US91913Y1001,Valero Energy
US3453708600,Ford Motor
US6200763075,Motorola Solutions
US37045V1008,General Motors
IE00BK9ZQ967,Trane Technologies
US28176E1082,Edwards Lifesciences
US14448C1045,Carrier Global
US0533321024,AutoZone
US0527691069,Autodesk
US8936411003,Transdigm Group
US0404132054,Arista Networks
US8168511090,Sempra
US2788651006,EcoLab
US6745991058,Occidental Petroleum
US6937181088,PACCAR
US0394831020,Archer Daniels Midland
US61174X1090,Monster Beverage
US4943681035,Kimberly-Clark
US74460D1090,Public Storage
US22822V1017,Crown Castle
US16119P1084,Charter Communications A
US5950171042,Microchip Technology
US55354G1004,MSCI
US1729081059,Cintas
US9694571004,Williams Companies
US0268747849,American International Group
US21036P1084,Constellation Brands
US8522341036,Block A
US6703461052,Nucor
US7782961038,Ross Stores
US0010551028,Aflac
US49177J1025,Kenvue
US0255371017,American Electric Power
US45168D1046,IDEXX Laboratories
US25746U1097,Dominion Energy
IE000IVNQZ81,TE Connectivity
IE00BY7QL619,Johnson Controls International
US59156R1086,MetLife
US3703341046,General Mills
US46266C1053,IQVIA
US30161N1019,Exelon
US95040Q1040,Welltower
US2521311074,DexCom
US43300A2033,Hilton Worldwide
US6821891057,ON Semiconductor
US14040H1059,Capital One Financial
US89832Q1094,Truist Financial
US09062X1037,Biogen
US7561091049,Realty Income REIT
US34959E1091,Fortinet
US2605571031,Dow
US89417E1091,Travelers Companies
US2538681030,Digital Realty Trust
US60770K1079,Moderna
US2172041061,Copart
US6795801009,Old Dominion Freight Line
US23331A1097,D.R. Horton
US9884981013,Yum! Brands
US8288061091,Simon Property Group
US1924461023,Cognizant Technology A
US0311001004,Ametek
US05722G1004,Baker Hughes A
US8718291078,Sysco
US00846U1016,Agilent Technologies
US22052L1044,Corteva
US15135B1017,Centene
US5184391044,Estee Lauder Companies
US03076C1062,Ameriprise Financial
US21037T1097,Constellation Energy
US4062161017,Halliburton
US68902V1070,Otis Worldwide
US7739031091,Rockwell Automation
US7443201022,Prudential Financial
US26614N1028,DuPont De Nemours
US49456B1017,Kinder Morgan
US92345Y1064,Verisk Analytics
US5024311095,L3Harris Technologies
US2566771059,Dollar General
US31620M1062,Fidelity National Information Services
US2310211063,Cummins
US22160N1090,CoStar Group
US3119001044,Fastenal
US6935061076,PPG Industries
US37940X1028,Global Payments
US3848021040,W.W. Grainger
US4278661081,The Hershey
US0640581007,Bank Of New York Mellon
US98389B1008,Xcel Energy
US25179M1036,Devon Energy
US2855121099,Electronic Arts
US6516391066,Newmont
US2091151041,Consolidated Edison
US9113631090,United Rentals
US9256521090,VICI Properties
US7445731067,Public Service Enterprise
US5010441013,Kroger
US7607591002,Republic Services
US5260571048,Lennar A
US74762E1029,Quanta Services
US9553061055,West Pharmaceutical Services
US03073E1055,Cencora
US6826801036,ONEOK
US9291601097,Vulcan Materials
US49271V1008,Keurig Dr Pepper
US9344231041,Warner Bros. Discovery A
BMG0450A1053,Arch Capital Group
US0200021014,Allstate
US45687V1061,Ingersoll Rand
US12514G1085,CDW
US25278X1090,Diamondback Energy
US5732841060,Martin Marietta Materials
US69331C1080,Pacific Gas & Electric
US2473617023,Delta Air Lines
US30225T1025,Extra Space Storage
US34959J1088,Fortive
US0304201033,American Water Works
US3666511072,Gartner
US5007541064,Kraft Heinz
US36266G1076,GE Healthcare Technologies
US92939U1060,WEC Energy Group
US2810201077,Edison International
US12504L1098,CBRE Group
US88339J1051,The Trade Desk A
US5926881054,Mettler-Toledo International
US2567461080,Dollar Tree
US0534841012,Avalonbay Communities
US3802371076,GoDaddy A
US0162551016,Align Technology
NL0009434992,LyondellBasell Industries
US74144T1088,T. Rowe Price Group
US2193501051,Corning
US2944291051,Equifax
US9621661043,Weyerhaeuser
US98956P1021,Zimmer Biomet
US98419M1009,Xylem
US78410G1040,Sba Communications A
US7611521078,ResMed
US8923561067,Tractor Supply
US2786421030,eBay
US49338L1035,Keysight Technologies
US1713401024,Church & Dwight
US8574771031,State Street
US19260Q1076,Coinbase Global
US4165151048,Hartford Insurance Group
US0126531013,Albemarle
IE00BFY8C754,STERIS
US30040W1080,Eversource Energy
US8740541094,Take-Two Interactive
US6098391054,Monolithic Power Systems
US14149Y1082,Cardinal Health
US29476L1070,Equity Residential
LR0008862868,Royal Caribbean Cruises
IE00BDB6Q211,Willis Towers Watson
US42824C1099,Hewlett Packard Enterprise
US2333311072,DTE Energy
US3724601055,Genuine Parts
US11133T1034,Broadridge Financial
US90384S3031,Ulta Beauty
US3032501047,Fair Isaac
US1270971039,Coterra Energy
US0718131099,Baxter International
US0236081024,Ameren
US55261F1049,M&T Bank
US5797802064,McCormick
US29364G1031,Entergy
US9297401088,Westinghouse Air Brake
US2600031080,Dover
US3379321074,FirstEnergy
US7547301090,Raymond James Financial
US46187W1071,Invitation Homes
US2199481068,Corpay
US1890541097,Clorox
US8793601050,Teledyne Technologies
US87612G1013,Targa Resources
US2371941053,Darden Restaurants
US5049221055,Labcorp
US92343E1029,VeriSign
US55024U1097,Lumentum
US8447411088,Southwest Airlines
US69351T1060,PPL
US0152711091,Alexandria Real Estate
US62944T1051,NVR
US2166485019,The Cooper Companies
US45841N1072,Interactive Brokers A
US7458671010,PulteGroup
US6311031081,Nasdaq
US4432011082,Howmet Aerospace
US7591EP1005,Regions Financial
US15189T1079,CenterPoint Energy
US46284V1017,Iron Mountain REIT
US5178341070,Las Vegas Sands
US3167731005,Fifth Third Bancorp
US3021301094,Expeditors International
US92276F1003,Ventas
US3364331070,First Solar
US74251V1026,Principal Financial Group
US1152361010,Brown & Brown
US98138H1014,Workday A
US45167R1041,IDEX
CH1300646267,Bunge
US0495601058,Atmos Energy
US3030751057,FactSet Research Systems
US29084Q1004,EMCOR Group
US59522J1034,Mid-America Apartment
US1258961002,CMS Energy
US4595061015,International Flavors
US0584981064,Ball
US83088M1027,Skyworks Solutions
US1720621010,Cincinnati Financial
US64110D1046,NetApp
US8581191009,Steel Dynamics
US9100471096,United Airlines
US9418481035,Waters
US6819191064,Omnicom Group
US8807701029,Teradyne
PA1436583006,Carnival
US4456581077,J.B. Hunt Transport
US88262P1021,Texas Pacific Land
US9022521051,Tyler Technologies
US4461501045,Huntington Bank
CH0114405324,Garmin
US12503M1080,Cboe Global Markets
US6658591044,Northern Trust
US9024941034,Tyson Foods
US00971T1016,Akamai Technologies
BMG3223R1088,Everest Re Group
US2971781057,Essex Property Trust
US26884L1098,EQT
US8832031012,Textron
US30212P3038,Expedia
US8326964058,The J.M Smucker Company
US69370C1009,PTC
US74834L1008,Quest Diagnostics
US0536111091,Avery Dennison
US7140461093,Revvity
US0865161014,Best Buy
US1252691001,CF Industries
US2058871029,ConAgra Brands
US29414B1044,EPAM Systems
JE00BV7DQ550,Amcor
US19247G1076,Coherent
US70432V1026,Paycom Software
US8330341012,Snap-On
US05464C1018,Axon Enterprise
US73278L1052,Pool
US87165B1035,Synchrony Financial
US8545021011,Stanley Black & Decker
US9892071054,Zebra Technologies A
US25754A2015,Domino's Pizza
US6951561090,Packaging Corp of America
US1746101054,Citizens Financial Group
US5253271028,Leidos
US92556V1061,Viatris
US45784P1012,Insulet
IE0001827041,CRH
US61945C1036,Mosaic
US03743Q1085,APA
US30034W1062,Evergy
US8962391004,Trimble
US5529531015,MGM Resorts International
US6556631025,Nordson
US9581021055,Western Digital
US5745991068,Masco
US0188021085,Alliant Energy
US92537N1081,Vertiv Holdings A
IE00BKVD2N49,Seagate Technology
US1468691027,Carvana
US09073M1045,Bio-Techne
US0844231029,W.R. Berkley
US1156372096,Brown Forman B
US5380341090,Live Nation Entertainment
US4601461035,International Paper
US9026531049,UDR
US00130H1059,AES
US9699041011,Williams-Sonoma
US45337C1027,Incyte
US5404241086,Loews
US60871R2094,Molson Coors B
US6687711084,Gen Digital
US1331311027,Camden Property Trust
US49446R1095,Kimco Realty
US4262811015,Jack Henry & Associates
US4404521001,Hormel Foods
US44107P1049,Host Hotels & Resorts
US3024913036,FMC
US7707001027,Robinhood Markets A
US42250P1030,Healthpeak Properties
US1717793095,Ciena
IE00BLS09M33,Pentair
US65473P1057,NiSource
US12541W2098,C.H. Robinson Worldwide
US8064071025,Henry Schein
US1598641074,Charles River Laboratories
US7588491032,Regency Centers
US03769M1062,Apollo Global Management
US87256C1018,TKO Group
US4932671088,KeyCorp
US37959E1029,Globe Life
US2774321002,Eastman Chemical
US9831341071,Wynn Resorts
IE00BFRT3W74,Allegion
US69608A1088,Palantir Technologies
US3156161024,F5
US25809K1051,Doordash
US1011211018,Boston Properties
US03831W1080,Applovin A
US7757111049,Rollins
US23804L1035,Datadog A
US7234841010,Pinnacle West Capital
US24703L2025,Dell Technologies C
US12008R1077,Builders Firstsource
US8318652091,A.O Smith
US4180561072,Hasbro
US4464131063,Huntington Ingalls Industries
US6293775085,NRG Energy
US1344291091,Campbell Soup
US9139031002,Universal Health Services
US29530P1021,Erie Indemnity A
IE00028FXN24,Smurfit Westrock
US48251W1045,KKR & Co
US5261071071,Lennox International
US36828A1016,GE Vernova
US0708301041,Bath & Body Works
US8760301072,Tapestry
US69932A2042,Paramount Skydance
US86800U3023,Super Micro Computer
US3546131018,Franklin Resources
US04621X1081,Assurant
BMG667211046,Norwegian Cruise Line
US3687361044,Generac Holdings
US3137451015,Federal Realty Investment Trust
BMG491BT1088,Invesco
US83444M1018,Solventum
US22788C1053,CrowdStrike A
US23918K1088,DaVita
US4663131039,Jabil
US5500211090,Lululemon Athletica
US2435371073,Deckers Outdoor
US90353T1007,Uber Technologies
US1999081045,Comfort Systems USA
US7512121010,Ralph Lauren
US92338C1036,Veralto
US35137L2043,Fox B
US09260D1072,Blackstone
US0090661010,Airbnb A
US65249B2088,News B
US1651677353,Expand Energy
US0420682058,Arm Holdings ADR
US5738741041,Marvell Technology
CA82509L1076,Shopify
US7223041028,PDD ADR
US58733R1023,MercadoLibre
US5949724083,Strategy A
US02043Q1076,Alnylam Pharmaceuticals
CA8849038085,Thomson Reuters
US7043261079,Paychex
US4576693075,Insmed
US98980G1022,Zscaler
GB0007980591,BP PLC
GB00B63H8491,Rolls-Royce Holdings PLC
GB0002875804,British American Tobacco PLC
GB00BVZK7T90,Unilever PLC
GB00BN7SWP63,GSK
GB0007188757,Rio Tinto plc
GB00BDR05C01,National Grid PLC
GB0002634946,BAE Systems PLC
GB0008706128,Lloyds Banking Group PLC
GB0031348658,Barclays PLC
JE00B4T3BW64,Glencore plc
GB00BM8PJY71,NatWest Group Plc
GB00B0SWJX34,London Stock Exchange Group
GB00BD6K4575,Compass Group Plc
GB00BTK05J60,Anglo American PLC
GB00BSZBP530,Reckitt Benckiser Group
GB00BMX86B70,Haleon plc
GB0007908733,SSE Plc
GB0002374006,Diageo PLC
GB00BLGZ9862,Tesco PLC
GB0004082847,Standard Chartered PLC
GB0007099541,Prudential PLC
GB00B19NLV48,Experian PLC
GB00B1YW4409,3i Group PLC
GB0004544929,Imperial Brands Plc
GB00BH4HKS39,Vodafone Group PLC
US8669661048,Sunbelt Rentals Holdings
GB00BPQY8M80,Aviva PLC
GB0032089863,NEXT plc
GB00BHJYC057,InterContinental Hotels Group PLC
GB0004052071,Halma PLC
GB0005603997,Legal & General Group PLC
GB0030913577,BT Group PLC
GB0000456144,Antofagasta PLC
GB00B082RF11,Rentokil Initial Plc
GB0009223206,Smith & Nephew PLC
GB00B033F229,Centrica PLC
GB00BMJ6DW54,Informa Plc
CH0198251305,COCA COLA HBC
GB00B39J2M42,United Utilities Group PLC
GB00B02J6398,Admiral Group PLC
GB00B1FH8J72,Severn Trent PLC
ES0177542018,IAG
GB0001826634,Diploma PLC
GB00B5ZN1N88,Segro PLC
GB00B8C3BL03,Sage Group PLC
GB00BYQ0JC66,Beazley Plc
GB00BL9YR756,Wise Plc
GB00B0744B38,Bunzl PLC
GB0009465807,Weir Group
GB00B1WY2338,Smiths Group PLC
GB0031274896,Marks & Spencer Group PLC
GB00BGLP8L22,IMI PLC
GB0006776081,Pearson PLC
GB00BNGDN821,Melrose Industries Plc
GB00B2QPKJ12,Fresnillo PLC
GB00B019KW72,J Sainsbury PLC
GB0007669376,St James's Place PLC
GB0009697037,Babcock International Group PLC
GB0003718474,Games Workshop Group
GB0031638363,Intertek Group PLC
GB00BP9LHF23,Schroders PLC
GB0006731235,Associated British Foods PLC
BMG4593F1389,Hiscox Ltd
GB00BWFGQN14,Spirax Group Plc
GB0033195214,Kingfisher Plc
GB00B06QFB75,IG Group Holdings Plc
GB00BD3VFW73,ConvaTec Group Plc
GB0005576813,Howden Joinery Group PLC
GB00BYW0PQ60,Land Securities Group PLC
GB0031743007,Burberry Group PLC
GB00B4WFW713,LondonMetric Property Plc
GB00BVYVFW23,Autotrader Group Plc
GB00B1KJJ408,Whitbread PLC
GB0000961622,Balfour Beatty PLC
GB0000811801,Barratt Redrow Plc
GB00BJFFLV09,Croda International PLC
GB0001367019,British Land Co PLC
GB00BF8Q6K64,Aberdeen Group Plc
GB0006825383,Persimmon PLC
IM00B5VQMV65,Entain plc
GB00BMWC6P49,Mondi PLC
GB00BGDT3G23,Rightmove PLC
GB00BP0RGD03,Berkeley Group Holdings
GB0008782301,Taylor Wimpey PLC
GB00B1VNSX38,Drax Group PLC
GB00BVGBY890,Zegona Communications Plc
JE00BJ1DLW90,Man Group Plc
GB0033986497,ITV PLC
GB0007973794,Serco Group PLC
IL0011284465,Plus500 Ltd
GB0002318888,Cranswick PLC
GB00B61TVQ02,Inchcape PLC
GB00BKDRYJ47,Airtel Africa Plc
GB0003096442,RS Group
GB00BVFNZH21,Rotork PLC
GB00BNNTLN49,Pennon Group PLC
GB0031215220,Carnival PLC
GB0004300496,Pan African Resources Plc
GB0004657408,Mitie Group PLC
GB0000904986,Bellway PLC
GB00B0WMWD03,QinetiQ Group PLC
GB00B0LCW083,Hikma Pharmaceuticals Plc
GB0006928617,Unite Group Plc
GB00BV9FP302,Computacenter PLC
GB00BYT18307,TBC Bank Group Plc
GB00B62G9D36,Shaftesbury Capital Plc
GB00B1FW5029,Hochschild Mining PLC
GB00BMBVGQ36,Harbour Energy Plc
GB00BJVQC708,Helios Towers Plc
GB00BN7CG237,Aston Martin Lagonda
GB00B132NW22,Ashmore Group
GB0000066554,Aberforth Smaller Companies Trust
GB00BNG2M159,Allianz Technology Trust
CY0106002112,Atalaya Mining
GB00B6XZKY75,A.G. Barr
GB0000485838,Baillie Gifford Japan Trust
GB00BN4NDR39,Bankers Investment Trust
GB00BD0NVK62,Hollywood Bowl Group
GB00B3FLWH99,Bodycote
GB00BND88V85,Bridgepoint Group
GB00BM8NFJ84,Breedon Group
GB0006436108,BlackRock Smaller Companies Trust
GB0001490001,Brunner Investment Trust
GB0002869419,Big Yellow Group
GB00BMH18Q19,Bytes Technology Group
GB0007668071,Close Brothers Group
GB00BDCPN049,Coca-Cola Europacific Partners
GB0001738615,Capital Gearing Trust
GB00B45C9X44,Chemring Group
GB0002018363,Clarkson
GB00BTNQ8K38,Caledonia Investments
GB00B4YZN328,Coats Group
GB00B64NSP76,Costain Group
GB0001990497,City of London Investment Trust
GB00B2863827,CVS Group
GB00BG5KQW09,Ceres Power
GB0002652740,Derwent London
GB00B1CKQ739,Dunelm Group
GB00BL6NGV24,Dr. Martens
GB0000055888,discoverIE
GB0003052338,Edinburgh Investment Trust
GB00BL6K5J42,Endeavour Mining
GB0002418548,Elementis
GB00BG12Y042,Energean
GB00BLGXWY71,Eurowag
GB00B7KR2P84,EasyJet
GB00BG0TPX62,Funding Circle
GB0003466074,F & C Investment Trust
GB0003452173,FirstGroup
GB0007816068,Finsbury Growth & Income Trust
GB0006640972,4imprint
GB00B1QH8P22,Frasers Group
GB00BWXC7Y93,Fidelity Special Values
GB00BQS10J50,Gamma Communications
GB0006870611,GB Group
GB0003781050,Goodwin
GB00BKRC5K31,Genuit Group
GB00BKY40Q38,Galliford Try
IE00B00MZ448,Grafton Group
IE0003864109,Greencore
GB0002074580,Genus
GB00BF5H9P87,Great Portland Estates
GB00B63QSB39,Greggs
GB00B04V1276,Grainger
GB00BY7QYJ50,Molten Ventures
GB0004161021,Hays
GB00B1V9NW54,Hilton Food Group
GB0004270301,Hill & Smith
GB00BRJQ8J25,Hammerson
GB0004228648,Herald Investment Trust
GB0004478896,Hunting
GB00BYZJ7G42,Harworth Group
GB00BYXJC278,Ibstock
GB0031232498,Impax Environmental Markets
GB00B188SR50,International Public Partnerships
GB00B1YKG049,International Personal Finance
GB00B128J450,IP Group
GB00BPJHV584,Ithaca Energy
GB00BM8Q5M07,JD Sports
GB0001638955,Wetherspoons
GB0004762810,Johnson Service Group
GB00B53P2009,Jupiter Fund Management
GB0004915632,Kier Group
GB0004866223,Keller Group
GB00BZ0D6727,Kainos
GB0031429219,Law Debenture
GB00B1FP6H53,Mitchells & Butlers
GB0008481250,ME Group International
GB0006027295,Morgan Advanced Materials
GB0030517261,Monks Investment Trust
GB00B1ZBKY84,MONY Group
GB00BF4JDH58,Mercantile Investment Trust
GB0005800072,Merchants Trust
GB00B012BV22,Marshalls
GB00BMX3W479,Metro Bank
GB0006111123,Murray Income Trust
GB00B01QGK86,NCC Group
GB00B3MBS747,Ocado Group
GB00BP6S8Z30,Oxford Nanopore Technologies
GB00BLDRH360,OSB Group
GB00BDFBVT43,Oxford Biomedica
GB0006650450,Oxford Instruments
GB00B2NGPM57,Paragon Banking Group
GB0030232317,PageGroup
GB00BJ62K685,Pets at Home
GB00B7N0K053,Premier Foods
GB0006667470,Pacific Horizon Investment Trust
GB00BM8B5H06,Personal Assets Trust
GB0030474687,Patria Private Equity Trust
GB0002148343,Rathbones
GB0007366395,RIT Capital Partners
NL0012650360,RHI Magnesita
GB00B1L5QH97,Rank Group
GB00BS3DYQ52,Raspberry Pi Holdings
GB0007323586,Renishaw
GB00B1N7Z094,Safestore
GB0007873697,Scottish American Investment Company
GB00BYZDVK82,Softcat
GB0007918872,Schroder AsiaPacific Fund
GB00BLDYK618,Scottish Mortgage Investment Trust
GB00B2PDGW16,WHSmith
GB0007958233,Senior
GB00B0CRWN59,Schroder Oriental Income Fund
GB00BNLPYF73,Spire Healthcare
GB00BGBN7C04,SSP Group
GB00B135BJ46,Savills
GB00BP92CJ43,Tate & Lyle
GB0008794710,Telecom Plus
GB00BMTV7393,THG
GB00BMV92D64,Temple Bar Investment Trust
GB00BK9RKT01,Travis Perkins
GB00BKDTK925,Trainline
GB00BNK9TP58,Trustpilot
GB0009064097,TR Property Investment Trust
GB0009292243,Victrex
GB00B82YXW83,Vesuvius
GB0001859296,Vistry Group
GB00BL6C2002,Wickes
GB00B67G5X01,Workspace Group
GB00BJDQQ870,Watches of Switzerland
US7960502018,Samsung Electronics
NL0010273215,ASML HOLDING
CH1499059983,Roche Holding AG
GB00BP6MXD84,Shell Plc
CH0038863350,Nestle SA
FR0000120271,TotalEnergies
DE0007236101,Siemens AG
DE0007164600,SAP SE
ES0113900J37,Banco Santander SA
DE0008404005,Allianz SE
FR0000121972,Schneider Electric SE
ES0144580Y14,Iberdrola SA
FR0000121014,LVMH
DE0005557508,Deutsche Telekom AG
DE000ENER6Y0,Siemens Energy AG
CH0012221716,ABB
ES0113211835,BBVA
FR0000073272,Safran SA
FR0000120073,Air Liquide
CH0244767585,UBS Group
NL0000235190,Airbus SE
FR0000120578,Sanofi
IT0005239360,UniCredit SpA
CH0011075394,Zurich Insurance Group AG
FR0000131104,BNP Paribas SA
FR0000120321,L'Oreal
CH0210483332,Richemont
IT0000072618,Intesa Sanpaolo SpA
FR0000125486,Vinci SA
IT0003128367,Enel SpA
DE0008430026,Munich Re
FR0000120628,AXA
DE0007030009,Rheinmetall
NL0011821202,ING GROEP N.V.
FR0000121667,EssilorLuxottica SA
BE0974293251,AB InBev
SE0015811963,Investor B
FR0000052292,Hermes International
ES0148396007,Inditex
FR0010208488,Engie SA
FI4000297767,Nordea Bank
DE0006231004,Infineon Technologies AG
IT0003132476,Eni SpA
DE0005140008,Deutsche Bank
NL0013654783,PROSUS
FR0000130809,Societe Generale SA
DE0005810055,Deutsche Boerse AG
DE000BASF111,BASF SE
SE0000115446,Volvo B
FR0000120644,Danone SA
CH0126881561,Swiss Re AG
DE000ENAG999,E.ON SE
DE0005552004,Deutsche Post AG
DK0060079531,DSV
DE0007037129,RWE AG
DE000BAY0017,Bayer AG
NL0010832176,Argen X SE
SE0017486889,Atlas Copco A
CH0013841017,Lonza Group AG
DE0007100000,Mercedes Benz Group
IT0000062072,Generali
CH0012214059,Holcim Ltd
FI0009000681,Nokia
NL0011794037,Ahold Delhaize
ES0140609019,CaixaBank
FR0000133308,Orange
NL0011585146,Ferrari N.V.
SE0000667891,Sandvik
FR0000125007,Saint-Gobain
FR0010307819,Legrand SA
BE0003739530,UCB SA
CH0432492467,Alcon
NL0000334118,ASM International N.V.
SE0007100581,Assa Abloy B
CH1243598427,Sandoz Group AG
IT0004176001,Prysmian S.p.A
SE0000108656,Ericsson B
AT0000652011,Erste Group Bank AG
DK0010274414,Danske Bank
ES0173516115,Repsol SA
NL0015001FS8,Ferrovial SE
NL0012969182,Adyen
SE0000242455,Swedbank A
CH0014852781,Swiss Life Holding AG
CH1335392721,Galderma Group AG
DK0061539921,Vestas Wind Systems
SE0000148884,SEB A
DE000A1EWWW0,Adidas AG
FR0000121329,Thales
IT0003856405,Leonardo S.p.A.
BE0003565737,KBC Groupe NV
FI4000552500,Sampo A
NO0010161896,DNB Bank
CH0418792922,Sika AG
DE0006047004,Heidelberg Materials
DE000DTR0CK8,Daimler Truck
CH0010645932,Givaudan SA
ES0109067019,Amadeus IT Group S.A.
FI0009013403,Kone B
DE0005190003,BMW
FR0000124141,Veolia
ES0167050915,ACS
DE000CBK1001,Commerzbank AG
CH0024608827,Partners Group Holding AG
FR001400AJ45,Michelin
IE00BYTBXV33,Ryanair Holdings Plc
CH0030170408,Geberit AG
IE00BF0L3536,AIB Group Plc
LU1598757687,ArcelorMittal SA
NL0000226223,STMicroelectronics NV
ES0105046017,Aena S.M.E. S.A.
SE0021921269,SAAB B
NL0000009082,KPN
NL0015000IY2,Universal Music Group
CH0008742519,Swisscom AG
FR0000121485,Kering SA
DE0005785604,Fresenius SE
NL0000009538,Philips
DK0060336014,Novonesis B
DE0007664039,Volkswagen PRF
NL0010773842,NN GROUP
FR0000045072,Credit Agricole SA
SE0007100599,Handelsbanken A
SE0015961909,Hexagon B
FR0000125338,Capgemini SE
CH0466642201,Helvetia Baloise Holding AG
FR0000130577,Publicis Groupe SA
NL0011540547,ABN AMRO BANK N.V.
DE000A0D9PT0,MTU Aero Engines AG
IT0005508921,Banca Monte dei Paschi di Siena SpA
NO0013536151,Kongsberg Gruppen
DE0008402215,Hannover Ruck SE
IT0000066123,BPER Banca S.p.A
DE000A1ML7J1,Vonovia SE
FI0009003727,Wartsila B
ES0113860A34,Banco de Sabadell SA
NL0000395903,Wolters Kluwer
DK0010272202,Genmab
FI0009005987,UPM-Kymmene
CH0311864901,VAT Group AG
ES0178430E18,Telefonica S.A
IE00BD1RP616,Bank Of Ireland Group
IT0003242622,Terna
DE0006599905,Merck KGAA
ES0105066007,Cellnex Telecom S.A.
FR0000120503,Bouygues SA
DE000SHL1006,Siemens Healthineers AG
IT0003153415,Snam SpA
SE0000695876,Alfa Laval
IT0005218380,Banco BPM S.p.A
NL0012866412,BE Semiconductor Industries N.V.
SE0015658109,Epiroc A
SE0009922164,Essity B
CH0102484968,Julius Baer Group Ltd
FR0000130452,Eiffage SA
FR0000120693,Pernod Ricard SA
SE0020050417,Boliden
FR0014003TT8,Dassault Systemes SE
NL00150001Q9,Stellantis N.V
CH0010570767,Lindt & Sprungli AG
FI0009013296,Neste
NO0005052605,Norsk Hydro
CH0008038389,Swiss Prime Site AG
IT0000072170,Finecobank SpA
IT0004965148,Moncler SpA
CH0025751329,Logitech International SA
CH0024638196,Schindler Holding AG
ES0130670112,Endesa S.A.
IE0004927939,Kingspan Group Plc
NL0006294274,Euronext
IE0004906560,Kerry Group Plc
CH0025238863,Kuehne + Nagel International AG
CH1175448666,Straumann Holding AG
CH1216478797,DSM FIRMENICH AG
BE0974264930,Ageas
SE0000667925,Telia Company
DE0006048432,Henkel PRF
FR0000120172,Carrefour SA
AT0000BAWAG2,Bawag Group AG
DK0010181759,Carlsberg B
NO0010345853,Aker BP
SE0005190238,Tele2 B
DE000SYM9999,Symrise AG
DK0060094928,Orsted
FI0009007132,Fortum
NO0010063308,Telenor
CH0012549785,Sonova Holding AG
FI0009014575,Metso
IT0003796171,Poste Italiane
AT0000743059,OMV AG
DK0060448595,Coloplast B
FR0006174348,Bureau Veritas SA
DE0006602006,GEA Group AG
NL0011872643,ASR NEDERLAND
NO0003054108,Mowi
ES0113679I37,Bankinter SA
NL0013267909,AKZO NOBEL
FR0010220475,Alstom SA
SE0000872095,Swedish Orphan Biovitrum
SE0000113250,Skanska B
NO0010208051,Yara International
NO0003733800,Orkla
LU2598331598,Tenaris SA
IT0004810054,Unipol Assicurazioni S.p.A.
CH0018294154,PSP Swiss Property AG
FR0010451203,Rexel
FR0011726835,Gaztransport Et Technigaz SA
SE0014781795,Addtech B
DK0010244508,A.P. Moller Maersk B
FR0014000MR3,Eurofins Scientific SE
DE0005785802,Fresenius Medical Care
SE0000106270,H&M B
NL0000008977,Heineken Holding
FR0012757854,SPIE SA
CH1169360919,Accelleron Industries AG
FR0000121964,Klepierre
SE0000163594,Securitas B
NL0015002SN0,Qiagen
SE0012673267,Evolution
ES0116870314,Naturgy Energy Group S.A.
DE0005200000,Beiersdorf AG
CH1101098163,BELIMO Holding AG
NO0003053605,Storebrand
DE0006070006,Hochtief AG
DE000A1DAHH0,Brenntag SE
DK0060636678,Tryg
SE0000114837,Trelleborg B
DE0005439004,Continental AG
DE000KBX1006,Knorr-Bremse AG
IT0005211237,Italgas S.p.A
DE000TLX1005,Talanx AG
FI0009007884,Elisa
FI0009005961,Stora Enso R
LU0075646355,Subsea 7
FR0000131906,Renault SA
DK0010287663,NKT
ES0173093024,Redeia Corporacion S.A.
FI0009005870,Konecranes
IT0005541336,Lottomatica Group S.p.A
FR0010259150,Ipsen SA
FR0010533075,Getlink SE
SE0015949201,Lifco B
BE0003797140,Groupe Bruxelles Lambert SA
DE000A0D6554,Nordex SE
FR0014004L86,Dassault Aviation
BE0003764785,Ackermans & van Haaren NV
ES0125220311,Acciona SA
IT0003828271,Recordati SpA
DE0007165631,Sartorius AG PRF
SE0000112724,SCA B
CH0009002962,Barry Callebaut AG
ES0105025003,Merlin Properties SOCIMI S.A
FI0009000202,Kesko B
SE0001515552,Indutrade
CH0023405456,Avolta AG
IT0005495657,Saipem Spa
SE0015988019,Nibe Industrier B
CH0319416936,Flughafen Zurich AG
NL0014332678,JDE PEETS
CH0010675863,Swissquote Group Holding Ltd
NL0010801007,IMCD
FR0010411983,SCOR SE
CH0360674466,Galenica AG
DE000ZAL1111,Zalando SE
DE000A12DM80,Scout24 SE
FR0004125920,Amundi
DK0010307958,Jyske Bank
DE000PAH0038,Porsche Automobil Holding SE
SE0015949748,Beijer Ref B
NL0014559478,Technip Energies N.V.
SE0015192067,Nordnet
DK0010311471,AL Sydbank
AT0000606306,Raiffeisen Bank International AG
FR0013154002,Sartorius Stedim Biotech
CH0016440353,Ems-Chemie Holding AG
DE000HAG0005,Hensoldt AG
DK0060252690,Pandora
NL0000360618,SBM OFFSHORE
BE0003823409,Financiere de Tubize S.A.
FR0013280286,Biomerieux
CY0200352116,Frontline
AT0000746409,Verbund AG
DE0008232125,Deutsche Lufthansa AG
FR0000044448,Nexans SA
FR0012435121,Elis SA
DE000PAG9113,Porsche
DE000RENK730,RENK Group
BE0974349814,Warehouses De Pauw SA
DE000LEG1110,LEG Immobilien SE
NO0010582521,Gjensidige Forsikring
AT0000937503,Voestalpine AG
DE000EVNK013,Evonik Industries AG
ES0118594417,Indra Sistemas SA
SE0012454072,Avanza Bank Holding
ES0127797019,EDP Renovaveis SA
ES0130960018,Enagas SA
DE0006452907,Nemetschek SE
BE0003604155,Lotus Bakeries NV
CH0531751755,Banque Cantonale Vaudoise
LU2290522684,INPOST S.A.
AT0000730007,Andritz AG
FR0010908533,Edenred SE
IT0004776628,Banca Mediolanum SpA
CH0435377954,SIG Group AG
IT0001233417,A2A SpA
NL0015000LU4,Iveco Group NV
FR0010313833,Arkema SA
CH0008837566,Allreal Holding AG
DE0006766504,Aurubis AG
SE0000202624,Getinge B
NL0015435975,Davide Campari-Milano SpA
DE000A0WMPJ6,AIXTRON SE
FR0013506730,Vallourec SA
IT0003261697,Azimut Holding SpA
FR0000121220,Sodexo
DE0007500001,thyssenkrupp AG
SE0000379190,Castellum
SE0014990966,Lagercrantz Group B
FI4000074984,Valmet
SE0005127818,Sagax B
ES0124244E34,Mapfre SA
BE0974464977,Syensqo S.A.
BE0003717312,Sofina SA
CH0012138605,Adecco Group AG
CH1386220409,Sunrise Communications AG
DE000A2E4K43,Delivery Hero SE
CH1169151003,Georg Fischer AG
IT0001347308,Buzzi Spa
IE0000669501,Glanbia Plc
DE0005909006,Bilfinger SE
FR0010040865,Gecina Nom
CH1429326825,Siegfried Holding AG
IT0001250932,Hera SpA
CH0225173167,Cembra Money Bank AG
DE0007010803,Rational AG
DE000A0Z2ZZ5,Freenet AG
BE0974320526,Umicore SA
DE000KGX8881,Kion Group AG
CH0038388911,Sulzer AG
CH0011108872,Mobimo Hldg AG
CH0030380734,Huber & Suhner AG
CH0014786500,Valiant Holding AG
FR0000051807,Teleperformance
DK0060634707,Royal UNIBREW
IT0001031084,Banca Generali SpA
FR0010340141,Aeroports de Paris SA
FR0013451333,FDJ United
DE0005470306,CTS Eventim AG
ES0180907000,Unicaja Banco S.A.
FR0000064578,Covivio
DK0010234467,FLSmidth & Co
IT0001078911,Interpump Group SpA
DE0005773303,Fraport AG
DE000KSAG888,K & S AG
NL0000852564,AALBERTS N.V.
DE000FTG1111,flatexDEGIRO SE
IT0005278236,Pirelli & C. S.p.A.
IT0005482333,Technoprobe Spa
NL0009432491,VOPAK
DK0060257814,Zealand Pharma
DE0008303504,TAG Immobilien AG
IT0004764699,Brunello Cucinelli S.p.A.
AT0000831706,Wienerberger AG
NO0003055501,Nordic Semiconductor
ES0182870214,Sacyr S.A.
NL0000379121,Randstad N.V.
ES0171996087,Grifols SA
NO0012470089,Tomra Systems
CH0002432174,Bucher Industries AG
DE0005158703,Bechtle AG
GB00BNTJ3546,ALLFUNDS GROUP PLC
NO0006390301,SPAREBANK 1 SMN
CH0239229302,SFS Group AG
DK0060738599,Demant
SE0011090018,Holmen B
DK0063855168,Rockwool B
CH0012829898,Emmi AG
CH0022268228,EFG International AG
DE0006969603,Puma SE
FR0013176526,Valeo SA
ES0184262212,Viscofan S.A.
ES0105777017,Puig Brands S.A.
NO0010209331,Protector Forsikring
CH0126673539,DKSH Holding AG
ES0132105018,Acerinox SA
DK0060952919,Netcompany
NL0000302636,V LANSCHOT KEMPEN
NL0011821392,SIGNIFY NV
NL0000337319,Koninklijke BAM Groep N.V.
CH1176493729,Bachem Holding AG
IT0005366767,Nexi SpA
CH1252930610,Luzerner Kantonalbank AG
DE0005089031,United Internet AG
FI0009004824,Kemira
AT0000908504,Vienna Insurance Group AG
SE0018012635,Wihlborgs Fastigheter
IT0004931058,Maire S.p.A.
US01609W1027,Alibaba Group
US8923313071,Toyota Motor
US6068221042,Mitsubishi UFJ Financial
US40415F1012,HDFC Bank
US86562M2098,Sumitomo Mitsui Financial
US8356993076,Sony Group
IL0010811243,Elbit Systems
US8816242098,Teva Pharmaceutical
US45104G1040,ICICI Bank
US60687Y1091,Mizuho Financial Group
US00215W1009,ASE Technology Holding
US4567881085,Infosys
US8740602052,Takeda Pharmaceutical
US0567521085,Baidu
US47215P1066,JD.com
US48241A1051,KB Financial Group"""

# ── Parse universe ─────────────────────────────────────────────────────────────

def parse_universe(raw):
    rows = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or "," not in line:
            continue
        isin, name = line.split(",", 1)
        isin, name = isin.strip(), name.strip()
        if len(name) <= 3 and name.isupper():
            continue   # skip currency placeholders
        rows.append({"isin": isin, "name": name})
    return pd.DataFrame(rows)

# ── OpenFIGI resolution ────────────────────────────────────────────────────────

OPENFIGI_URL   = "https://api.openfigi.com/v3/mapping"
OPENFIGI_BATCH = 10

SUFFIX_MAP = {
    "LN": ".L", "FP": ".PA", "GY": ".DE", "NA": ".AS", "SM": ".MC",
    "IM": ".MI", "SS": ".ST", "HB": ".HE", "NO": ".OL", "DC": ".CO",
    "SW": ".SW", "AV": ".VI", "PW": ".WA", "ID": ".IR", "BB": ".BR",
}
ISIN_SUFFIX = {
    "GB": ".L", "JE": ".L", "IM": ".L", "GG": ".L",
    "FR": ".PA", "DE": ".DE", "NL": ".AS", "ES": ".MC",
    "IT": ".MI", "SE": ".ST", "FI": ".HE", "NO": ".OL",
    "DK": ".CO", "CH": ".SW", "AT": ".VI", "BE": ".BR",
    "PT": ".LS", "IE": ".IR", "IL": ".TA",
}

def to_yf_ticker(ticker, exch, isin):
    if not ticker:
        return ""
    if exch in ("US", "UN", "UW", "UA", "UR") or isin[:2] in ("US", "CA"):
        return ticker
    suffix = SUFFIX_MAP.get(exch) or ISIN_SUFFIX.get(isin[:2], "")
    return f"{ticker}{suffix}" if suffix else ticker

def resolve_isins(isins):
    print(f"Resolving {len(isins)} ISINs via OpenFIGI...")
    results = {}
    for i in range(0, len(isins), OPENFIGI_BATCH):
        batch   = isins[i:i + OPENFIGI_BATCH]
        payload = [{"idType": "ID_ISIN", "idValue": x} for x in batch]
        for attempt in range(3):
            try:
                r = requests.post(OPENFIGI_URL,
                                  headers={"Content-Type": "application/json"},
                                  json=payload, timeout=30)
                if r.status_code == 429:
                    wait = 60 * (attempt + 1)
                    print(f"  Rate limited — waiting {wait}s")
                    time.sleep(wait); continue
                r.raise_for_status()
                data = r.json(); break
            except Exception as e:
                print(f"  Error attempt {attempt+1}: {e}")
                time.sleep(10)
        else:
            continue
        for isin, result in zip(batch, data):
            if "data" not in result or not result["data"]:
                continue
            entries  = result["data"]
            equities = [e for e in entries if e.get("securityType") in
                        ("Common Stock", "Ordinary Shares", "EQS", "Common Share")]
            best = (equities or entries)[0]
            yft  = to_yf_ticker(best.get("ticker",""), best.get("exchCode",""), isin)
            if yft:
                results[isin] = yft
        time.sleep(1.5)
        print(f"  {min(i+OPENFIGI_BATCH, len(isins))}/{len(isins)} resolved...")
    print(f"  → {len(results)} tickers")
    return results

# ── Prices ─────────────────────────────────────────────────────────────────────

def fetch_prices(tickers):
    print(f"\nFetching prices for {len(tickers)} tickers...")
    frames = []
    for i in range(0, len(tickers), 200):
        chunk = tickers[i:i+200]
        df = yf.download(chunk, period="1y", auto_adjust=True,
                         progress=False, threads=True)
        if hasattr(df.columns, "levels"):
            frames.append(df["Close"])
        else:
            frames.append(df[["Close"]])
        print(f"  {min(i+200, len(tickers))}/{len(tickers)}...")
        time.sleep(0.5)
    prices = pd.concat(frames, axis=1)
    prices = prices.loc[:, ~prices.columns.duplicated()]
    prices = prices.dropna(axis=1, thresh=int(MIN_DATA_COVERAGE * len(prices)))
    prices = prices.ffill().dropna()
    print(f"  → {prices.shape[1]} tickers, {prices.shape[0]} days")
    return prices

# ── Tail dependence ────────────────────────────────────────────────────────────

def tail_vol(returns, q=TAIL_THRESH):
    out = {}
    for col in returns.columns:
        r = returns[col]
        t = r.quantile(q)
        out[col] = r[r > t].mean() if (r > t).any() else 0.0
    return pd.Series(out).sort_values(ascending=False)

def tail_dep_matrix(returns, q=TAIL_THRESH):
    print("Computing tail dependence matrix...")
    cols = returns.columns.tolist()
    n    = len(cols)
    td   = np.zeros((n, n))
    thr  = returns.quantile(q)
    for j in range(n):
        days = returns.index[returns.iloc[:, j] > thr.iloc[j]]
        nt   = len(days)
        if nt == 0: continue
        for i in range(n):
            td[i, j] = (returns.loc[days, cols[i]] > thr.iloc[i]).sum() / nt
    df = pd.DataFrame(td, index=cols, columns=cols)
    df = (df + df.T) / 2
    print("  → Done")
    return df

# ── Clustering ─────────────────────────────────────────────────────────────────

def cluster_stocks(td, k):
    print(f"Clustering into {k} groups...")
    dist = np.clip((1 - td.values + (1 - td.values).T) / 2, 0, 1)
    np.fill_diagonal(dist, 0)
    Z      = linkage(squareform(dist, checks=False), method="average")
    labels = fcluster(Z, t=k, criterion="maxclust")
    out    = {}
    for ticker, lbl in zip(td.columns, labels):
        out.setdefault(int(lbl), []).append(ticker)
    print(f"  → sizes: {sorted([len(v) for v in out.values()], reverse=True)[:10]}")
    return out

# ── Portfolio selection ────────────────────────────────────────────────────────

def best5(tickers, td, tv):
    if len(tickers) < 5:
        return None
    # Pre-filter to top 15 by tail vol to keep search tractable
    tvs = tv.reindex(tickers).fillna(0)
    cands = tvs.nlargest(min(15, len(tickers))).index.tolist()
    tv_c = tv.reindex(cands).fillna(0)
    tvn  = (tv_c - tv_c.min()) / (tv_c.max() - tv_c.min() + 1e-9)
    # Score = weight-adjusted sum of pairwise tail dependences + weighted individual tail vols
    # Pair (i,j) is weighted by w_i * w_j so the 5% stock barely influences selection.
    # Stocks are sorted by tail vol descending to assign weights before scoring.
    best_score, best_combo = -np.inf, None
    for combo in combinations(cands, 5):
        # Assign weights in tail-vol order: highest vol gets 25%, ..., lowest gets 5%
        sorted_combo = sorted(combo, key=lambda t: tv.get(t, 0), reverse=True)
        w = np.array(WEIGHTS)
        td_sum = sum(
            w[i] * w[j] * td.loc[a, b]
            for (i, a), (j, b) in combinations(enumerate(sorted_combo), 2)
            if a in td.index and b in td.columns
        )
        tv_sum = sum(w[k] * tvn.get(t, 0) for k, t in enumerate(sorted_combo))
        score  = td_sum + tv_sum
        if score > best_score:
            best_score, best_combo = score, sorted_combo
    return best_combo

def select_portfolios(clusters, td, tv, n):
    cands = [p for p in (best5(t, td, tv) for t in clusters.values()) if p]
    if not cands:
        raise ValueError("No valid portfolios found")
    selected  = [cands[0]]
    remaining = cands[1:]
    while len(selected) < n and remaining:
        best_next, lowest = None, np.inf
        for candidate in remaining:
            cross = np.mean([
                np.mean([td.loc[a,b] for a in candidate for b in sel
                         if a in td.index and b in td.columns])
                for sel in selected
            ])
            if cross < lowest:
                lowest, best_next = cross, candidate
        if best_next:
            selected.append(best_next)
            remaining = [p for p in remaining if p != best_next]
    return selected

# ── Output ─────────────────────────────────────────────────────────────────────

def print_results(portfolios, returns, td, tv, isin_to_name, ticker_to_isin):
    def name(t):
        return isin_to_name.get(ticker_to_isin.get(t,""), t)[:35]

    print("\n" + "═"*72)
    print("  FT STOCK PICKING GAME — RECOMMENDED PORTFOLIOS")
    print("  Strategy: max tail co-movement within  |  min tail dep across")
    print("═"*72)

    for i, port in enumerate(portfolios, 1):
        sp = sorted(port, key=lambda t: tv.get(t,0), reverse=True)
        r  = returns[port].dropna()
        pv = (r @ np.array(WEIGHTS)).std() * np.sqrt(252) * 100
        mt = np.mean([td.loc[a,b] for a,b in combinations(port,2)
                      if a in td.index and b in td.columns])
        mv = np.mean([tv.get(t,0) for t in port]) * 100

        print(f"\n  Portfolio {i}  |  Ann.vol {pv:.1f}%  |  "
              f"Mean pairwise tail dep {mt:.3f}  |  Mean tail move {mv:.2f}%\n")
        rows = [[WEIGHT_LABELS[j], t, name(t), f"{tv.get(t,0)*100:.2f}%"]
                for j, t in enumerate(sp)]
        print(tabulate(rows,
                       headers=["Wt", "Ticker", "Name", "Avg tail-day ret"],
                       tablefmt="simple", colalign=("right","left","left","right")))

    # Cross-portfolio matrix
    n = len(portfolios)
    print("\n" + "─"*72)
    print("  Cross-portfolio tail dependence (lower = more independent)\n")
    hdr  = [f"P{i+1}" for i in range(n)]
    rows = []
    for i, p1 in enumerate(portfolios):
        row = [f"P{i+1}"]
        for j, p2 in enumerate(portfolios):
            if i == j:
                row.append("—")
            else:
                v = np.mean([td.loc[a,b] for a in p1 for b in p2
                             if a in td.index and b in td.columns])
                row.append(f"{v:.3f}")
        rows.append(row)
    print(tabulate(rows, headers=[""]+hdr, tablefmt="simple"))

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    universe = parse_universe(RAW_ISINS)
    print(f"Universe: {len(universe)} stocks")
    isin_to_name = dict(zip(universe["isin"], universe["name"]))

    # Resolve ISINs → tickers (cached)
    if TICKER_CACHE.exists():
        print(f"Loading ticker cache from {TICKER_CACHE}")
        c = pd.read_csv(TICKER_CACHE)
        isin_ticker = dict(zip(c["isin"], c["ticker"]))
    else:
        isin_ticker = resolve_isins(universe["isin"].tolist())
        pd.DataFrame([{"isin":k,"ticker":v} for k,v in isin_ticker.items()]
                     ).to_csv(TICKER_CACHE, index=False)
        print(f"Saved to {TICKER_CACHE}")

    ticker_to_isin = {v:k for k,v in isin_ticker.items()}
    tickers        = list(set(isin_ticker.values()))
    print(f"Resolved {len(tickers)} unique tickers")

    # Prices (cached)
    if PRICE_CACHE.exists():
        print(f"Loading price cache from {PRICE_CACHE}")
        prices = pd.read_csv(PRICE_CACHE, index_col=0, parse_dates=True)
    else:
        prices = fetch_prices(tickers)
        prices.to_csv(PRICE_CACHE)
        print(f"Saved to {PRICE_CACHE}")

    returns = np.log(prices / prices.shift(1)).dropna()
    print(f"Returns: {returns.shape[0]} days × {returns.shape[1]} stocks")

    tv = tail_vol(returns)
    td = tail_dep_matrix(returns)

    clusters   = cluster_stocks(td, k=30)
    portfolios = select_portfolios(clusters, td, tv, n=N_PORTFOLIOS)
    print_results(portfolios, returns, td, tv, isin_to_name, ticker_to_isin)

    # Save CSV
    records = []
    for i, port in enumerate(portfolios, 1):
        sp = sorted(port, key=lambda t: tv.get(t,0), reverse=True)
        for j, t in enumerate(sp):
            isin = ticker_to_isin.get(t,"")
            records.append({"portfolio": i, "weight": WEIGHTS[j], "ticker": t,
                             "isin": isin, "name": isin_to_name.get(isin, t),
                             "tail_vol_pct": round(tv.get(t,0)*100, 3)})
    pd.DataFrame(records).to_csv("ft_portfolios_output.csv", index=False)
    print("\nSaved to ft_portfolios_output.csv")

if __name__ == "__main__":
    main()