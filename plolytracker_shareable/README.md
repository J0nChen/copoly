# PolyTracker

A live tracker for Polymarket user addresses, complete with live updates using a direct connection to Polygon's Mempool logs.

## Features
- Complete Dark Mode Glassmorphism UI
- Real-time Blockchain parsing (catch trades milliseconds after they mine)
- Active Postions tracker (with average cost precision & automatic share closures)
- Automatic Closed Position Sweeping via clock time
- Historical Replay modes for all historical trades, broken down by specific markets

## Installation & Setup

1. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Run the server**:
   ```bash
   python server.py
   ```

3. **Open Tracker**:
   Navigate to `http://localhost:8080/` in your web browser. Type in the Polygon address you wish to track.
