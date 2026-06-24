import express from 'express';
import cors from 'cors';
import path from 'path';
import ccxt from 'ccxt';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import fs from 'fs';
import { deltaClient } from './deltaClient';

dotenv.config();

const app = express();
const PORT = 3000;

// ══════════════════════════════════════════════════════════════════
// GLOBAL BINANCE INSTANCE — reused across all cycles to avoid rate limiting
// ══════════════════════════════════════════════════════════════════
const binance = new ccxt.binance({ enableRateLimit: true });

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════════════════════════════
let logs: Array<{ time: string; message: string; type: 'info' | 'error' | 'success' }> = [
  { time: new Date().toLocaleTimeString(), message: "System Initialized. Awaiting manual start.", type: 'info' }
];

const addLog = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
  const time = new Date().toLocaleTimeString();
  logs.unshift({ time, message, type });
  if (logs.length > 100) logs.pop();
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

// ══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ══════════════════════════════════════════════════════════════════
let isBotRunning = false;
let apiAuthError: string | null = null;

// ══════════════════════════════════════════════════════════════════
// PRODUCT MAPPING CACHE
// ══════════════════════════════════════════════════════════════════
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
  let prod = productsCache.find((p: any) => p.symbol === symbol);
  if (prod) return prod.id;
  prod = productsCache.find((p: any) => p.symbol.startsWith(symbol) && p.contract_type === 'perpetual_futures');
  if (prod) return prod.id;
  return null;
}

// ══════════════════════════════════════════════════════════════════
// MULTI-SLOT TRADING ENGINE
// ══════════════════════════════════════════════════════════════════

interface TradingSlot {
  id: string;
  symbol: string;
  timeframe: string;
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  size: number;
  leverage: number;
  allocationType: 'fixed' | 'percent' | 'usd';
  orderType: 'market' | 'limit';
  takeProfitPct: number;
  stopLossPct: number;
  strategy: 'always_in' | 'standard';
  lastExecutedCandleTime: number;
  lastSignal: string; // 'BUY' | 'SELL' | 'NONE'
  // --- New filter fields ---
  useRsiFilter: boolean;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  useVolumeFilter: boolean;
  cooldownCandles: number;
  lastTradeCandles: number; // tracks candles since last trade for cooldown
  tradesExecuted: number;   // counter for display
  leverageSet: boolean;     // tracks if leverage was set on Delta
}

const activeSlots = new Map<string, TradingSlot>();
let botInterval: NodeJS.Timeout | null = null;
const binanceUnsupportedSymbols = new Set<string>();

// Default config for the UI form (NOT used for trading — slots are used)
let formConfig: any = {
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

function generateSlotId(config: { symbol: string; timeframe: string; fastEmaPeriod: number; slowEmaPeriod: number }): string {
  return `${config.symbol}_${config.timeframe}_${config.fastEmaPeriod}_${config.slowEmaPeriod}`;
}

// ══════════════════════════════════════════════════════════════════
// ORDER EXECUTION HELPER
// ══════════════════════════════════════════════════════════════════

async function placeDeltaMarketOrder(
  symbol: string,
  side: string,
  sizeInput: number,
  currentPrice: number | undefined,
  slot: TradingSlot,
  extraParams: any = {}
) {
  try {
    const productId = getProductId(symbol);
    if (!productId) {
      throw new Error(`Could not map symbol ${symbol} to a Delta Product ID.`);
    }

    let size = sizeInput;

    if (slot.allocationType === 'percent' && currentPrice && !extraParams.reduce_only) {
      const balancesResp = await deltaClient.getBalances();
      const assets = balancesResp.result || [];
      const usdAsset = assets.find((a: any) => a.asset_symbol === 'USD' || a.asset_symbol === 'USDT');
      const freeUsd = usdAsset ? parseFloat(usdAsset.available_balance) : 0;

      const leverage = Number(slot.leverage) || 1;
      const percent = Math.min(Math.max(sizeInput, 0), 100) / 100;
      const purchasingPower = freeUsd * leverage * percent;

      const prod = productsCache.find((p: any) => p.id === productId);
      const contractValue = prod ? parseFloat(prod.contract_value) : 1;

      const rawSize = purchasingPower / (currentPrice * contractValue);
      size = Math.floor(rawSize);

      if (size <= 0) {
        throw new Error(`Calculated size is 0 (Purchasing Power: $${purchasingPower.toFixed(2)}, Free USD: $${freeUsd.toFixed(2)}). Not enough margin.`);
      }
    } else if (slot.allocationType === 'usd' && currentPrice && !extraParams.reduce_only) {
      const leverage = Number(slot.leverage) || 1;
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
    const { bracket_take_profit_price, bracket_take_profit_limit_price, bracket_stop_loss_price, bracket_stop_loss_limit_price, _limitPrice, ...cleanExtraParams } = extraParams;
    const params: any = { ...cleanExtraParams };

    const isLimit = slot.orderType === 'limit';
    const priceToUse = _limitPrice ? Number(_limitPrice) : currentPrice;

    if (isLimit && priceToUse) {
      params.limit_price = String(priceToUse);
    }

    const orderType = isLimit ? 'limit_order' : 'market_order';

    const result = await deltaClient.placeOrder(productId, size, orderSide, orderType, params);
    const placedOrder = result.result || result;

    // Place bracket (TP/SL) if configured and this is an entry order
    if (!extraParams.reduce_only && currentPrice) {
      const isBuy = orderSide === 'buy';

      const formatPrice = (val: number) => {
        if (val < 0.1) return val.toFixed(5);
        if (val < 1) return val.toFixed(4);
        if (val < 50) return val.toFixed(3);
        if (val < 1000) return val.toFixed(2);
        return val.toFixed(1);
      };

      const tpPct = slot.takeProfitPct ? parseFloat(String(slot.takeProfitPct)) : NaN;
      const slPct = slot.stopLossPct ? parseFloat(String(slot.stopLossPct)) : NaN;

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
          addLog(`🛡️ [${symbol}] Bracket order (TP/SL) placed for order ${placedOrder.id}`, 'info');
        } catch (bracketErr: any) {
          addLog(`⚠️ [${symbol}] Main order placed but bracket (TP/SL) failed: ${bracketErr.message}`, 'error');
        }
      }
    }

    return placedOrder;
  } catch (error: any) {
    throw new Error(`Delta API Error during trade execution: ${formatDeltaError(error)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// EMA CALCULATION
// ══════════════════════════════════════════════════════════════════

const calculateEmaSeries = (prices: number[], period: number) => {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
};

// ══════════════════════════════════════════════════════════════════
// RSI CALCULATION
// ══════════════════════════════════════════════════════════════════

function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral if not enough data

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth using Wilder's method for remaining data
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ══════════════════════════════════════════════════════════════════
// VOLUME FILTER
// ══════════════════════════════════════════════════════════════════

function isVolumeAboveAverage(ohlcv: any[], lookback: number = 20): boolean {
  if (ohlcv.length < lookback + 2) return true; // not enough data, allow trade
  const closedIdx = ohlcv.length - 2; // last closed candle
  const currentVolume = ohlcv[closedIdx][5] as number;

  let totalVolume = 0;
  for (let i = closedIdx - lookback; i < closedIdx; i++) {
    totalVolume += ohlcv[i][5] as number;
  }
  const avgVolume = totalVolume / lookback;
  return currentVolume >= avgVolume;
}

// ══════════════════════════════════════════════════════════════════
// TIMEFRAME HELPERS
// ══════════════════════════════════════════════════════════════════

function getTimeframeSeconds(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400
  };
  return map[tf] || 900;
}

function getAdaptiveInterval(): number {
  if (activeSlots.size === 0) return 30000;
  let shortest = Infinity;
  for (const slot of activeSlots.values()) {
    const secs = getTimeframeSeconds(slot.timeframe);
    if (secs < shortest) shortest = secs;
  }
  // Poll every 1/3 of the shortest timeframe, minimum 10s, maximum 60s
  return Math.max(10000, Math.min(60000, Math.floor((shortest * 1000) / 3)));
}

// ══════════════════════════════════════════════════════════════════
// BOT CYCLE — runs once for ALL active slots
// ══════════════════════════════════════════════════════════════════

const runBotCycle = async () => {
  if (!isBotRunning) return;
  if (activeSlots.size === 0) return;

  try {
    if (productsCache.length === 0) await syncProducts();
  } catch (e: any) {
    addLog(`Failed to sync products: ${e.message}`, 'error');
    return;
  }

  // Process each slot independently
  for (const [slotId, slot] of activeSlots) {
    if (!isBotRunning) break; // stop if bot was stopped mid-cycle

    try {
      await runSlotCycle(slot);
    } catch (err: any) {
      addLog(`[${slot.symbol}] Error in slot cycle: ${err.message}`, 'error');
    }
  }
};

async function runSlotCycle(slot: TradingSlot) {
  const productId = getProductId(slot.symbol);
  if (!productId) {
    addLog(`[${slot.symbol}] Product ID not found. Skipping.`, 'error');
    return;
  }

  // ── Fetch candles from Binance (reusing global instance) ──
  let ohlcv: any[] | undefined = undefined;
  // Better symbol conversion: strip trailing USD/USDT and form Binance pair
  const baseCoin = slot.symbol.replace(/USDT$/, '').replace(/USD$/, '');
  const binanceSymbol = `${baseCoin}/USDT`;

  if (!binanceUnsupportedSymbols.has(binanceSymbol)) {
    try {
      const limit = Math.max(500, Math.max(slot.slowEmaPeriod, slot.rsiPeriod || 14) + 20);
      ohlcv = await binance.fetchOHLCV(binanceSymbol, slot.timeframe, undefined, limit);
    } catch (candleErr: any) {
      if (candleErr.message.toLowerCase().includes('does not have market symbol') ||
        candleErr.message.toLowerCase().includes('is not supported')) {
        binanceUnsupportedSymbols.add(binanceSymbol);
        addLog(`[${slot.symbol}] Symbol "${binanceSymbol}" not available on Binance. This slot will be skipped.`, 'error');
      } else {
        addLog(`[${slot.symbol}] Binance fetch error (may be transient): ${candleErr.message}`, 'error');
      }
    }
  }

  if (!ohlcv || ohlcv.length === 0) {
    addLog(`[${slot.symbol}] Failed to fetch candle data.`, 'error');
    return;
  }

  // ── Calculate EMAs ──
  const closes = ohlcv.map((c) => c[4] as number);
  const required = slot.slowEmaPeriod + 5;

  if (closes.length < required) {
    addLog(`[${slot.symbol}] Not enough candles. Have ${closes.length}, need ${required}.`, 'error');
    return;
  }

  const fastEmaSeries = calculateEmaSeries(closes, slot.fastEmaPeriod);
  const slowEmaSeries = calculateEmaSeries(closes, slot.slowEmaPeriod);

  // Use the LAST CLOSED candle (index -2) and the one before it (index -3)
  const currentClosedIdx = closes.length - 2;
  const previousClosedIdx = closes.length - 3;

  if (previousClosedIdx < 0) return;

  const currFast = fastEmaSeries[currentClosedIdx];
  const currSlow = slowEmaSeries[currentClosedIdx];
  const prevFast = fastEmaSeries[previousClosedIdx];
  const prevSlow = slowEmaSeries[previousClosedIdx];

  const closedCandleTime = ohlcv[currentClosedIdx][0];
  const currentPrice = closes[closes.length - 1]; // Live price from current candle
  const formatPrice = (p: number) => p < 0.1 ? p.toFixed(5) : p < 1 ? p.toFixed(4) : p < 100 ? p.toFixed(3) : p.toFixed(2);

  // ── Detect EMA crossover ──
  const isCrossUp = prevFast <= prevSlow && currFast > currSlow;
  const isCrossDown = prevFast >= prevSlow && currFast < currSlow;

  const crossStateStr = isCrossUp ? 'BUY' : isCrossDown ? 'SELL' : 'NONE';
  const emaGapPct = Math.abs(currFast - currSlow) / currSlow * 100;

  // ── Calculate RSI for logging and filtering ──
  const rsiValue = calculateRSI(closes, slot.rsiPeriod || 14);

  addLog(`[${slot.symbol}] Price: ${formatPrice(currentPrice)} | Fast(${slot.fastEmaPeriod}): ${formatPrice(currFast)} | Slow(${slot.slowEmaPeriod}): ${formatPrice(currSlow)} | Gap: ${emaGapPct.toFixed(3)}% | RSI(${slot.rsiPeriod || 14}): ${rsiValue.toFixed(1)}`, 'info');

  // ── Only act on NEW crossovers (not already processed) ──
  if (!(isCrossUp || isCrossDown)) return;
  if (closedCandleTime <= slot.lastExecutedCandleTime) return;

  addLog(`🔔 [${slot.symbol}] EMA Cross Detected! Signal: ${crossStateStr} | Strength: ${emaGapPct.toFixed(3)}%`, 'success');

  // ── RSI FILTER — reject signals at extremes ──
  if (slot.useRsiFilter) {
    if (isCrossUp && rsiValue >= slot.rsiOverbought) {
      addLog(`⏭️ [${slot.symbol}] RSI filter: BUY rejected — RSI ${rsiValue.toFixed(1)} >= ${slot.rsiOverbought} (overbought)`, 'info');
      slot.lastExecutedCandleTime = closedCandleTime;
      slot.lastSignal = crossStateStr;
      return;
    }
    if (isCrossDown && rsiValue <= slot.rsiOversold) {
      addLog(`⏭️ [${slot.symbol}] RSI filter: SELL rejected — RSI ${rsiValue.toFixed(1)} <= ${slot.rsiOversold} (oversold)`, 'info');
      slot.lastExecutedCandleTime = closedCandleTime;
      slot.lastSignal = crossStateStr;
      return;
    }
  }

  // ── VOLUME FILTER — reject low-volume crossovers ──
  if (slot.useVolumeFilter && !isVolumeAboveAverage(ohlcv)) {
    addLog(`⏭️ [${slot.symbol}] Volume filter: Signal rejected — volume below 20-candle average (likely fakeout)`, 'info');
    slot.lastExecutedCandleTime = closedCandleTime;
    slot.lastSignal = crossStateStr;
    return;
  }

  // ── COOLDOWN FILTER — prevent whipsaw ──
  if (slot.cooldownCandles > 0 && slot.lastTradeCandles > 0) {
    const candlesSinceLast = Math.floor((closedCandleTime - slot.lastTradeCandles) / (getTimeframeSeconds(slot.timeframe) * 1000));
    if (candlesSinceLast < slot.cooldownCandles) {
      addLog(`⏭️ [${slot.symbol}] Cooldown: Only ${candlesSinceLast}/${slot.cooldownCandles} candles since last trade. Skipping.`, 'info');
      slot.lastExecutedCandleTime = closedCandleTime;
      slot.lastSignal = crossStateStr;
      return;
    }
  }

  const orderSide = isCrossUp ? 'buy' : 'sell';
  let targetSize = slot.size || 1;

  // ── STEP 1: Check existing position for THIS symbol ──
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
    addLog(`📊 [${slot.symbol}] Position: ${currentContracts > 0 ? `Holding ${posSide?.toUpperCase()} x${currentContracts}` : 'Flat (no position)'}`, 'info');
  } catch (posErr: any) {
    addLog(`⚠️ [${slot.symbol}] Could not fetch positions: ${posErr.message}. Will attempt trade anyway.`, 'error');
  }

  // ── STEP 2: If already holding same direction → skip ──
  if (currentContracts > 0 && posSide === orderSide) {
    addLog(`⏭️ [${slot.symbol}] Ignored ${crossStateStr} — already holding ${posSide?.toUpperCase()}.`, 'info');
    slot.lastExecutedCandleTime = closedCandleTime;
    slot.lastSignal = crossStateStr;
    return;
  }

  // ── STEP 3: If holding opposite direction → close it ──
  if (currentContracts > 0 && posSide && posSide !== orderSide) {
    const closingSide = posSide === 'buy' ? 'sell' : 'buy';
    addLog(`🔄 [${slot.symbol}] Closing ${posSide.toUpperCase()} position (${currentContracts} contracts)...`, 'info');
    try {
      await placeDeltaMarketOrder(slot.symbol, closingSide, currentContracts, currentPrice, slot, { reduce_only: true });
      addLog(`✅ [${slot.symbol}] Closed ${posSide.toUpperCase()} position.`, 'success');
    } catch (closeErr: any) {
      addLog(`❌ [${slot.symbol}] Failed to close position: ${closeErr.message}`, 'error');
      // BUG FIX: Do NOT set lastExecutedCandleTime on failure — allow retry next cycle
      return;
    }

    // If strategy is "standard" (close only), don't enter new position
    if (slot.strategy !== 'always_in') {
      addLog(`📋 [${slot.symbol}] Strategy: Standard — closed position, NOT entering new ${orderSide.toUpperCase()}.`, 'info');
      slot.lastExecutedCandleTime = closedCandleTime;
      slot.lastSignal = crossStateStr;
      slot.lastTradeCandles = closedCandleTime;
      slot.tradesExecuted++;
      return;
    }

    // Small delay between close and new entry
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  // ── STEP 3.5: Set leverage on Delta before entry (Bug 4 fix) ──
  if (!slot.leverageSet && slot.leverage > 0) {
    try {
      await deltaClient.setLeverage(productId, slot.leverage);
      slot.leverageSet = true;
      addLog(`⚙️ [${slot.symbol}] Leverage set to ${slot.leverage}x on Delta`, 'info');
    } catch (levErr: any) {
      addLog(`⚠️ [${slot.symbol}] Could not set leverage (using default): ${levErr.message}`, 'error');
    }
  }

  // ── STEP 4: Enter new position ──
  addLog(`🚀 [${slot.symbol}] Entering ${orderSide.toUpperCase()} position (size: ${targetSize})...`, 'info');
  try {
    const result = await placeDeltaMarketOrder(slot.symbol, orderSide, targetSize, currentPrice, slot);
    addLog(`✅ [${slot.symbol}] ${orderSide.toUpperCase()} entry placed! Order ID: ${result?.id || 'OK'}`, 'success');
    // BUG FIX: Only set lastExecutedCandleTime on SUCCESS
    slot.lastExecutedCandleTime = closedCandleTime;
    slot.lastSignal = crossStateStr;
    slot.lastTradeCandles = closedCandleTime;
    slot.tradesExecuted++;
  } catch (entryErr: any) {
    addLog(`❌ [${slot.symbol}] Failed to enter ${orderSide.toUpperCase()}: ${entryErr.message}`, 'error');
    // BUG FIX: Do NOT set lastExecutedCandleTime — allow retry next cycle
    if (entryErr.message.includes('signature') || entryErr.message.includes('401')) {
      isBotRunning = false;
      apiAuthError = "Invalid Delta API Credentials or Signature.";
      addLog('Bot stopped due to API authentication failure.', 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// API ROUTES — Diagnostic & Account
// ══════════════════════════════════════════════════════════════════

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
      serverTime: Date.now(),
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
    if (productsCache.length === 0) await syncProducts();
    const positionsResp = await deltaClient.getPositions();
    let positions = positionsResp.result || [];

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

// ══════════════════════════════════════════════════════════════════
// API ROUTES — Status, Credentials, Config
// ══════════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  res.json({
    isBotRunning,
    apiAuthError,
    logs,
    formConfig,
    slots: Array.from(activeSlots.values()),
    hasKeys: !!(process.env.DELTA_KEY && process.env.DELTA_SECRET)
  });
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

// Form config endpoint — only updates the UI form state, does NOT affect running slots
app.post('/api/config', (req, res) => {
  const { symbol, timeframe, fastEmaPeriod, slowEmaPeriod, size, leverage, allocationType, orderType, takeProfitPct, stopLossPct, strategy } = req.body;

  if (symbol) formConfig.symbol = symbol;
  if (timeframe) formConfig.timeframe = timeframe;
  if (fastEmaPeriod !== undefined) formConfig.fastEmaPeriod = parseInt(fastEmaPeriod, 10);
  if (slowEmaPeriod !== undefined) formConfig.slowEmaPeriod = parseInt(slowEmaPeriod, 10);
  if (size !== undefined) formConfig.size = size;
  if (leverage !== undefined) formConfig.leverage = leverage;
  if (allocationType !== undefined) formConfig.allocationType = allocationType;
  if (orderType !== undefined) formConfig.orderType = orderType;
  if (takeProfitPct !== undefined) formConfig.takeProfitPct = takeProfitPct;
  if (stopLossPct !== undefined) formConfig.stopLossPct = stopLossPct;
  if (strategy !== undefined) formConfig.strategy = strategy;

  // NOTE: We do NOT reset lastExecutedCandleTime here. That was a major bug.
  res.json({ success: true, formConfig });
});

app.post('/api/clear-memory', (req, res) => {
  logs = [{ time: new Date().toLocaleTimeString(), message: "Memory cleared. Caches reset.", type: 'info' }];
  binanceUnsupportedSymbols.clear();
  cachedSyncedSymbols = [];
  cachedSyncedSymbolsTime = 0;
  apiAuthError = null;
  isBotRunning = false;
  if (botInterval) clearInterval(botInterval);
  activeSlots.clear();

  addLog("System memory, caches, and all slots have been cleared.", "success");
  res.json({ success: true, message: 'Memory cleared' });
});

// ══════════════════════════════════════════════════════════════════
// API ROUTES — Slot Management
// ══════════════════════════════════════════════════════════════════

app.get('/api/slots', (req, res) => {
  res.json({ success: true, slots: Array.from(activeSlots.values()) });
});

app.post('/api/slots/add', (req, res) => {
  const { symbol, timeframe, fastEmaPeriod, slowEmaPeriod, size, leverage, allocationType, orderType, takeProfitPct, stopLossPct, strategy,
    useRsiFilter, rsiPeriod, rsiOverbought, rsiOversold, useVolumeFilter, cooldownCandles } = req.body;

  if (!symbol || !timeframe) {
    return res.status(400).json({ success: false, message: 'Symbol and timeframe are required' });
  }

  // BUG FIX: Parse ALL numeric fields to numbers at creation time
  const fast = parseInt(fastEmaPeriod, 10) || 9;
  const slow = parseInt(slowEmaPeriod, 10) || 21;
  const slotId = generateSlotId({ symbol, timeframe, fastEmaPeriod: fast, slowEmaPeriod: slow });

  if (activeSlots.has(slotId)) {
    return res.status(400).json({ success: false, message: `Slot "${slotId}" already exists. Remove it first to re-add.` });
  }

  const parsedSize = Number(size) || 1;
  const parsedLeverage = Number(leverage) || 10;
  const parsedTp = Number(takeProfitPct) || 0;
  const parsedSl = Number(stopLossPct) || 0;

  const slot: TradingSlot = {
    id: slotId,
    symbol,
    timeframe,
    fastEmaPeriod: fast,
    slowEmaPeriod: slow,
    size: parsedSize,
    leverage: parsedLeverage,
    allocationType: allocationType || 'fixed',
    orderType: orderType || 'market',
    takeProfitPct: parsedTp,
    stopLossPct: parsedSl,
    strategy: strategy || 'always_in',
    lastExecutedCandleTime: 0,
    lastSignal: 'NONE',
    // New filter fields
    useRsiFilter: !!useRsiFilter,
    rsiPeriod: Number(rsiPeriod) || 14,
    rsiOverbought: Number(rsiOverbought) || 70,
    rsiOversold: Number(rsiOversold) || 30,
    useVolumeFilter: !!useVolumeFilter,
    cooldownCandles: Number(cooldownCandles) || 0,
    lastTradeCandles: 0,
    tradesExecuted: 0,
    leverageSet: false,
  };

  activeSlots.set(slotId, slot);
  const filters = [];
  if (slot.useRsiFilter) filters.push(`RSI(${slot.rsiPeriod})`);
  if (slot.useVolumeFilter) filters.push('Vol');
  if (slot.cooldownCandles > 0) filters.push(`CD:${slot.cooldownCandles}`);
  const filterStr = filters.length > 0 ? ` [Filters: ${filters.join(', ')}]` : '';
  addLog(`➕ Slot added: ${slotId} (${symbol} ${timeframe} EMA ${fast}/${slow}, Size: ${parsedSize}, Lev: ${parsedLeverage}x)${filterStr}`, 'success');
  res.json({ success: true, slot });
});

app.delete('/api/slots/:id', (req, res) => {
  const slotId = req.params.id;
  if (!activeSlots.has(slotId)) {
    return res.status(404).json({ success: false, message: `Slot "${slotId}" not found.` });
  }
  activeSlots.delete(slotId);
  addLog(`➖ Slot removed: ${slotId}`, 'info');
  res.json({ success: true, message: `Slot "${slotId}" removed.` });
});

// ══════════════════════════════════════════════════════════════════
// API ROUTES — Engine Control
// ══════════════════════════════════════════════════════════════════

app.post('/api/start', async (req, res) => {
  if (isBotRunning) {
    return res.status(400).json({ message: "Bot is already running" });
  }

  if (!process.env.DELTA_KEY || !process.env.DELTA_SECRET) {
    apiAuthError = "Missing Delta Exchange credentials";
    addLog("Failed to start: Missing Delta Exchange credentials", "error");
    return res.status(400).json({ message: "Missing credentials" });
  }

  if (activeSlots.size === 0) {
    addLog("Failed to start: No trading slots configured. Add at least one slot first.", "error");
    return res.status(400).json({ message: "No trading slots configured. Add at least one slot first." });
  }

  isBotRunning = true;
  apiAuthError = null;

  const slotNames = Array.from(activeSlots.values()).map(s => s.symbol).join(', ');
  const adaptiveMs = getAdaptiveInterval();
  addLog(`🤖 Delta Engine Started with ${activeSlots.size} slot(s): [${slotNames}] | Poll interval: ${(adaptiveMs / 1000).toFixed(0)}s`, "success");

  await syncProducts();
  runBotCycle();
  botInterval = setInterval(runBotCycle, adaptiveMs);

  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  isBotRunning = false;
  if (botInterval) { clearInterval(botInterval); botInterval = null; }
  addLog("Bot stopped manually.", "info");
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// API ROUTES — Manual Trade
// ══════════════════════════════════════════════════════════════════

app.post('/api/manual-trade', async (req, res) => {
  const { symbol, side, size, limitPrice } = req.body;
  addLog(`Manual trade requested: ${side} ${symbol} (Size: ${size})...`, "info");

  try {
    if (productsCache.length === 0) await syncProducts();

    const extraParams = limitPrice ? { _limitPrice: limitPrice } : {};

    // Get current price for TP/SL calculations
    let currentPrice: number | undefined = undefined;
    try {
      const binanceSymbol = symbol.replace(/USDT$/, '/USDT').replace(/USD$/, '/USDT');
      const ticker = await binance.fetchTicker(binanceSymbol);
      if (ticker.last) currentPrice = ticker.last;
    } catch (e: any) {
      console.warn("Could not fetch current price for manual trade TP/SL.");
    }

    // Create a temporary slot-like config for the manual trade
    const manualSlot: TradingSlot = {
      id: 'manual',
      symbol,
      timeframe: formConfig.timeframe,
      fastEmaPeriod: formConfig.fastEmaPeriod,
      slowEmaPeriod: formConfig.slowEmaPeriod,
      size: size || 1,
      leverage: formConfig.leverage,
      allocationType: formConfig.allocationType,
      orderType: formConfig.orderType,
      takeProfitPct: formConfig.takeProfitPct,
      stopLossPct: formConfig.stopLossPct,
      strategy: formConfig.strategy,
      lastExecutedCandleTime: 0,
      lastSignal: 'NONE',
      useRsiFilter: false,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30,
      useVolumeFilter: false,
      cooldownCandles: 0,
      lastTradeCandles: 0,
      tradesExecuted: 0,
      leverageSet: false,
    };

    const result = await placeDeltaMarketOrder(symbol, side, size || 1, currentPrice, manualSlot, extraParams);
    addLog(`➔ Order Placed! ID: ${result?.id || 'Success'}`, "success");
    res.json({ success: true, result });
  } catch (error: any) {
    addLog(`➔ Error: ${error.message}`, "error");
    res.status(500).json({ success: false, error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ══════════════════════════════════════════════════════════════════

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
