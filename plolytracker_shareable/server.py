import asyncio
import aiohttp
import json
import websockets
from aiohttp import web
from datetime import datetime
import os

ALCHEMY_WSS = "wss://polygon-bor-rpc.publicnode.com"
TRANSFER_SINGLE_SIG = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"

market_cache = {}
active_connections = set()
current_target = None
current_pad_target = None
trade_history = []

async def fetch_trade_details(tx_hash, token_id_int, act, sh, t_str):
    global current_target
    if not current_target:
        return
        
    url = f"https://data-api.polymarket.com/activity?user={current_target}&limit=20"
    
    async with aiohttp.ClientSession() as session:
        for _ in range(20):
            try:
                async with session.get(url, timeout=5) as response:
                    if response.status == 200:
                        data = await response.json()
                        for trade in data:
                            if trade.get('transactionHash', '').lower() == tx_hash.lower():
                                title = trade.get('title', 'Unknown Market')
                                outcome = trade.get('outcome', 'Unknown')
                                if not outcome or outcome == "":
                                    if token_id_int in market_cache:
                                        outcome = market_cache[token_id_int][1]
                                    else:
                                        outcome = "Winning Outcome"
                                    
                                price = float(trade.get('price', 0.0))
                                
                                if price <= 0.0:
                                    usdc = float(trade.get('usdcSize', 0.0))
                                    sz = float(trade.get('size', 1.0))
                                    if sz > 0:
                                        price = usdc / sz
                                        
                                if trade.get('type') == 'REDEEM':
                                    act = "REDEEM"
                                elif trade.get('type') == 'MERGE':
                                    act = "MERGE"
                                elif trade.get('type') == 'SPLIT':
                                    act = "SPLIT"
                                
                                if act == "REDEEM":
                                    return
                                
                                market_cache[token_id_int] = (title, outcome)
                                
                                result = {
                                    "type": "trade",
                                    "time": t_str,
                                    "action": act,
                                    "shares": sh,
                                    "market": title,
                                    "outcome": outcome,
                                    "price": price,
                                    "tx_hash": tx_hash,
                                    "resolved": True
                                }
                                trade_history.append(result)
                                await broadcast(result)
                                return
            except Exception:
                pass
            await asyncio.sleep(1.0)
            
    # Fallback
    title, outcome = market_cache.get(token_id_int, ("Unknown Market", "Unknown"))
    result = {
        "type": "trade",
        "time": t_str,
        "action": act,
        "shares": sh,
        "market": title,
        "outcome": outcome,
        "price": 0.0,
        "tx_hash": tx_hash,
        "resolved": False
    }
    trade_history.append(result)
    await broadcast(result)

async def broadcast(data):
    if not active_connections:
        return
    msg = json.dumps(data)
    to_remove = set()
    for ws in active_connections:
        try:
            await ws.send_str(msg)
        except Exception:
            to_remove.add(ws)
    for ws in to_remove:
        active_connections.remove(ws)

async def polygon_tracker():
    global current_pad_target
    while True:
        try:
            async with websockets.connect(ALCHEMY_WSS, ping_interval=None) as ws:
                subscribe_msg = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_subscribe",
                    "params": ["logs", {
                        "address": "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
                        "topics": [TRANSFER_SINGLE_SIG]
                    }]
                }
                await ws.send(json.dumps(subscribe_msg))
                await ws.recv() # Wait for response
                
                print("Connected to Polygon")
                
                while True:
                    msg = await ws.recv()
                    # print("Received a WS message.")
                    if not current_pad_target:
                        continue
                        
                    data = json.loads(msg)
                    if "params" in data and "result" in data["params"]:
                        log = data["params"]["result"]
                        topics = log.get("topics", [])
                        
                        if len(topics) >= 4:
                            tx_hash = log.get("transactionHash")
                            print(f"DEBUG: Parsed transfer {tx_hash}")
                            from_addr = topics[2].lower()
                            to_addr = topics[3].lower()
                            
                            if from_addr == current_pad_target or to_addr == current_pad_target:
                                tx_hash = log.get("transactionHash")
                                action = "BUY" if to_addr == current_pad_target else "SELL"
                                raw_data = log.get("data", "")[2:]
                                if len(raw_data) >= 128:
                                    token_id_hex = raw_data[:64]
                                    value_hex = raw_data[64:128]
                                    token_id = int(token_id_hex, 16)
                                    shares = int(value_hex, 16) / 1e6
                                    
                                    if shares < 1:
                                        continue
                                        
                                    time_str = datetime.now().strftime('%H:%M:%S')
                                    print(f"Caught trade: {action} txn={tx_hash}")
                                    asyncio.create_task(fetch_trade_details(tx_hash, token_id, action, shares, time_str))
        except Exception as e:
            print(f"WS error: {e}")
            await asyncio.sleep(3)

async def websocket_handler(request):
    global current_target, current_pad_target
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    active_connections.add(ws)
    print("UI connected")
    
    if current_target:
        await ws.send_str(json.dumps({"type": "info", "message": f"Currently tracking: {current_target}", "target": current_target}))
        for past_trade in trade_history:
            await ws.send_str(json.dumps(past_trade))
    
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("action") == "set_target":
                    target = data.get("address", "").strip().lower()
                    if target.startswith("0x") and len(target) == 42:
                        current_target = target
                        current_pad_target = "0x000000000000000000000000" + target[2:]
                        trade_history.clear()
                        print(f"New target set: {target}")
                        await broadcast({"type": "info", "message": f"Started tracking {target}", "target": target})
                        await broadcast({"type": "clear"})
                    else:
                        await ws.send_str(json.dumps({"type": "error", "message": "Invalid address format"}))
    except Exception as e:
        print(f"Error handling ws: {e}")
    finally:
        active_connections.discard(ws)
        print("UI disconnected")
    return ws

async def init_app():
    app = web.Application()
    
    # Route for WebSocket
    app.router.add_get('/ws', websocket_handler)
    
    static_path = os.path.join(os.path.dirname(__file__), 'static')
    
    # Index fallback
    async def index(request):
        return web.FileResponse(os.path.join(static_path, 'index.html'))
        
    app.router.add_get('/', index)
    
    # Route for static files
    app.router.add_static('/', path=static_path, name='static')
    
    # Start tracker in background
    asyncio.create_task(polygon_tracker())
    
    return app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    web.run_app(init_app(), port=port)
