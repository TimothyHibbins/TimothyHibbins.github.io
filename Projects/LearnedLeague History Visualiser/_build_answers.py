"""
Fetch all Learned League Q&A from trivialstudies.com and write answers.js.
Run once from this directory to regenerate the static answer data.
"""
import re, json, time
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

answers = {}
skipped = []

for season in range(1, 109):
    url = f"https://www.trivialstudies.com/study_1212{season}&shuffle=false"
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except (HTTPError, URLError) as e:
        skipped.append(f"S{season}: {e}")
        print(f"S{season}: SKIP ({e})")
        continue

    if 'id="question_0"' not in html:
        skipped.append(f"S{season}: no data")
        print(f"S{season}: no data")
        continue

    q_cells = re.findall(r'id="question_(\d+)">(.*?)</td>', html, re.DOTALL)
    count = 0
    for idx, content in q_cells:
        ans_match = re.search(rf'id="ans_{re.escape(idx)}"[^>]*><b>(.*?)</b>', html)
        if not ans_match:
            continue
        m = re.search(r'Season:\s*(\d+)\s*-\s*Day:\s*(\d+)\s*-\s*Question:\s*(\d+)', content)
        if not m:
            continue
        key = f"{int(m.group(1))}-{int(m.group(2))}-{int(m.group(3))}"
        answers[key] = re.sub(r'<[^>]+>', '', ans_match.group(1)).strip()
        count += 1

    print(f"S{season}: {count} answers")
    time.sleep(0.35)

print(f"\nTotal: {len(answers)} answers across all seasons")
if skipped:
    print("Skipped:", skipped[:10])

# Write as a JS global — included via <script src="answers.js">
out_path = "answers.js"
with open(out_path, "w", encoding="utf-8") as f:
    f.write("// LearnedLeague question answers sourced from trivialstudies.com\n")
    f.write(f"// Generated {time.strftime('%Y-%m-%d')} — {len(answers)} entries\n")
    f.write("// Key: 'season-matchday-question'  Value: correct answer string\n")
    f.write("const LL_ANSWERS = ")
    f.write(json.dumps(answers, ensure_ascii=False, separators=(",", ":")))
    f.write(";\n")

print(f"Written {out_path}")
