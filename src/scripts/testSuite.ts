import { BondingCurveCalculator } from '../services/bondingCurve';
import { FilterEngine } from '../services/filterEngine';
import { PositionSizer } from '../services/positionSizer';
import { RugCheckService } from '../services/rugCheck';
import { SocialSentimentAnalyzer } from '../services/socialSentiment';
import { SQLiteMemory } from '../services/sqliteMemory';
import { Backtester } from '../services/backtester';
import { AIBrain } from '../services/aiBrain';
import { loadConfig } from '../config';

import { StrategyManager } from '../strategies';

async function runTests() {
  console.log('--- RUNNING PUMPFUN TRADING AGENT VERIFICATION TESTS ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // 1. BondingCurveCalculator Spot Price Test
  const spotPrice1 = BondingCurveCalculator.calculateSpotPriceSol(30 * 1e9, 1073000000 * 1e6);
  const spotPrice2 = BondingCurveCalculator.calculateSpotPriceSol(30, 1073000000);
  assert(Math.abs(spotPrice1 - spotPrice2) < 1e-12, 'Spot price handles both lamport and SOL units consistently');
  assert(spotPrice1 > 0 && spotPrice1 < 0.0001, 'Spot price is in reasonable SOL range');

  // 2. FilterEngine Blacklist Whole-Word Test
  const config = loadConfig();
  const filterEngine = new FilterEngine(config);
  
  const tokenGretest: any = {
    mint: 'So11111111111111111111111111111111111111112',
    name: 'The Greatest Token',
    symbol: 'GREATEST',
    initialBuy: 0.1,
    twitter: 'https://x.com/greatest'
  };
  const resGreatest = filterEngine.evaluateToken(tokenGretest);
  assert(resGreatest.passed, 'FilterEngine allows "GREATEST" without false-flagging on "test"');

  const tokenScam: any = {
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Scam Token',
    symbol: 'SCAM',
    initialBuy: 0.1
  };
  const resScam = filterEngine.evaluateToken(tokenScam);
  assert(!resScam.passed, 'FilterEngine rejects "SCAM" keyword');

  // 3. PositionSizer Scoring Test
  const sizer = new PositionSizer(config);
  const safeSize = sizer.calculateTradeSize(80, 60, 90, 1.0); // devRep 90
  const riskySize = sizer.calculateTradeSize(80, 60, 20, 1.0); // devRep 20
  assert(safeSize > riskySize, `Safe dev reputation gets higher allocation (${safeSize} SOL vs ${riskySize} SOL)`);

  // 4. Social Sentiment Analyzer
  const socialAnalyzer = new SocialSentimentAnalyzer();
  const sentiment = socialAnalyzer.analyzeToken({
    signature: 'sig',
    mint: 'mint12345678901234567890123456789012',
    traderPublicKey: 'dev12345678901234567890123456789012',
    txType: 'create',
    initialBuy: 0.5,
    name: 'Pepe AI Agent',
    symbol: 'PEPEAI',
    uri: 'https://ipfs.io/ipfs/test',
    twitter: 'https://x.com/pepeai',
    telegram: 'https://t.me/pepeai',
    timestamp: Date.now()
  });
  assert(sentiment.viralityScore >= 60, `Viral meme AI token scores high virality (${sentiment.viralityScore}/100)`);

  // 5. SQLiteMemory & Backtester
  const memory = new SQLiteMemory();
  await memory.init();
  const backtester = new Backtester(memory);
  const btRes = await backtester.runBacktest(1.0, 0.01, 50, -20);
  assert(btRes !== null && typeof btRes.winRate === 'number', 'Backtester runs cleanly on SQLite memory');

  // 6. AIBrain Decision Engine Test
  const aiBrain = new AIBrain(memory);
  const aiDecision = await aiBrain.evaluateOpportunity(
    {
      signature: 'test_sig_123',
      mint: 'So11111111111111111111111111111111111111112',
      traderPublicKey: 'dev11111111111111111111111111111111111111112',
      txType: 'create',
      initialBuy: 0.25,
      name: 'Quantum AI Agent',
      symbol: 'QAIA',
      uri: 'https://ipfs.io/ipfs/test',
      timestamp: Date.now()
    },
    {
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'QAIA',
      name: 'Quantum AI Agent',
      category: 'TECH_AI',
      researchScore: 85,
      summary: 'High-conviction AI token',
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      hasGithubOrDocs: true,
      narrativeTags: ['AI', 'QUANTUM'],
      categoryMomentumScore: 90,
      verdict: 'STRONG_BUY'
    },
    'SNIPER',
    10,
    0.15
  );
  assert(typeof aiDecision.shouldBuy === 'boolean', 'AIBrain returns structured typed shouldBuy decision');
  assert(aiDecision.confidenceScore > 0, `AIBrain provides calibrated confidence score (${aiDecision.confidenceScore}/100)`);
  assert(aiDecision.convictionTier !== undefined, `AIBrain assigns conviction tier (${aiDecision.convictionTier})`);
  assert(typeof aiDecision.suggestedTpPercent === 'number', `AIBrain suggests take profit target (+${aiDecision.suggestedTpPercent}%)`);

  // 7. BondingCurve Progress Calculation (Lamports and SOL formats)
  const prog0 = BondingCurveCalculator.calculateProgress(30);
  const prog50 = BondingCurveCalculator.calculateProgress(57.5);
  const prog100 = BondingCurveCalculator.calculateProgress(85);
  const progLamport = BondingCurveCalculator.calculateProgress(57.5 * 1e9);
  assert(prog0 === 0, 'Bonding curve progress is 0% at 30 SOL base');
  assert(Math.abs(prog50 - 50) < 0.1, `Bonding curve progress is 50% at 57.5 SOL (${prog50.toFixed(1)}%)`);
  assert(Math.abs(prog100 - 100) < 0.1, `Bonding curve progress is 100% at 85 SOL (${prog100.toFixed(1)}%)`);
  assert(Math.abs(progLamport - 50) < 0.1, 'Bonding curve progress handles lamports format consistently');

  // 8. StrategyManager: Rejection of Dead / Waste Coins at Launch
  const strategyManager = new StrategyManager('MOMENTUM_SCALP');
  const deadToken: any = {
    signature: 'sig_dead',
    mint: 'DeadCoin11111111111111111111111111111111111',
    traderPublicKey: 'dev_dead',
    txType: 'create',
    initialBuy: 0.0019, // typical pumpfun dead coin dev buy
    name: 'Waste Coin',
    symbol: 'WASTE',
    timestamp: Date.now()
  };
  const evalDead = strategyManager.evaluateNewToken(deadToken, 85);
  assert(!evalDead.shouldBuy, 'MOMENTUM_SCALP rejects blind buying dead token at block 0');

  // 9. StrategyManager: Triggering On Confirmed Live Momentum
  const tradeTick1: any = {
    mint: 'MovingCoin1111111111111111111111111111111',
    traderPublicKey: 'buyer1',
    txType: 'buy',
    solAmount: 0.15,
    timestamp: Date.now()
  };
  const tradeTick2: any = {
    mint: 'MovingCoin1111111111111111111111111111111',
    traderPublicKey: 'buyer2',
    txType: 'buy',
    solAmount: 0.20,
    timestamp: Date.now()
  };
  const tradeTick3: any = {
    mint: 'MovingCoin1111111111111111111111111111111',
    traderPublicKey: 'buyer3',
    txType: 'buy',
    solAmount: 0.15,
    timestamp: Date.now()
  };
  strategyManager.evaluateTradeTick(tradeTick1);
  strategyManager.evaluateTradeTick(tradeTick2);
  const evalMoving = strategyManager.evaluateTradeTick(tradeTick3);
  assert(evalMoving.shouldBuy, `MOMENTUM_SCALP triggers on confirmed moving coin (${evalMoving.reason})`);

  console.log(`\nTEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
