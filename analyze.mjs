// ============================================================================
// Script d'analyse technique + notification Telegram, conçu pour tourner via
// GitHub Actions (cron intégré, gratuit). Ne place aucun ordre — envoie un
// message Telegram uniquement quand un signal BUY/SELL apparaît et change
// par rapport au dernier signal connu (mémorisé dans state.json, committé
// dans le repo à chaque exécution).
// ============================================================================

import fs from "fs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]; // modifie cette liste si besoin
const STATE_FILE = "state.json";

const RISK_CONFIG = {
  capital: 10000,
  riskPct: 1,
  dailyLossLimit: 500,
  maxDrawdown: 1000,
};

// ==================== ÉTAT (remplace le KV Cloudflare) ====================

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ==================== TELEGRAM ====================

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant (vérifie les secrets GitHub)");
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const trimmed = text.length > 4000 ? text.slice(0, 4000) + "\n\n[...tronqué]" : text;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: trimmed, parse_mode: "Markdown" }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Erreur envoi Telegram (${resp.status}): ${body}`);
  }
}

function formatMessage(symbol, a) {
  return `🔔 *${symbol}* — Signal : *${a.signal}*\n\n${a.text}`;
}

// ==================== ANALYSE TECHNIQUE (identique à la page mobile) ====================

async function fetchCandles(symbol, interval = "15m", limit = 150) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Erreur API Binance (${resp.status})`);
  const raw = await resp.json();
  return raw.map((c) => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(values, period = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }
  const avgGain = average(gains.slice(-period));
  const avgLoss = average(losses.slice(-period));
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function detectTrend(candles) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const lastClose = closes[closes.length - 1];
  const l20 = e20[e20.length - 1];
  const l50 = e50[e50.length - 1];
  if (l20 > l50 && lastClose > l20) return "haussière";
  if (l20 < l50 && lastClose < l20) return "baissière";
  return "indécise / range";
}

function detectLastCandlePattern(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  if (range === 0) return "aucun pattern net";
  if (body / range < 0.1) return "doji (indécision)";
  const prevBody = Math.abs(prev.close - prev.open);
  if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close && body > prevBody)
    return "engulfing haussier";
  if (prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open && body > prevBody)
    return "engulfing baissier";
  if (lowerWick > body * 2 && upperWick < body) return "marteau / pin bar haussier";
  if (upperWick > body * 2 && lowerWick < body) return "étoile filante / pin bar baissier";
  return "bougie standard, pas de pattern marqué";
}

function findSupportResistance(candles, window = 5, nLevels = 2) {
  const price = candles[candles.length - 1].close;
  const pivotHighs = new Set();
  const pivotLows = new Set();
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1);
    if (candles[i].high === Math.max(...slice.map((c) => c.high))) pivotHighs.add(candles[i].high);
    if (candles[i].low === Math.min(...slice.map((c) => c.low))) pivotLows.add(candles[i].low);
  }
  const resistances = [...pivotHighs].filter((h) => h > price).sort((a, b) => a - b).slice(0, nLevels);
  const supports = [...pivotLows].filter((l) => l < price).sort((a, b) => b - a).slice(0, nLevels);
  return { supports, resistances };
}

function computeFibonacci(candles, lookback = 60) {
  const recent = candles.slice(-lookback);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const diff = swingHigh - swingLow;
  return {
    "0.0%": swingHigh,
    "23.6%": swingHigh - 0.236 * diff,
    "38.2%": swingHigh - 0.382 * diff,
    "50.0%": swingHigh - 0.5 * diff,
    "61.8%": swingHigh - 0.618 * diff,
    "78.6%": swingHigh - 0.786 * diff,
    "100%": swingLow,
  };
}

function getPivots(candles, window = 3) {
  const highs = [];
  const lows = [];
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1);
    if (candles[i].high === Math.max(...slice.map((c) => c.high))) highs.push({ index: i, price: candles[i].high });
    if (candles[i].low === Math.min(...slice.map((c) => c.low))) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function linRegSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const xs = points.map((p) => p.index);
  const ys = points.map((p) => p.price);
  const xMean = average(xs);
  const yMean = average(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function pctDiff(a, b) {
  return (Math.abs(a - b) / ((a + b) / 2)) * 100;
}

function detectChartPattern(candles) {
  const recent = candles.slice(-60);
  const { highs, lows } = getPivots(recent, 3);
  const price = candles[candles.length - 1].close;

  if (highs.length >= 3) {
    const [h1, h2, h3] = highs.slice(-3);
    if (pctDiff(h1.price, h2.price) < 1.5 && pctDiff(h2.price, h3.price) < 1.5 && pctDiff(h1.price, h3.price) < 1.5) {
      const troughsBetween = lows.filter((l) => l.index > h1.index && l.index < h3.index);
      if (troughsBetween.length >= 2) {
        const neckline = Math.min(...troughsBetween.map((t) => t.price));
        const height = average([h1.price, h2.price, h3.price]) - neckline;
        return { name: "Triple Top", entry: neckline, sl: Math.max(h1.price, h2.price, h3.price) * 1.002, tp: neckline - height, direction: "SELL", note: "3 sommets comparables." };
      }
    }
  }
  if (lows.length >= 3) {
    const [l1, l2, l3] = lows.slice(-3);
    if (pctDiff(l1.price, l2.price) < 1.5 && pctDiff(l2.price, l3.price) < 1.5 && pctDiff(l1.price, l3.price) < 1.5) {
      const peaksBetween = highs.filter((h) => h.index > l1.index && h.index < l3.index);
      if (peaksBetween.length >= 2) {
        const neckline = Math.max(...peaksBetween.map((p) => p.price));
        const height = neckline - average([l1.price, l2.price, l3.price]);
        return { name: "Triple Bottom", entry: neckline, sl: Math.min(l1.price, l2.price, l3.price) * 0.998, tp: neckline + height, direction: "BUY", note: "3 creux comparables." };
      }
    }
  }
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    const troughsBetween = lows.filter((l) => l.index > h1.index && l.index < h2.index);
    if (troughsBetween.length > 0 && pctDiff(h1.price, h2.price) < 1.2) {
      const neckline = Math.min(...troughsBetween.map((t) => t.price));
      const height = h1.price - neckline;
      return { name: "Double Top", entry: neckline, sl: Math.max(h1.price, h2.price) * 1.002, tp: neckline - height, direction: "SELL", note: "Cassure de la neckline attendue." };
    }
  }
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2);
    const peaksBetween = highs.filter((h) => h.index > l1.index && h.index < l2.index);
    if (peaksBetween.length > 0 && pctDiff(l1.price, l2.price) < 1.2) {
      const neckline = Math.max(...peaksBetween.map((p) => p.price));
      const height = neckline - l1.price;
      return { name: "Double Bottom", entry: neckline, sl: Math.min(l1.price, l2.price) * 0.998, tp: neckline + height, direction: "BUY", note: "Cassure de la neckline attendue." };
    }
  }
  if (highs.length >= 3 && lows.length >= 3) {
    const rH = highs.slice(-4);
    const rL = lows.slice(-4);
    const sH = linRegSlope(rH);
    const sL = linRegSlope(rL);
    const widthStart = rH[0].price - rL[0].price;
    const widthEnd = rH[rH.length - 1].price - rL[rL.length - 1].price;
    const converging = widthEnd < widthStart * 0.7;
    const flat = (s) => Math.abs(s) < price * 0.0004;
    const height = Math.max(...rH.map((h) => h.price)) - Math.min(...rL.map((l) => l.price));
    const lastHigh = rH[rH.length - 1].price;
    const lastLow = rL[rL.length - 1].price;

    if (converging) {
      if (flat(sH) && sL > 0) return { name: "Triangle ascendant", entry: lastHigh, sl: lastLow * 0.998, tp: lastHigh + height, direction: "BUY", note: "Cassure résistance horizontale." };
      if (flat(sL) && sH < 0) return { name: "Triangle descendant", entry: lastLow, sl: lastHigh * 1.002, tp: lastLow - height, direction: "SELL", note: "Cassure support horizontal." };
      if (sH < 0 && sL < 0) return { name: "Coin descendant (Falling Wedge)", entry: lastHigh, sl: lastLow * 0.998, tp: lastHigh + height, direction: "BUY", note: "Souvent haussier à la cassure." };
      if (sH > 0 && sL > 0) return { name: "Coin montant (Rising Wedge)", entry: lastLow, sl: lastHigh * 1.002, tp: lastLow - height, direction: "SELL", note: "Souvent baissier à la cassure." };
    } else {
      if (sH > 0 && sL > 0) return { name: "Canal ascendant", entry: lastLow, sl: lastLow * 0.995, tp: lastHigh, direction: "BUY", note: "Achat sur rebond du bas du canal." };
      if (sH < 0 && sL < 0) return { name: "Canal descendant", entry: lastHigh, sl: lastHigh * 1.005, tp: lastLow, direction: "SELL", note: "Vente sur rejet du haut du canal." };
    }
  }
  return { name: "Aucun pattern net détecté", entry: null, sl: null, tp: null, direction: "WAIT", note: "Pas assez de structure claire." };
}

function computeATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p)));
  }
  return average(trs.slice(-period));
}

function computeMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const eF = ema(closes, fast);
  const eS = ema(closes, slow);
  const macdLine = eF.map((v, i) => v - eS[i]);
  const signalLine = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { histogram: histogram[histogram.length - 1], prevHistogram: histogram[histogram.length - 2] };
}

function computeBollinger(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = average(slice);
  const variance = average(slice.map((v) => (v - mean) ** 2));
  const stdDev = Math.sqrt(variance);
  return { upper: mean + mult * stdDev, middle: mean, lower: mean - mult * stdDev };
}

function computeStochastic(candles, period = 14) {
  const slice = candles.slice(-period);
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const last = candles[candles.length - 1].close;
  if (hi === lo) return 50;
  return ((last - lo) / (hi - lo)) * 100;
}

function computeADX(candles, period = 14) {
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  const smooth = (arr) => average(arr.slice(-period));
  const atrS = smooth(trs);
  const plusDI = (smooth(plusDM) / atrS) * 100;
  const minusDI = (smooth(minusDM) / atrS) * 100;
  const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  return isNaN(dx) ? 0 : dx;
}

async function fetchHTFTrend(symbol, interval) {
  try {
    return detectTrend(await fetchCandles(symbol, interval, 100));
  } catch (e) {
    return "indisponible";
  }
}

function roundQuantity(qty, price) {
  if (price >= 1000) return Math.round(qty * 1000) / 1000;
  if (price >= 10) return Math.round(qty * 100) / 100;
  if (price >= 1) return Math.round(qty * 10) / 10;
  return Math.round(qty);
}

async function buildAnalysis(symbol) {
  const candles = await fetchCandles(symbol, "15m", 150);
  const price = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);

  const trend = detectTrend(candles);
  const pattern = detectLastCandlePattern(candles);
  const chartPattern = detectChartPattern(candles);
  const { supports, resistances } = findSupportResistance(candles);
  const fib = computeFibonacci(candles);
  const rsiVal = rsi(closes);
  const atr = computeATR(candles);
  const macd = computeMACD(closes);
  const bb = computeBollinger(closes);
  const stoch = computeStochastic(candles);
  const adx = computeADX(candles);

  const nearestSupport = supports[0] ?? null;
  const nearestResistance = resistances[0] ?? null;

  const [trend1h, trend4h] = await Promise.all([fetchHTFTrend(symbol, "1h"), fetchHTFTrend(symbol, "4h")]);

  let signal = "WAIT";
  const reasons = [];

  if (trend === "haussière" && pattern.includes("haussier")) { signal = "BUY"; reasons.push("tendance+pattern haussiers 15m"); }
  else if (trend === "baissière" && pattern.includes("baissier")) { signal = "SELL"; reasons.push("tendance+pattern baissiers 15m"); }
  else reasons.push("pas d'alignement tendance/pattern 15m");

  if (rsiVal > 70 && signal === "BUY") { reasons.push(`RSI surachat (${rsiVal.toFixed(1)})`); signal = "WAIT"; }
  if (rsiVal < 30 && signal === "SELL") { reasons.push(`RSI survente (${rsiVal.toFixed(1)})`); signal = "WAIT"; }
  if (adx < 20 && signal !== "WAIT") { reasons.push(`ADX faible (${adx.toFixed(1)}) — range`); signal = "WAIT"; }
  if (signal === "BUY" && trend1h === "baissière") { reasons.push("1h baissière contredit le 15m"); signal = "WAIT"; }
  if (signal === "SELL" && trend1h === "haussière") { reasons.push("1h haussière contredit le 15m"); signal = "WAIT"; }

  let slVal = null, tpVal = null;
  if (signal === "BUY" && nearestSupport && nearestResistance) { slVal = nearestSupport * 0.998; tpVal = nearestResistance; }
  else if (signal === "SELL" && nearestSupport && nearestResistance) { slVal = nearestResistance * 1.002; tpVal = nearestSupport; }

  let rrRatio = null;
  if (slVal !== null && tpVal !== null && signal !== "WAIT") {
    const risk = Math.abs(price - slVal);
    const reward = Math.abs(tpVal - price);
    rrRatio = risk > 0 ? reward / risk : null;
    if (rrRatio !== null && rrRatio < 2) { reasons.push(`R:R insuffisant (${rrRatio.toFixed(2)}:1)`); signal = "WAIT"; }
  }

  let slTp = "SL/TP non calculés (signal WAIT)";
  if (signal !== "WAIT" && slVal !== null && tpVal !== null) {
    slTp = `SL suggéré : ${slVal.toFixed(4)}\nTP suggéré : ${tpVal.toFixed(4)}\nR:R : 1:${rrRatio.toFixed(2)}`;
  }

  let confidence = 30;
  if (chartPattern.direction === signal && signal !== "WAIT") confidence += 25;
  if (adx > 25) confidence += 15;
  if ((signal === "BUY" && trend1h === "haussière") || (signal === "SELL" && trend1h === "baissière")) confidence += 15;
  if ((signal === "BUY" && trend4h === "haussière") || (signal === "SELL" && trend4h === "baissière")) confidence += 10;
  if (rrRatio !== null && rrRatio >= 2.5) confidence += 5;
  confidence = Math.min(confidence, 95);

  let positionTxt = "Pas de position calculée (signal WAIT).";
  if (signal !== "WAIT" && slVal !== null) {
    const riskAmount = RISK_CONFIG.capital * (RISK_CONFIG.riskPct / 100);
    const priceDiff = Math.abs(price - slVal);
    let qty = priceDiff > 0 ? riskAmount / priceDiff : 0;
    qty = roundQuantity(qty, price);
    positionTxt =
      `💼 Money Management (risque fixe ${RISK_CONFIG.riskPct}%)\n` +
      `  Risque théorique : ${riskAmount.toFixed(2)}€\n` +
      `  Quantité suggérée : ${qty}\n` +
      `  Valeur position ≈ ${(qty * price).toFixed(2)}€\n` +
      `  ⚠️ Vérifie ta perte du jour et ton drawdown dans la page mobile avant d'exécuter.`;
  }

  const fibTxt = Object.entries(fib).map(([k, v]) => `  ${k}: ${v.toFixed(4)}`).join("\n");
  const cpTxt =
    `📐 Pattern chartiste : ${chartPattern.name} (confiance ${confidence}%)\n` +
    (chartPattern.entry !== null ? `  Entrée pattern : ${chartPattern.entry.toFixed(4)}\n` : "") +
    (chartPattern.sl !== null ? `  SL pattern : ${chartPattern.sl.toFixed(4)}\n` : "") +
    (chartPattern.tp !== null ? `  TP pattern : ${chartPattern.tp.toFixed(4)}\n` : "") +
    `  ${chartPattern.note}`;

  const indicatorsTxt =
    `📈 Indicateurs\n` +
    `  MTF : 1h ${trend1h} | 4h ${trend4h}\n` +
    `  ADX(14) : ${adx.toFixed(1)}\n` +
    `  MACD histogramme : ${macd.histogram.toFixed(4)} (${macd.histogram > macd.prevHistogram ? "en hausse" : "en baisse"})\n` +
    `  Bollinger : bas ${bb.lower.toFixed(4)} / milieu ${bb.middle.toFixed(4)} / haut ${bb.upper.toFixed(4)}\n` +
    `  Stochastique : ${stoch.toFixed(1)}\n` +
    `  ATR(14) : ${atr.toFixed(4)}`;

  return {
    text:
      `Prix actuel : ${price.toFixed(4)}\n\n` +
      `Tendance 15m : ${trend}\nDernière bougie : ${pattern}\nRSI(14) : ${rsiVal.toFixed(1)}\n\n` +
      `${cpTxt}\n\n${indicatorsTxt}\n\n` +
      `Support proche : ${nearestSupport ? nearestSupport.toFixed(4) : "non détecté"}\n` +
      `Résistance proche : ${nearestResistance ? nearestResistance.toFixed(4) : "non détectée"}\n\n` +
      `Fibonacci :\n${fibTxt}\n\n` +
      `Raison : ${reasons.join("; ")}\n\n${slTp}\n\n${positionTxt}\n\n` +
      `⚠️ Analyse automatisée, pas un conseil financier.`,
    signal,
  };
}

// ==================== MAIN ====================

async function main() {
  const state = loadState();

  for (const symbol of SYMBOLS) {
    try {
      const analysis = await buildAnalysis(symbol);
      const previous = state[symbol];
      console.log(`${symbol}: ${analysis.signal} (précédent: ${previous || "aucun"})`);

      if (analysis.signal !== "WAIT" && analysis.signal !== previous) {
        await sendTelegram(formatMessage(symbol, analysis));
        console.log(`  -> Notification envoyée`);
      }
      state[symbol] = analysis.signal;
    } catch (e) {
      console.error(`Erreur pour ${symbol}:`, e.message);
    }
  }

  saveState(state);
}

main().catch((e) => {
  console.error("Erreur fatale:", e);
  process.exit(1);
});
