import express from 'express';
import cors from 'cors';
import path from 'path';
import ccxt from 'ccxt';
import axios from 'axios';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import fs from 'fs';
import { deltaClient } from './deltaClient';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- Simple Local State ---
let isBotRunning = false;
let apiAuthError: string | null = null;
let logs: Array<{ time: string; message: string; type: 'info' | 'error' | 'success' }> = [
  { time: new Date().toLocaleTimeString(), message: "System Initialized. Awaiting manual start.", type: 'info' }
];

const addLog = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
  const time = new Date().toLocaleTimeString();
  logs.unshift({ time, message, type });
  if (logs.length > 50) logs.pop(); // Keep only last 50
  console.log(`[${time}] ${message}`);
};

function formatDeltaError(error: any): string {
  const msg = error.message || JSON.stringify(error);
  if (msg.includes('ip_not_whitelisted_for_api_key')) {
    return `Delta Exchange MANDATES IP whitelisting. Alternative: Run locally or on a VPS with a static IP.`;
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid_api_key') || msg.includes('signature')) {
    return `Invalid Delta API Key/Secret or Signature: ${msg}`;
  }
  return msg;
}

// --- Product Mapping Cache ---
let productsCache: any[] = [];

async function syncProducts() {
  try {
    const resp = await deltaClient.getProducts();
    if (resp && resp.success && resp.result) {
      productsCache = resp.result;
      console.log(`[Products] Synced ${productsCache.length} products from Delta API.`);
    }
  } catch (e: any) {
    console.error("Failed to sync products:", e.message);
  }
}

function getProductId(symbol: string): number | null {
  // Try exact match like BTCUSD
  let prod = productsCache.find((p: any) => p.symbol === symbol);
  if (prod) return prod.id;
  // Try to find perp if symbol lacks it
  prod = productsCache.find((p: any) => p.symbol.startsWith(symbol) && p.contract_type === 'perpetual_futures');
  if (prod) return prod.id;
  return null;
}

async function placeDeltaMarketOrder(symbol: string, side: string, sizeInput: number, currentPrice?: number, extraParams: any = {}) {
  try {
    const productId = getProductId(symbol);
    if (!productId) {
      throw new Error(`Could not map symbol ${symbol} to a Delta Product ID. Please ensure the symbol is correct (e.g. BTCUSD).`);
    }

    let size = sizeInput;

    if (tradingConfig.allocationType === 'percent' && currentPrice && !extraParams.reduce_only) {
      const balancesResp = await deltaClient.getBalances();
      const assets = balancesResp.result || [];
      const usdAsset = assets.find((a: any) => a.asset_symbol === 'USD' || a.asset_symbol === 'USDT');
      const freeUsd = usdAsset ? parseFloat(usdAsset.available_balance) : 0;
      
      const leverage = Number(tradingConfig.leverage) || 1;
      const percent = Math.min(Math.max(sizeInput, 0), 100) / 100;
      const purchasingPower = freeUsd * leverage * percent;
      
      const prod = productsCache.find((p: any) => p.id === productId);
      const contractValue = prod ? parseFloat(prod.contract_value) : 1;
      
      const rawSize = purchasingPower / (currentPrice * contractValue);
      size = Math.floor(rawSize);
      
      if (size <= 0) {
        throw new Error(`Calculated size is 0 (Purchasing Power: $${purchasingPower.toFixed(2)}, Free USD: $${freeUsd.toFixed(2)}). Not enough margin.`);
      }
    } else if (tradingConfig.allocationType === 'usd' && currentPrice && !extraParams.reduce_only) {
      const leverage = Number(tradingConfig.leverage) || 1;
      const purchasingPower = sizeInput * leverage;
      
      const prod = productsCache.find((p: any) => p.id === productId);
      const contractValue = prod ? parseFloat(prod.contract_value) : 1;
      
      const rawSize = purchasingPower / (currentPrice * contractValue);
      size = Math.floor(rawSize);
      
      if (size <= 0) {
        throw new Error(`Calculated size is 0 (Requested Margin: $${sizeInput}, Purchasing Power: $${purchasingPower}).`);
      }
    }

    const orderSide = side.toLowerCase() as 'buy' | 'sell';
    // Strip out TP/SL bracket fields from the main order params — they go to a separate endpoint
    const { bracket_take_profit_price, bracket_take_profit_limit_price, bracket_stop_loss_price, bracket_stop_loss_limit_price, _limitPrice, ...cleanExtraParams } = extraParams;
    const params: any = { ...cleanExtraParams };
    
    const isLimit = tradingConfig.orderType === 'limit';
    const priceToUse = _limitPrice ? Number(_limitPrice) : currentPrice;
    
    if (isLimit && priceToUse) {
      params.limit_price = String(priceToUse);
    }
    
    const orderType = isLimit ? 'limit_order' : 'market_order';

    const result = await deltaClient.placeOrder(productId, size, orderSide, orderType, params);
    const placedOrder = result.result || result;

    // ── STEP: Place bracket (TP/SL) as a separate /v2/orders/bracket request ──
    // Only attach bracket if this is an entry order (not a reduce_only close)
    if (!extraParams.reduce_only && currentPrice) {
      const isBuy = orderSide === 'buy';
      
      const formatPrice = (val: number) => {
        if (val < 0.1) return val.toFixed(5);
        if (val < 1) return val.toFixed(4);
        if (val < 50) return val.toFixed(3);
        if (val < 1000) return val.toFixed(2);
        return val.toFixed(1);
      };

      const tpPct = tradingConfig.takeProfitPct ? parseFloat(tradingConfig.takeProfitPct) : NaN;
      const slPct = tradingConfig.stopLossPct ? parseFloat(tradingConfig.stopLossPct) : NaN;

      const hasTp = !isNaN(tpPct) && tpPct > 0;
      const hasSl = !isNaN(slPct) && slPct > 0;

      if ((hasTp || hasSl) && placedOrder?.id) {
        const bracketBody: any = {
          product_id: productId,
          product_symbol: symbol,
        };

        if (hasTp) {
          const tpPrice = isBuy
            ? currentPrice * (1 + tpPct / 100)
            : currentPrice * (1 - tpPct / 100);
          bracketBody.take_profit_order = {
            order_type: 'limit_order',
            stop_price: formatPrice(tpPrice),
            limit_price: formatPrice(tpPrice),
          };
        }

        if (hasSl) {
          const slPrice = isBuy
            ? currentPrice * (1 - slPct / 100)
            : currentPrice * (1 + slPct / 100);
          bracketBody.stop_loss_order = {
            order_type: 'limit_order',
            stop_price: formatPrice(slPrice),
            limit_price: formatPrice(slPrice),
          };
        }

        try {
          await deltaClient.placeBracketOrder(bracketBody);
          addLog(`🛡️ Bracket order (TP/SL) placed for order ${placedOrder.id}`, 'info');
        } catch (bracketErr: any) {
          addLog(`⚠️ Main order placed but bracket (TP/SL) failed: ${bracketErr.message}`, 'error');
        }
      }
    }

    return placedOrder;
  } catch (error: any) {
    throw new Error(`Delta API Error during trade execution: ${formatDeltaError(error)}`);
  }
}

// --- Diagnostic Ping ---
app.post('/api/ping', async (req, res) => {
  try {
    const [balancesResp, profileResp] = await Promise.all([
       deltaClient.getBalances(),
       deltaClient.getProfile(),
    ]);
    
    const assets = (balancesResp.result || []).map((a: any) => ({
        asset: a.asset_symbol,
        total: parseFloat(a.balance),
        free: parseFloat(a.available_balance)
    })).filter((a: any) => a.total > 0);

    return res.json({ 
       success: true, 
       assets, 
       profile: profileResp.result, 
       serverTime: Date.now(), // Delta has no /v2/settings; use local time
       localTime: Date.now() 
    });
  } catch (error: any) {
    return res.status(400).json({ 
      success: false, 
      message: formatDeltaError(error)
    });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const { symbol } = req.query;
    // Ensure products are cached so we can map product_id → symbol
    if (productsCache.length === 0) await syncProducts();
    const positionsResp = await deltaClient.getPositions();
    let positions = positionsResp.result || [];
    
    // Map product_id back to symbol for UI
    positions = positions.map((p: any) => {
       const prod = productsCache.find((prod: any) => prod.id === p.product_id);
       return {
          ...p,
          symbol: prod ? prod.symbol : p.product_id,
          contracts: p.size,
          side: p.size > 0 ? 'long' : 'short',
          entryPrice: p.entry_price,
          liquidationPrice: p.liquidation_price,
          info: { realized_pnl: p.realized_pnl }
       };
    });

    if (symbol) {
       positions = positions.filter((p: any) => p.symbol === symbol);
    }

    return res.json({ success: true, positions });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    if (msg.includes('unauthorized') || msg.includes('signature')) {
      return res.status(401).json({ success: false, message: msg });
    }
    return res.status(400).json({ success: false, message: msg });
  }
});

app.post('/api/close_position', async (req, res) => {
  try {
    const { symbol, side, size } = req.body;
    const productId = getProductId(symbol);
    if (!productId) throw new Error("Product ID not found for " + symbol);
    
    const closingSide = (side as string).toLowerCase() === 'buy' || (side as string).toLowerCase() === 'long' ? 'sell' : 'buy';
    
    const result = await deltaClient.placeOrder(productId, Math.abs(Number(size)), closingSide, 'market_order', { reduce_only: true });
    return res.json({ success: true, result });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    return res.status(400).json({ success: false, message: msg });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const balancesResp = await deltaClient.getBalances();
    const assets = (balancesResp.result || []).map((a: any) => ({
        asset: a.asset_symbol,
        total: parseFloat(a.balance),
        free: parseFloat(a.available_balance),
        // Delta API returns 'blocked_margin', not order_margin/position_margin
        used: parseFloat(a.blocked_margin || '0')
    })).filter((a: any) => a.total > 0);

    return res.json({ success: true, assets });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    if (msg.includes('unauthorized') || msg.includes('signature')) {
      return res.status(401).json({ success: false, message: msg });
    }
    return res.status(400).json({ success: false, message: msg });
  }
});

let cachedSyncedSymbols: string[] = [];
let cachedSyncedSymbolsTime: number = 0;

app.get('/api/symbols', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedSyncedSymbols.length > 0 && now - cachedSyncedSymbolsTime < 3600000) {
      return res.json({ success: true, symbols: cachedSyncedSymbols, cached: true });
    }

    if (productsCache.length === 0) await syncProducts();
    
    const validSymbols = productsCache
       .filter((p: any) => p.contract_type === 'perpetual_futures' && p.state === 'live')
       .map((p: any) => p.symbol)
       .sort();

    cachedSyncedSymbols = [...new Set(validSymbols)];
    cachedSyncedSymbolsTime = now;
    
    return res.json({ success: true, symbols: cachedSyncedSymbols });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: formatDeltaError(error) });
  }
});

// --- EMA and Bot Logic ---
let botInterval: NodeJS.Timeout | null = null;
let tradingConfig: any = { 
  symbol: 'BTCUSD', 
  timeframe: '15m', 
  fastEmaPeriod: 9, 
  slowEmaPeriod: 21, 
  size: 10,
  leverage: 10,
  allocationType: 'fixed',
  orderType: 'market',
  takeProfitPct: '',
  stopLossPct: '',
  strategy: 'always_in'
};
let lastExecutedCandleTime = 0;
const binanceUnsupportedSymbols = new Set<string>();

const calculateEmaSeries = (prices: number[], period: number) => {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
};

const runBotCycle = async () => {
  if (!isBotRunning) return;
  try {
    if (productsCache.length === 0) await syncProducts();
    
    const productId = getProductId(tradingConfig.symbol);
    if (!productId) {
      addLog(`Product ID not found for ${tradingConfig.symbol}. Cannot fetch candles.`, 'error');
      isBotRunning = false;
      return;
    }
    
    let ohlcv: any[] | undefined = undefined;
    // Convert Delta symbol (e.g. BTCUSD or BTCUSDT) to Binance format (BTC/USDT)
    // Handles: BTCUSD → BTC/USDT  |  BTCUSDT → BTC/USDT  (avoids BTC/USDTT bug)
    const binanceSymbol = tradingConfig.symbol.replace(/USDT$/, '/USDT').replace(/USD$/, '/USDT');
    
    if (!binanceUnsupportedSymbols.has(binanceSymbol)) {
      try {
        const binance = new ccxt.binance();
        const limit = Math.max(500, tradingConfig.slowEmaPeriod + 10);
        ohlcv = await binance.fetchOHLCV(binanceSymbol, tradingConfig.timeframe, undefined, limit);
      } catch (candleErr: any) {
        if (candleErr.message.toLowerCase().includes('does not have market symbol')) {
          binanceUnsupportedSymbols.add(binanceSymbol);
        }
        console.warn(`Binance Data Error: ${candleErr.message}.`);
      }
    }
    
    if (!ohlcv || ohlcv.length === 0) {
      addLog(`Failed to fetch candle info for ${tradingConfig.symbol}: Empty result`, 'error');
      return;
    }
    
    const closes = ohlcv.map((c) => c[4] as number);
    const required = tradingConfig.slowEmaPeriod + 5;
    
    if (closes.length < required) {
       addLog(`Not enough data to calculate EMA. Found ${closes.length} candles, require at least ${required}.`, 'error');
       return;
    }

    const fastEmaSeries = calculateEmaSeries(closes, tradingConfig.fastEmaPeriod);
    const slowEmaSeries = calculateEmaSeries(closes, tradingConfig.slowEmaPeriod);
    
    const currentClosedIdx = closes.length - 2;
    const previousClosedIdx = closes.length - 3;
    
    if (previousClosedIdx < 0) return;

    const currFast = fastEmaSeries[currentClosedIdx];
    const currSlow = slowEmaSeries[currentClosedIdx];
    const prevFast = fastEmaSeries[previousClosedIdx];
    const prevSlow = slowEmaSeries[previousClosedIdx];
    
    const closedCandleTime = ohlcv[currentClosedIdx][0];
    const currentPrice = closes[closes.length - 1]; // Live price
    const formatPrice = (p: number) => p < 0.1 ? p.toFixed(5) : p < 1 ? p.toFixed(4) : p < 100 ? p.toFixed(3) : p.toFixed(2);
    
    const isCrossUp = prevFast <= prevSlow && currFast > currSlow;
    const isCrossDown = prevFast >= prevSlow && currFast < currSlow;
    
    const crossStateStr = isCrossUp ? 'BUY' : isCrossDown ? 'SELL' : 'NONE';
    addLog(`Checked ${tradingConfig.symbol} - Price: ${formatPrice(currentPrice)} | Fast: ${formatPrice(currFast)} | Slow: ${formatPrice(currSlow)}`, 'info');

     if ((isCrossUp || isCrossDown) && closedCandleTime > lastExecutedCandleTime) {
        addLog(`🔔 EMA Cross Detected! Signal: ${crossStateStr}`, 'success');
        
        if (!tradingConfig.stopLossPct || parseFloat(tradingConfig.stopLossPct) <= 0) {
           addLog(`❌ Mandatory Stop Loss is missing! Configure Stop Loss (%) > 0. Bot stopped.`, 'error');
           isBotRunning = false;
           // FIX: also clear the interval so the timer does not keep firing
           if (botInterval) { clearInterval(botInterval); botInterval = null; }
           return;
        }

        const orderSide = isCrossUp ? 'buy' : 'sell';
        let targetSize = Number(tradingConfig.size || 1);
        const isAlwaysIn = tradingConfig.strategy === 'always_in';

        // ── STEP 1: Check existing position ──
        let currentContracts = 0;
        let posSide: string | undefined;
        try {
            const positionsResp = await deltaClient.getPositions();
            const positions = positionsResp.result || [];
            const pos = positions.find((p: any) => p.product_id === productId);
            if (pos && pos.size !== 0) {
                currentContracts = Math.abs(Number(pos.size));
                posSide = Number(pos.size) > 0 ? 'buy' : 'sell';
            }
            addLog(`📊 Position check: ${currentContracts > 0 ? `Holding ${posSide?.toUpperCase()} x${currentContracts}` : 'No open position'}`, 'info');
        } catch (posErr: any) {
            addLog(`⚠️ Could not fetch positions: ${posErr.message}. Will attempt trade anyway.`, 'error');
        }

        // ── STEP 2: If holding same direction, skip ──
        if (currentContracts > 0) {
            const isHoldingLong = posSide === 'buy';
            const isHoldingShort = posSide === 'sell';
            const isSameDirection = (isHoldingLong && orderSide === 'buy') || (isHoldingShort && orderSide === 'sell');

            if (isSameDirection) {
                addLog(`⏭️ Ignored ${crossStateStr} signal — already holding ${posSide?.toUpperCase()}.`, 'info');
                lastExecutedCandleTime = closedCandleTime;
                return;
            }

            // ── STEP 3: Close opposite position ──
            const closingSide = isHoldingLong ? 'sell' : 'buy';
            addLog(`🔄 Closing existing ${posSide?.toUpperCase()} position (${currentContracts} contracts)...`, 'info');
            try {
                await placeDeltaMarketOrder(tradingConfig.symbol, closingSide, currentContracts, currentPrice, { reduce_only: true });
                addLog(`✅ Closed ${posSide?.toUpperCase()} position successfully.`, 'success');
            } catch (closeErr: any) {
                addLog(`❌ Failed to close ${posSide?.toUpperCase()} position: ${closeErr.message}`, 'error');
                return;
            }

            if (!isAlwaysIn) {
                addLog(`📋 Strategy: Standard — closed position, NOT entering new ${orderSide.toUpperCase()}.`, 'info');
                lastExecutedCandleTime = closedCandleTime;
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        // ── STEP 4: Enter new position ──
        addLog(`🚀 Entering NEW ${orderSide.toUpperCase()} position...`, 'info');
        try {
            const result = await placeDeltaMarketOrder(tradingConfig.symbol, orderSide, targetSize, currentPrice);
            addLog(`✅ ${orderSide.toUpperCase()} entry placed! Order ID: ${result?.id || 'OK'}`, 'success');
            lastExecutedCandleTime = closedCandleTime;
        } catch (entryErr: any) {
            addLog(`❌ Failed to enter ${orderSide.toUpperCase()}: ${entryErr.message}`, 'error');
            if (entryErr.message.includes('signature') || entryErr.message.includes('401')) {
                isBotRunning = false;
                apiAuthError = "Invalid Delta API Credentials or Signature.";
                addLog('Bot stopped due to API authentication failure.', 'error');
            }
        }
    }
  } catch (error: any) {
    addLog(`Error in bot cycle: ${error.message}`, 'error');
  }
};

// --- API Routes ---
app.get('/api/status', (req, res) => {
  res.json({ isBotRunning, apiAuthError, logs, tradingConfig, hasKeys: !!(process.env.DELTA_KEY && process.env.DELTA_SECRET) });
});

app.post('/api/credentials', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ success: false, message: 'Missing API Key or Secret' });
  }
  process.env.DELTA_KEY = apiKey;
  process.env.DELTA_SECRET = apiSecret;
  
  try {
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    if (envContent.includes('DELTA_KEY=')) {
      envContent = envContent.replace(/DELTA_KEY=.*/, `DELTA_KEY=${apiKey}`);
    } else {
      envContent += `\nDELTA_KEY=${apiKey}`;
    }
    if (envContent.includes('DELTA_SECRET=')) {
      envContent = envContent.replace(/DELTA_SECRET=.*/, `DELTA_SECRET=${apiSecret}`);
    } else {
      envContent += `\nDELTA_SECRET=${apiSecret}`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n');
    
    apiAuthError = null;
    addLog("API Credentials updated and saved successfully", "success");
    res.json({ success: true, message: 'Credentials updated successfully' });
  } catch (err: any) {
    addLog(`Failed to save API credentials: ${err.message}`, "error");
    res.status(500).json({ success: false, message: 'Failed to save credentials' });
  }
});

app.post('/api/clear-memory', (req, res) => {
  logs = [{ time: new Date().toLocaleTimeString(), message: "Memory cleared. Caches reset.", type: 'info' }];
  lastExecutedCandleTime = 0;
  binanceUnsupportedSymbols.clear();
  cachedSyncedSymbols = [];
  cachedSyncedSymbolsTime = 0;
  apiAuthError = null;
  isBotRunning = false;
  if (botInterval) clearInterval(botInterval);
  
  addLog("System memory and caches have been cleared.", "success");
  res.json({ success: true, message: 'Memory cleared' });
});

app.post('/api/config', (req, res) => {
  const { symbol, timeframe, fastEmaPeriod, slowEmaPeriod, size, leverage, allocationType, orderType, takeProfitPct, stopLossPct, strategy } = req.body;
  
  if (symbol) tradingConfig.symbol = symbol;
  if (timeframe) tradingConfig.timeframe = timeframe;
  if (fastEmaPeriod !== undefined) tradingConfig.fastEmaPeriod = parseInt(fastEmaPeriod, 10);
  if (slowEmaPeriod !== undefined) tradingConfig.slowEmaPeriod = parseInt(slowEmaPeriod, 10);
  if (size !== undefined) tradingConfig.size = size;
  if (leverage !== undefined) tradingConfig.leverage = leverage;
  if (allocationType !== undefined) tradingConfig.allocationType = allocationType;
  if (orderType !== undefined) tradingConfig.orderType = orderType;
  if (takeProfitPct !== undefined) tradingConfig.takeProfitPct = takeProfitPct;
  if (stopLossPct !== undefined) tradingConfig.stopLossPct = stopLossPct;
  if (strategy !== undefined) tradingConfig.strategy = strategy;

  lastExecutedCandleTime = 0;
  addLog(`Configuration updated: ${tradingConfig.symbol} (${tradingConfig.timeframe}) Size: ${tradingConfig.size}`, 'info');
  res.json({ success: true, tradingConfig });
});

app.post('/api/start', async (req, res) => {
  if (isBotRunning) {
    return res.status(400).json({ message: "Bot is already running" });
  }
  
  if (!process.env.DELTA_KEY || !process.env.DELTA_SECRET) {
    apiAuthError = "Missing Delta Exchange credentials";
    addLog("Failed to start: Missing Delta Exchange credentials", "error");
    return res.status(400).json({ message: "Missing credentials" });
  }

  isBotRunning = true;
  apiAuthError = null;
  addLog("🤖 Delta Native Engine Started. Waiting for signals...", "success");
  
  await syncProducts();
  runBotCycle();
  botInterval = setInterval(runBotCycle, 30000);
  
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  isBotRunning = false;
  if (botInterval) clearInterval(botInterval);
  addLog("Bot stopped manually.", "info");
  res.json({ success: true });
});

app.post('/api/manual-trade', async (req, res) => {
  const { symbol, side, size, limitPrice } = req.body;
  addLog(`Manual trade requested: ${side} ${symbol} (Size: ${size})...`, "info");

  if (!tradingConfig.stopLossPct || parseFloat(tradingConfig.stopLossPct) <= 0) {
     const errorMsg = "Mandatory Stop Loss is missing! Please configure Stop Loss (%) first.";
     addLog(`➔ Error: ${errorMsg}`, "error");
     return res.status(400).json({ success: false, message: errorMsg });
  }
  
  try {
    if (productsCache.length === 0) await syncProducts();
    
    // We pass the limitPrice from the UI inside extraParams
    const extraParams = limitPrice ? { _limitPrice: limitPrice } : {};
    
    // Fallback current price using Binance to assist with TP/SL calculations on manual trades
    let currentPrice: number | undefined = undefined;
    try {
      // Convert Delta symbol (e.g. BTCUSD or BTCUSDT) to Binance format (BTC/USDT)
      // Handles: BTCUSD → BTC/USDT  |  BTCUSDT → BTC/USDT  (avoids BTC/USDTT bug)
      const binanceSymbol = symbol.replace(/USDT$/, '/USDT').replace(/USD$/, '/USDT');
      const binance = new ccxt.binance();
      const ticker = await binance.fetchTicker(binanceSymbol);
      if (ticker.last) currentPrice = ticker.last;
    } catch (e: any) {
      console.warn("Could not fetch current price for manual trade TP/SL.");
    }
    
    const result = await placeDeltaMarketOrder(symbol, side, size || 1, currentPrice, extraParams);
    addLog(`➔ Order Placed! ID: ${result?.id || 'Success'}`, "success");
    res.json({ success: true, result });
  } catch (error: any) {
    addLog(`➔ Error: ${error.message}`, "error");
    res.status(500).json({ success: false, error: error.message });
  }
});

// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
