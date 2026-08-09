# Quick Test Guide - Laser Chess AI

## Testing the AI (5-minute check)

### Step 1: Open the Game
Open `index.html` in your browser (Chrome, Firefox, or Safari recommended)

### Step 2: Open Developer Console
- **Windows/Linux**: Press `F12` or `Ctrl+Shift+I`
- **Mac**: Press `Cmd+Option+I`
- Click on the "Console" tab

### Step 3: Enable AI
1. Click the "AI Opponent: OFF" button in the game
2. It should change to "AI Opponent: ON"
3. In the console, you should see: `"Stockfish initialized successfully"`

### Step 4: Make a Move
1. Click on one of your white pawns (bottom of board)
2. Click on a legal destination (highlighted)
3. **Watch the console** - you should see:
   ```
   AI turn detected, requesting move...
   Requesting AI move...
   FEN: [position string]
   Stockfish: bestmove [move]
   Applying AI move: [move]
   AI move applied successfully
   ```

### Step 5: Watch AI Response
Within 1-2 seconds, a black piece should move automatically.

---

## If AI Doesn't Work

### Check Console Messages

**Good messages (AI working):**
- ✅ `Stockfish initialized successfully`
- ✅ `AI turn detected, requesting move...`
- ✅ `Stockfish: bestmove e7e5`
- ✅ `AI move applied successfully`

**Error messages (needs fixing):**
- ❌ `Stockfish not loaded` → stockfish.js file missing
- ❌ `Stockfish Worker error` → file corrupted or blocked
- ❌ `Could not find piece for AI move` → position sync issue (refresh page)
- ❌ `Could not find legal ply` → move validation issue (report this!)

### Quick Fixes

**No console messages at all?**
→ Hard refresh: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)

**Stockfish not loaded?**
→ Check that `stockfish.js` is in the same folder as `index.html`
→ Check file size: should be ~932KB

**Still not working?**
1. Try different browser
2. Check browser console for security errors (CORS, blocked workers, etc.)
3. Make sure JavaScript is enabled
4. Check if Web Workers are supported (they are in all modern browsers)

---

## Expected Behavior

✅ **What should happen:**
1. You make a move → Black piece moves automatically
2. "AI is thinking..." appears briefly
3. Console shows detailed logs of AI activity
4. AI responds within 1-2 seconds

✅ **Controls:**
- Press `A` to switch AI color (White/Black)
- Press `+/-` to adjust strength (0-20)
- Click "AI Opponent" button to toggle on/off

---

## Still Having Issues?

Copy the console error messages and:
1. Check the `AI_README.md` for detailed troubleshooting
2. Check file structure:
   ```
   Laser Chess/
   ├── index.html
   ├── sketch.js
   ├── style.css
   ├── stockfish.js (932KB)
   └── AI_README.md
   ```

The AI is tested and working - most issues are browser-related or file loading issues.
