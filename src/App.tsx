import React, { useState, useEffect } from 'react';
import { Play, Square, Activity, Terminal, AlertCircle, RefreshCw, Plus, X, Trash2 } from 'lucide-react';

interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'error' | 'success';
}

interface TradingSlot {
  id: string;
  symbol: string;
  timeframe: string;
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  size: number | string;
  leverage: number | string;
  allocationType: string;
  orderType: string;
  takeProfitPct: number | string;
  stopLossPct: number | string;
  strategy: string;
  lastSignal: string;
}

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [slots, setSlots] = useState<TradingSlot[]>([]);
  
  // Bot Configuration (form state — used to ADD new slots)
  const [botConfig, setBotConfig] = useState(() => {
    const saved = localStorage.getItem('deltaBotConfig');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      symbol: 'BTCUSD',
      timeframe: '15m',
      fastEmaPeriod: 9,
      slowEmaPeriod: 21,
      size: 10 as number | string,
      leverage: 10 as number | string,
      allocationType: 'fixed' as 'fixed' | 'percent' | 'usd',
      orderType: 'market' as 'market' | 'limit',
      limitPrice: '' as number | string,
      takeProfitPct: '' as number | string,
      stopLossPct: '' as number | string,
      strategy: 'always_in' as 'always_in' | 'standard',
      // New filter fields
      useRsiFilter: false,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30,
      useVolumeFilter: false,
      cooldownCandles: 0,
    };
  });

  const [pingData, setPingData] = useState<any>(null);
  const [isPinging, setIsPinging] = useState(false);
  const [apiAuthError, setApiAuthError] = useState<string | null>(null);
  const [hasKeys, setHasKeys] = useState(false);
  const [apiForm, setApiForm] = useState({ apiKey: '', apiSecret: '' });
  const [showApiManager, setShowApiManager] = useState(false);

  const [positions, setPositions] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);

  const [availableSymbols, setAvailableSymbols] = useState<string[]>([
    'BTCUSDT', 'BTCUSD', 'ETHUSDT', 'ETHUSD', 'SOLUSDT', 'SOLUSD'
  ]);

  const fetchSymbols = async () => {
    try {
      const res = await fetch('/api/symbols');
      const data = await res.json();
      if (data.success && data.symbols && data.symbols.length > 0) {
        setAvailableSymbols(data.symbols);
      }
    } catch (e) {
      console.error("Failed to fetch symbols", e);
    }
  };

  useEffect(() => {
    // Sync local form config to server on load
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(botConfig)
    });
    fetchSymbols();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setIsRunning(data.isBotRunning);
      setLogs(data.logs);
      setApiAuthError(data.apiAuthError || null);
      setHasKeys(data.hasKeys);
      setSlots(data.slots || []);
    } catch (e) {
      console.error("Failed to fetch status");
    }
  };

  const fetchPositions = async () => {
    try {
      // Fetch ALL positions (no symbol filter) for multi-asset view
      const res = await fetch('/api/positions');
      const data = await res.json();
      if (data.success) {
        setPositions(data.positions || []);
      }
    } catch (e) {
      // ignore
    }
  };

  const fetchBalances = async () => {
    try {
      const res = await fetch('/api/balances');
      const data = await res.json();
      if (data.success) {
        setBalances(data.assets || []);
      }
    } catch (e) {
      // ignore
    }
  };

  const updateConfig = async (key: string, value: string | number | boolean) => {
    const newConfig = { ...botConfig, [key]: value };
    setBotConfig(newConfig);
    localStorage.setItem('deltaBotConfig', JSON.stringify(newConfig));
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig)
    });
  };

  useEffect(() => {
    fetchStatus();
    fetchPositions();
    fetchBalances();
    const interval = setInterval(() => {
      fetchStatus();
      fetchPositions();
      fetchBalances();
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const toggleBot = async () => {
    const endpoint = isRunning ? '/api/stop' : '/api/start';
    await fetch(endpoint, { method: 'POST' });
    fetchStatus();
  };

  const handlePing = async () => {
    setIsPinging(true);
    setPingData(null);
    try {
      const res = await fetch('/api/ping', { method: 'POST' });
      const data = await res.json();
      setPingData(data);
    } catch (err: any) {
      setPingData({ success: false, message: err.message });
    } finally {
      setIsPinging(false);
    }
  };

  const executeManualTrade = async (side: 'BUY' | 'SELL') => {
    if (!botConfig.symbol || !botConfig.size) return;
    await fetch('/api/manual-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: botConfig.symbol, side, size: botConfig.size, limitPrice: botConfig.limitPrice })
    });
    fetchStatus();
    fetchPositions();
  };

  const closePosition = async (symbol: string, side: string, size: number) => {
    if (!symbol) return;
    try {
      await fetch('/api/close_position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side, size })
      });
      fetchPositions();
    } catch (e) {
      console.error("Failed to close position", e);
    }
  };

  const addSlot = async () => {
    try {
      const res = await fetch('/api/slots/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botConfig)
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.message || 'Failed to add slot');
      }
      fetchStatus();
    } catch (e) {
      console.error("Failed to add slot", e);
    }
  };

  const removeSlot = async (slotId: string) => {
    try {
      await fetch(`/api/slots/${encodeURIComponent(slotId)}`, { method: 'DELETE' });
      fetchStatus();
    } catch (e) {
      console.error("Failed to remove slot", e);
    }
  };

  const saveApiCredentials = async () => {
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiForm)
      });
      const data = await res.json();
      if (data.success) {
        setShowApiManager(false);
        setApiForm({ apiKey: '', apiSecret: '' });
        fetchStatus();
      } else {
        alert("Failed to save credentials: " + data.message);
      }
    } catch (e) {
      console.error("Failed to save credentials", e);
    }
  };

  const clearMemory = async () => {
    if (!window.confirm("Are you sure you want to clear bot memory, all slots, and reset caches? This will also stop the bot.")) return;
    try {
      await fetch('/api/clear-memory', { method: 'POST' });
      fetchStatus();
    } catch (e) {
      console.error("Failed to clear memory", e);
    }
  };

  const TIMEFRAMES = [
    { label: '1 Minute', value: '1m' },
    { label: '3 Minutes', value: '3m' },
    { label: '5 Minutes', value: '5m' },
    { label: '15 Minutes', value: '15m' },
    { label: '30 Minutes', value: '30m' },
    { label: '1 Hour', value: '1h' },
    { label: '4 Hours', value: '4h' },
    { label: '1 Day', value: '1d' }
  ];

  const TIMEFRAME_LABELS: Record<string, string> = {};
  TIMEFRAMES.forEach(tf => TIMEFRAME_LABELS[tf.value] = tf.label);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans selection:bg-indigo-100">
      <div className="max-w-6xl mx-auto p-6 md:py-12">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between mb-12 gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
              <Activity className="w-8 h-8 text-emerald-600" />
              Delta Trade Engine
            </h1>
            <p className="text-slate-500 mt-1 text-sm">Multi-Asset EMA Crossover Engine</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button 
              onClick={() => setShowApiManager(!showApiManager)}
              className="bg-white border border-slate-200 hover:border-indigo-500 hover:text-indigo-600 text-slate-700 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all shadow-sm"
            >
              API Management
            </button>
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-full px-4 py-2 w-max shadow-sm">
              <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              <span className="text-sm font-semibold text-slate-700">
                {isRunning ? `Active (${slots.length} slot${slots.length !== 1 ? 's' : ''})` : 'System Offline'}
              </span>
            </div>
          </div>
        </header>

        {showApiManager && (
          <div className="mb-6 p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
            <h2 className="text-lg font-bold text-slate-900 mb-4">API Management</h2>
            <p className="text-sm text-slate-500 mb-4">Enter your Delta Exchange API keys. These will be saved locally to your .env file.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">API Key</label>
                <input 
                  type="password" 
                  value={apiForm.apiKey}
                  onChange={e => setApiForm({...apiForm, apiKey: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                  placeholder="Enter API Key"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">API Secret</label>
                <input 
                  type="password" 
                  value={apiForm.apiSecret}
                  onChange={e => setApiForm({...apiForm, apiSecret: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                  placeholder="Enter API Secret"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={saveApiCredentials} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold shadow-sm transition-colors">
                Save Credentials
              </button>
              <button onClick={() => setShowApiManager(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-semibold transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        {(!hasKeys || apiAuthError) && !showApiManager && (
          <div className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-3 w-full shadow-sm">
            <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-rose-800">Delta API Authentication Required</h3>
              <p className="text-xs text-rose-600 mt-1 mb-3 font-medium">
                {apiAuthError || "API Keys are missing. Please configure them in API Management."}
              </p>
              <button 
                onClick={() => setShowApiManager(true)}
                className="text-xs bg-rose-100 hover:bg-rose-200 text-rose-700 px-3.5 py-2 rounded-lg font-semibold border border-rose-200 transition-colors shadow-sm"
              >
                Open API Management
              </button>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          
          {/* Controls Column */}
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 mb-4 uppercase tracking-wider">Slot Configuration</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">Asset Symbol</label>
                  <select 
                    value={botConfig.symbol}
                    onChange={e => updateConfig('symbol', e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                  >
                    {availableSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">Timeframe</label>
                  <select 
                    value={botConfig.timeframe}
                    onChange={e => updateConfig('timeframe', e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                  >
                    {TIMEFRAMES.map(tf => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Fast EMA</label>
                    <input 
                      type="number" 
                      value={botConfig.fastEmaPeriod}
                      onChange={e => updateConfig('fastEmaPeriod', parseInt(e.target.value) || 1)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="1"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Slow EMA</label>
                    <input 
                      type="number" 
                      value={botConfig.slowEmaPeriod}
                      onChange={e => updateConfig('slowEmaPeriod', parseInt(e.target.value) || 1)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="1"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Leverage (x)</label>
                    <input 
                      type="number" 
                      value={botConfig.leverage}
                      onChange={e => updateConfig('leverage', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="1"
                      max="100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Allocation Type</label>
                    <select 
                      value={botConfig.allocationType}
                      onChange={e => updateConfig('allocationType', e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                    >
                      <option value="fixed">Fixed Size (Lots)</option>
                      <option value="percent">% of Margin</option>
                      <option value="usd">Fixed USD ($)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Order Type</label>
                    <select 
                      value={botConfig.orderType}
                      onChange={e => updateConfig('orderType', e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                    >
                      <option value="market">Market Order</option>
                      <option value="limit">Limit Order</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">
                      {botConfig.allocationType === 'percent' 
                         ? 'Margin Allocation (%)' 
                         : botConfig.allocationType === 'usd' 
                         ? 'Margin Allocation (USD)' 
                         : 'Lot Size / Quantity'}
                    </label>
                    <input 
                      type="number" 
                      value={botConfig.size}
                      onChange={e => updateConfig('size', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="0"
                      step="any"
                    />
                  </div>
                </div>

                {botConfig.orderType === 'limit' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Custom Limit Price (Manual Trades)</label>
                    <input 
                      type="number" 
                      value={botConfig.limitPrice}
                      onChange={e => updateConfig('limitPrice', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      step="any"
                      placeholder="Leave blank to use current price"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Take Profit (%)</label>
                    <input 
                      type="number" 
                      value={botConfig.takeProfitPct}
                      onChange={e => updateConfig('takeProfitPct', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="0"
                      step="any"
                      placeholder="e.g. 2.0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Stop Loss (%)</label>
                    <input 
                      type="number" 
                      value={botConfig.stopLossPct}
                      onChange={e => updateConfig('stopLossPct', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="0"
                      step="any"
                      placeholder="e.g. 1.0"
                    />
                  </div>
                </div>

                <button 
                  onClick={() => updateConfig('strategy', botConfig.strategy === 'always_in' ? 'standard' : 'always_in')}
                  className={`w-full flex items-center justify-between py-3 px-4 rounded-lg font-semibold transition-all duration-200 border ${
                    botConfig.strategy === 'always_in'
                      ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-sm'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-bold">
                      {botConfig.strategy === 'always_in' ? '🔄 Stop & Reverse' : '📋 Standard (Close Only)'}
                    </span>
                    <span className="text-[10px] opacity-75 font-normal mt-0.5">
                      {botConfig.strategy === 'always_in' 
                         ? 'Exit old → Enter new on opposite signal'
                         : 'Only closes position on opposite signal'}
                    </span>
                  </div>
                  <div className={`w-11 h-6 rounded-full relative transition-colors ${botConfig.strategy === 'always_in' ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                    <div 
                      className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all duration-200 shadow-sm"
                      style={{ left: botConfig.strategy === 'always_in' ? '22px' : '2px' }}
                    />
                  </div>
                </button>

                {/* === SIGNAL FILTERS === */}
                <div className="pt-3 border-t border-slate-200">
                  <h3 className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Signal Filters</h3>
                  
                  {/* RSI Filter Toggle */}
                  <button 
                    onClick={() => updateConfig('useRsiFilter', !botConfig.useRsiFilter)}
                    className={`w-full flex items-center justify-between py-2.5 px-4 rounded-lg font-semibold transition-all duration-200 border mb-3 ${
                      botConfig.useRsiFilter
                        ? 'bg-amber-50 text-amber-700 border-amber-200 shadow-sm'
                        : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex flex-col text-left">
                      <span className="text-sm font-bold">📊 RSI Filter</span>
                      <span className="text-[10px] opacity-75 font-normal mt-0.5">Reject signals at extreme RSI levels</span>
                    </div>
                    <div className={`w-11 h-6 rounded-full relative transition-colors ${botConfig.useRsiFilter ? 'bg-amber-500' : 'bg-slate-300'}`}>
                      <div className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all duration-200 shadow-sm"
                        style={{ left: botConfig.useRsiFilter ? '22px' : '2px' }}
                      />
                    </div>
                  </button>

                  {botConfig.useRsiFilter && (
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Period</label>
                        <input type="number" value={botConfig.rsiPeriod}
                          onChange={e => updateConfig('rsiPeriod', parseInt(e.target.value) || 14)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-amber-500 transition-all"
                          min="2" max="50"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Overbought</label>
                        <input type="number" value={botConfig.rsiOverbought}
                          onChange={e => updateConfig('rsiOverbought', parseInt(e.target.value) || 70)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-amber-500 transition-all"
                          min="50" max="100"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Oversold</label>
                        <input type="number" value={botConfig.rsiOversold}
                          onChange={e => updateConfig('rsiOversold', parseInt(e.target.value) || 30)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-amber-500 transition-all"
                          min="0" max="50"
                        />
                      </div>
                    </div>
                  )}

                  {/* Volume Filter Toggle */}
                  <button 
                    onClick={() => updateConfig('useVolumeFilter', !botConfig.useVolumeFilter)}
                    className={`w-full flex items-center justify-between py-2.5 px-4 rounded-lg font-semibold transition-all duration-200 border mb-3 ${
                      botConfig.useVolumeFilter
                        ? 'bg-cyan-50 text-cyan-700 border-cyan-200 shadow-sm'
                        : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex flex-col text-left">
                      <span className="text-sm font-bold">📈 Volume Filter</span>
                      <span className="text-[10px] opacity-75 font-normal mt-0.5">Only trade when volume is above average</span>
                    </div>
                    <div className={`w-11 h-6 rounded-full relative transition-colors ${botConfig.useVolumeFilter ? 'bg-cyan-500' : 'bg-slate-300'}`}>
                      <div className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all duration-200 shadow-sm"
                        style={{ left: botConfig.useVolumeFilter ? '22px' : '2px' }}
                      />
                    </div>
                  </button>

                  {/* Cooldown */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">⏳ Cooldown (candles)</label>
                    <input type="number" value={botConfig.cooldownCandles}
                      onChange={e => updateConfig('cooldownCandles', parseInt(e.target.value) || 0)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                      min="0" max="100"
                      placeholder="0 = disabled"
                    />
                    <p className="text-[10px] text-slate-400 mt-0.5">Skip signals within N candles of last trade (anti-whipsaw)</p>
                  </div>
                </div>

                {/* Add Slot Button */}
                <button
                  onClick={addSlot}
                  disabled={isRunning}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-bold transition-all duration-200 bg-indigo-600 text-white hover:bg-indigo-500 border border-indigo-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" /> Add Trading Slot
                </button>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 mb-4 uppercase tracking-wider">Engine Control</h2>
              
              <button 
                onClick={toggleBot}
                className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-bold transition-all duration-200 ${
                  isRunning 
                    ? 'bg-rose-600 text-white hover:bg-rose-500 border border-rose-600 shadow-sm' 
                    : 'bg-emerald-600 text-white hover:bg-emerald-500 border border-emerald-600 shadow-sm'
                }`}
              >
                {isRunning ? (
                  <><Square className="w-4 h-4 fill-current" /> Stop Engine</>
                ) : (
                  <><Play className="w-4 h-4 fill-current" /> Start Engine</>
                )}
              </button>

              {slots.length === 0 && !isRunning && (
                <div className="mt-4 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                  Add at least one trading slot above, then start the engine.
                </div>
              )}

              <button
                onClick={handlePing}
                disabled={isPinging}
                className="w-full mt-4 flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-semibold transition-all duration-200 bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 shadow-sm disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${isPinging ? 'animate-spin' : ''}`} /> 
                {isPinging ? 'Pinging API...' : 'Ping Delta API'}
              </button>

              {pingData && (
                <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-medium">Status</span>
                    {pingData.success ? (
                      <span className="text-emerald-600 font-bold tracking-wide">CONNECTED</span>
                    ) : (
                      <span className="text-rose-600 font-bold tracking-wide">FAILED</span>
                    )}
                  </div>
                  
                  {pingData.profile && (
                    <div className="flex flex-col border-t border-slate-200 pt-2 gap-1">
                      <span className="text-slate-500 font-medium">Account Details</span>
                      <span className="text-slate-800 font-semibold">{(pingData.profile.first_name || '') + ' ' + (pingData.profile.last_name || '')} ({pingData.profile.email})</span>
                      <span className="text-slate-400 font-mono text-[10px]">ID: {pingData.profile.id}</span>
                    </div>
                  )}

                  {pingData.assets && (
                    <div className="flex flex-col border-t border-slate-200 pt-2 gap-1">
                      <span className="text-slate-500 font-medium mb-1">Assets</span>
                      {pingData.assets.length > 0 ? (
                        pingData.assets.map((a: any, i: number) => (
                           <div key={i} className="flex justify-between font-mono">
                             <span className="text-slate-600 font-semibold">{a.asset}</span>
                             <span className="text-slate-800 font-bold">{a.total} <span className="text-slate-400 font-normal">(Free: {a.free})</span></span>
                           </div>
                        ))
                      ) : (
                        <span className="text-slate-400">No balances</span>
                      )}
                    </div>
                  )}

                  {!pingData.success && (
                    <div className="text-rose-600 mt-2 whitespace-pre-wrap">{pingData.message}</div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-slate-200">
                <button 
                  onClick={() => executeManualTrade('BUY')}
                  className="flex items-center justify-center py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-sm font-semibold shadow-sm transition-colors"
                >
                  Buy (Long)
                </button>
                <button 
                  onClick={() => executeManualTrade('SELL')}
                  className="flex items-center justify-center py-2 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-lg text-sm font-semibold shadow-sm transition-colors"
                >
                  Sell (Short)
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-200">
                <button 
                  onClick={clearMemory}
                  className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-semibold transition-all duration-200 bg-slate-50 text-slate-500 hover:bg-rose-50 hover:text-rose-600 border border-slate-200 hover:border-rose-200 shadow-sm"
                >
                  <Trash2 className="w-4 h-4" /> Clear All Slots & Memory
                </button>
              </div>
            </div>
          </div>

          {/* Main Content Column */}
          <div className="md:col-span-2 flex flex-col gap-6">

            {/* Active Trading Slots */}
            <div className="flex-shrink-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                  Active Trading Slots ({slots.length})
                </h2>
              </div>
              <div className="p-4 min-h-[100px]">
                {slots.length === 0 ? (
                  <div className="py-8 text-center text-slate-400 font-medium">
                    No trading slots configured. Use the form on the left to add slots.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {slots.map((slot) => (
                      <div key={slot.id} className="flex items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-200 transition-colors">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-lg font-extrabold text-slate-900">{slot.symbol}</span>
                          <span className="text-xs font-semibold bg-indigo-100 text-indigo-700 px-2.5 py-1 rounded-full">
                            {TIMEFRAME_LABELS[slot.timeframe] || slot.timeframe}
                          </span>
                          <span className="text-xs font-mono text-slate-600">
                            EMA {slot.fastEmaPeriod}/{slot.slowEmaPeriod}
                          </span>
                          <span className="text-xs text-slate-500">
                            Size: {slot.size} | {slot.leverage}x
                          </span>
                          <span className="text-xs text-slate-500">
                            {slot.strategy === 'always_in' ? '🔄 S&R' : '📋 Std'}
                          </span>
                          {(slot as any).useRsiFilter && (
                            <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              RSI({(slot as any).rsiPeriod || 14})
                            </span>
                          )}
                          {(slot as any).useVolumeFilter && (
                            <span className="text-[10px] font-semibold bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">
                              Vol✓
                            </span>
                          )}
                          {((slot as any).cooldownCandles || 0) > 0 && (
                            <span className="text-[10px] font-semibold bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                              CD:{(slot as any).cooldownCandles}
                            </span>
                          )}
                          {slot.lastSignal && slot.lastSignal !== 'NONE' && (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              slot.lastSignal === 'BUY' 
                                ? 'bg-emerald-100 text-emerald-700' 
                                : 'bg-rose-100 text-rose-700'
                            }`}>
                              Last: {slot.lastSignal}
                            </span>
                          )}
                          {((slot as any).tradesExecuted || 0) > 0 && (
                            <span className="text-[10px] font-mono text-slate-400">
                              {(slot as any).tradesExecuted} trades
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => removeSlot(slot.id)}
                          disabled={isRunning}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Remove slot"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Account Balances */}
            <div className="flex-shrink-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                  Account Balances
                </h2>
              </div>
              <div className="p-4 min-h-[120px] max-h-[400px] overflow-auto">
                <table className="w-full text-left text-lg whitespace-nowrap">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th className="py-3 px-4 font-semibold text-slate-600">Asset</th>
                      <th className="py-3 px-4 font-semibold text-slate-600 text-right">Total</th>
                      <th className="py-3 px-4 font-semibold text-slate-600 text-right">Free</th>
                      <th className="py-3 px-4 font-semibold text-slate-600 text-right">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.length === 0 ? (
                      <tr>
                         <td colSpan={4} className="py-8 text-center text-slate-400 font-medium text-lg">No positive balances available</td>
                      </tr>
                    ) : (
                      balances.map((b, idx) => (
                        <tr key={idx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 px-4 font-extrabold text-slate-900 text-xl">
                            {b.asset}
                          </td>
                          <td className="py-4 px-4 text-slate-900 text-right font-mono text-lg font-bold">{Number(b.total).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-4 px-4 text-slate-800 text-right font-mono text-lg">{Number(b.free).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-4 px-4 text-slate-500 text-right font-mono text-lg">{Number(b.used).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Active Positions — ALL symbols */}
            <div className="flex-shrink-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                  Active Positions (All Assets)
                </h2>
              </div>
              <div className="p-4 min-h-[120px] max-h-[600px] overflow-auto">
                <table className="w-full text-left text-lg whitespace-nowrap">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th className="py-3 px-4 font-semibold text-slate-600">Symbol</th>
                      <th className="py-3 px-4 font-semibold text-slate-600">Side</th>
                      <th className="py-3 px-4 font-semibold text-slate-600">Size</th>
                      <th className="py-3 px-4 font-semibold text-slate-600">Entry Price</th>
                      <th className="py-3 px-4 font-semibold text-slate-600">Liq. Price</th>
                      <th className="py-3 px-4 font-semibold text-slate-600">PnL</th>
                      <th className="py-3 px-4 font-semibold text-slate-600 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.filter(p => Math.abs(Number(p.contracts || 0)) > 0).length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400 font-medium text-lg">No active positions</td>
                      </tr>
                    ) : (
                      positions.filter(p => Math.abs(Number(p.contracts || 0)) > 0).map((pos, idx) => (
                        <tr key={idx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 px-4 font-extrabold text-slate-900 text-lg">
                            {pos.symbol}
                          </td>
                          <td className={`py-4 px-4 font-black text-xl ${pos.side === 'long' || pos.side === 'buy' ? 'text-emerald-600' : 'text-rose-600'} uppercase tracking-wide`}>
                            {pos.side}
                          </td>
                          <td className="py-4 px-4 text-slate-900 font-mono text-xl font-bold">{Math.abs(Number(pos.contracts))}</td>
                          <td className="py-4 px-4 text-slate-800 font-mono text-lg">{Number(pos.entryPrice || 0).toFixed(4).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-4 px-4 text-amber-600 font-mono text-lg font-semibold">{pos.liquidationPrice ? Number(pos.liquidationPrice).toFixed(4).replace(/\.?0+$/, '') : '-'}</td>
                          <td className="py-4 px-4 font-mono font-bold">
                            {pos.info?.realized_pnl ? (
                              <span className={Number(pos.info.realized_pnl) >= 0 ? 'text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200 text-xl font-extrabold shadow-sm' : 'text-rose-700 bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-200 text-xl font-extrabold shadow-sm'}>
                                {Number(pos.info.realized_pnl) > 0 ? '+' : ''}{Number(pos.info.realized_pnl).toFixed(4).replace(/\.?0+$/, '') || '0'}
                              </span>
                            ) : '-'}
                          </td>
                          <td className="py-4 px-4 text-right">
                            <button 
                              onClick={() => closePosition(pos.symbol, pos.side, Math.abs(Number(pos.contracts)))}
                              className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-base transition-all shadow-md active:scale-95"
                            >
                              CLOSE
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Logs Column */}
            <div className="min-h-[400px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-md">
              <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/40 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-indigo-400" />
                  Terminal Logs
                </h2>
                <div className="text-xs text-slate-500 font-mono">
                  Listening to server...
                </div>
              </div>
              
              <div className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-2">
                {logs.length === 0 && (
                  <div className="text-slate-600 text-center mt-10">No logs available.</div>
                )}
                {logs.map((log, idx) => (
                  <div key={idx} className="flex items-start gap-3">
                    <span className="text-slate-600 shrink-0">[{log.time}]</span>
                    <span className={`break-words ${
                      log.type === 'error' ? 'text-rose-400' :
                      log.type === 'success' ? 'text-emerald-400' : 
                      'text-slate-300'
                    }`}>
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
