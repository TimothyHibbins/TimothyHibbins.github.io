# Laser Chess - AI Integration

## Overview

Your Laser Chess game now includes a powerful AI opponent powered by Stockfish, one of the strongest chess engines in the world!

## Features

✅ **AI Opponent** - Play against a computer opponent  
✅ **Adjustable Difficulty** - Set AI strength from 0 (beginner) to 20 (grandmaster)  
✅ **Flexible Color Selection** - Choose whether AI plays as White or Black  
✅ **Visual Feedback** - See when the AI is thinking  
✅ **Seamless Integration** - AI automatically makes moves when it's their turn  

## How to Use

### Basic Controls

1. **Enable/Disable AI**
   - Click the "AI Opponent" button to toggle the AI on or off
   - When ON, the AI will automatically make moves for its assigned color

2. **Choose AI Color**
   - Press the **'A' key** to toggle between AI playing as White or Black
   - Default: AI plays as Black (you play as White)

3. **Adjust AI Strength**
   - Press **'+'** or **'='** to increase difficulty (0-20)
   - Press **'-'** to decrease difficulty
   - Level 0: Beginner (makes intentional mistakes)
   - Level 10: Intermediate (default)
   - Level 20: Grandmaster level

### Visual Indicators

When AI is enabled, you'll see:
- "AI is thinking..." message while the AI calculates its move
- Current AI color (White or Black)
- Current AI strength level (0-20)
- Control hints for changing settings

## Technical Details

### Architecture

The AI integration consists of several components:

1. **Stockfish Engine** (`stockfish.js`)
   - JavaScript port of the Stockfish chess engine
   - Communicates via UCI (Universal Chess Interface) protocol
   - Local file for reliability and offline functionality

2. **FEN Conversion**
   - Converts game position to Forsyth-Edwards Notation (FEN)
   - FEN is the standard format for describing chess positions
   - Includes: piece placement, active color, castling rights, en passant

3. **UCI Move Parsing**
   - Stockfish returns moves in UCI format (e.g., "e2e4", "e7e8q")
   - Parser converts UCI to internal Ply objects
   - Handles special moves: castling, en passant, pawn promotion

4. **Automatic Move Application**
   - AI moves are applied automatically after opponent moves
   - Small delay (500ms) for natural feel
   - Integrates with existing move validation system

### Key Functions

```javascript
// Initialize Stockfish engine
initializeStockfish()

// Convert position to FEN notation
positionToFEN(position)

// Request AI to calculate best move
requestAIMove()

// Apply AI move from UCI notation
applyAIMove(uciMove)

// Check if AI should make a move
checkAndMakeAIMove()
```

### Configuration

You can adjust these parameters in the code:

```javascript
// AI Settings
aiColor = BLACK;          // WHITE or BLACK
aiSkillLevel = 10;        // 0-20
moveTime = 1000;          // Time in ms (currently 1000ms = 1 second)
```

## Files Modified/Added

### Modified Files
- `index.html` - Added Stockfish.js script
- `sketch.js` - Added AI integration code (~250 lines)

### New Files
- `stockfish.js` - Stockfish chess engine (932KB)
- `AI_README.md` - This documentation file

## How It Works

1. **User Makes Move** → Position updates
2. **Check Turn** → Is it AI's turn?
3. **Convert to FEN** → Current position → FEN string
4. **Send to Stockfish** → FEN via UCI protocol
5. **Stockfish Calculates** → Best move in UCI format
6. **Parse UCI Move** → UCI → Internal move format
7. **Apply Move** → Update position and board
8. **Repeat** → Wait for user's next move

## Troubleshooting

### AI Not Making Moves

**First, check the browser console (F12 → Console tab) for debug messages:**

The AI now includes detailed logging:
- "Stockfish initialized successfully" - Engine loaded correctly
- "AI turn detected, requesting move..." - AI recognizes it's their turn
- "Requesting AI move..." - AI is calculating
- "FEN: ..." - Position sent to engine
- "Stockfish: bestmove ..." - Engine response
- "Applying AI move: ..." - Move being applied
- "AI move applied successfully" - Move completed

**Common issues and solutions:**

1. **AI button shows "ON" but nothing happens:**
   - Open browser console (F12) and look for errors
   - Check if "Stockfish initialized successfully" message appears
   - Make sure `stockfish.js` file is in the same directory as `index.html`
   - Try refreshing the page (Ctrl+R or Cmd+R)

2. **"Stockfish Worker error" in console:**
   - The `stockfish.js` file may be corrupted
   - Re-download it or check file permissions

3. **AI moves but very slowly:**
   - Reduce AI strength with the '-' key
   - Check browser performance (close other tabs)
   - AI move time is 1 second by default

4. **AI only works sometimes:**
   - Make sure you're at the end of move history (not reviewing past moves)
   - Check it's actually the AI's turn (check "AI plays as: WHITE/BLACK")
   - Console logs will show why AI isn't moving

5. **Fresh start needed:**
   - Refresh the page completely (Ctrl+Shift+R or Cmd+Shift+R)
   - Clear browser cache if problems persist
   - Make sure you're using a modern browser (Chrome, Firefox, Safari, Edge)

### Debugging Steps

1. **Open Developer Console** (F12 or Right-click → Inspect → Console)
2. **Enable AI** (click the AI Opponent button)
3. **Make a move** (click a piece, then click where to move it)
4. **Watch console** - you should see:
   ```
   AI turn detected, requesting move...
   Requesting AI move...
   FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1
   Stockfish: uciok
   Stockfish: readyok
   Stockfish: bestmove e7e5
   Applying AI move: e7e5
   Found moving piece: PAWN at e7
   Applying legal ply: e5
   AI move applied successfully
   ```

If you don't see these messages, there's an initialization issue.
If you see error messages, they will indicate the specific problem.

## Future Enhancements

Potential improvements you could add:

- [ ] Opening book for faster/more varied openings
- [ ] Analysis mode showing best moves
- [ ] Move hints for human player
- [ ] Multiple AI difficulty presets
- [ ] Save/load AI games
- [ ] AI vs AI mode
- [ ] Endgame tablebase support
- [ ] Multi-PV (show multiple best moves)

## Credits

- **Stockfish** - Chess engine by Tord Romstad, Marco Costalba, Joona Kiiski
- **Stockfish.js** - JavaScript port from the Lichess project
- **UCI Protocol** - Universal Chess Interface standard

## License

This AI integration uses Stockfish.js, which is licensed under GPLv3.
Make sure your project is compatible with GPL licensing.

---

Enjoy playing against your new AI opponent! 🎮♟️
