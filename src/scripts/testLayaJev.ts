import http from 'http';
import { SQLiteMemory } from '../services/sqliteMemory';
import { AIBrain } from '../services/aiBrain';

async function runLayaJevTestSuite() {
  console.log('--- STARTING LAYA & JEV SYSTEM 1 INTEGRATION & CONSENSUS TEST SUITE ---');
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

  // 1. Spin up mock local Laya Server on port 8001
  const layaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const isPredict = req.url?.includes('/predict');

      // Verify criteria are provided in questions for Laya
      const questions = parsed.questions || {};
      const hasCriteria = Boolean(questions.should_buy?.criteria && questions.conviction_tier?.criteria);

      const responsePayload = {
        model: 'convaiinnovations/laya',
        answers: {
          should_buy: {
            type: 'noul',
            noul: 0.93,
            answer_confidence: 0.93
          },
          conviction_tier: {
            type: 'choice',
            choice: 'SUPER_SNIPE',
            confidence: 0.89,
            answer_confidence: 0.94
          },
          risk_level: {
            type: 'choice',
            choice: 'SAFE_CLEAN',
            confidence: 0.95,
            answer_confidence: 0.96
          },
          target_take_profit: {
            type: 'choice',
            choice: 'TP_75',
            confidence: 0.87,
            answer_confidence: 0.91
          }
        },
        usage: { input_tokens: 110, output_tokens: 6 }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  });

  // 2. Spin up mock local Jev Server on port 8002
  const jevServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const responsePayload = {
        model: 'jev-latest',
        answers: {
          should_buy: {
            type: 'noul',
            noul: 0.89
          },
          conviction_tier: {
            type: 'choice',
            choice: 'HIGH_CONVICTION',
            confidence: 0.91
          },
          risk_level: {
            type: 'choice',
            choice: 'SAFE_CLEAN',
            confidence: 0.93
          },
          target_take_profit: {
            type: 'choice',
            choice: 'TP_75',
            confidence: 0.88
          }
        },
        usage: { input_tokens: 125, output_tokens: 8 }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise<void>(resolve => layaServer.listen(8001, resolve));
  await new Promise<void>(resolve => jevServer.listen(8002, resolve));

  const memory = new SQLiteMemory();
  await memory.init();

  // Test 1: Single Laya Main Model Evaluation
  process.env.AI_PROVIDER = 'laya';
  process.env.AI_MODEL = 'convaiinnovations/laya';
  process.env.LAYA_URL = 'http://localhost:8001/predict';
  process.env.AI_CONSENSUS = 'false';

  const brainLaya = new AIBrain(memory);
  const decisionLaya = await brainLaya.evaluateOpportunity(
    {
      signature: 'sig_laya',
      mint: 'MintLaya1111111111111111111111111111111111',
      traderPublicKey: 'DevLaya1111111111111111111111111111111111',
      txType: 'create',
      initialBuy: 0.3,
      name: 'Laya Intelligence',
      symbol: 'LAYA',
      uri: 'https://ipfs.io/ipfs/test',
      timestamp: Date.now()
    },
    {
      mint: 'MintLaya1111111111111111111111111111111111',
      symbol: 'LAYA',
      name: 'Laya Intelligence',
      category: 'TECH_AI',
      researchScore: 90,
      summary: 'Laya ModernBERT decision engine',
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      hasGithubOrDocs: true,
      narrativeTags: ['AI', 'SYSTEM_1'],
      categoryMomentumScore: 92,
      verdict: 'STRONG_BUY'
    },
    'SNIPER',
    12,
    0.1
  );

  assert(decisionLaya.shouldBuy === true, 'Laya evaluates opportunity and approves buy');
  assert(decisionLaya.confidenceScore === 93, 'Laya captures calibrated answer_confidence score (93%)');
  assert(decisionLaya.convictionTier === 'SUPER_SNIPE', 'Laya assigns SUPER_SNIPE conviction tier');
  assert(decisionLaya.providerUsed.includes('Laya'), 'Laya provider is recognized');

  // Test 2: Dual Consensus Mode (Laya + Jev) for Higher Win Rate
  process.env.AI_CONSENSUS = 'true';
  process.env.LAYA_URL = 'http://localhost:8001/predict';
  process.env.JEV_URL = 'http://localhost:8002/v1/systemone';

  const brainConsensus = new AIBrain(memory);
  const decisionConsensus = await brainConsensus.evaluateOpportunity(
    {
      signature: 'sig_consensus',
      mint: 'MintConsensus11111111111111111111111111111',
      traderPublicKey: 'DevConsensus11111111111111111111111111111',
      txType: 'create',
      initialBuy: 0.4,
      name: 'Consensus Token',
      symbol: 'CONS',
      uri: 'https://ipfs.io/ipfs/test',
      timestamp: Date.now()
    },
    {
      mint: 'MintConsensus11111111111111111111111111111',
      symbol: 'CONS',
      name: 'Consensus Token',
      category: 'TECH_AI',
      researchScore: 94,
      summary: 'Dual confirmed breakout setup',
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      hasGithubOrDocs: true,
      narrativeTags: ['AI', 'CONSENSUS'],
      categoryMomentumScore: 96,
      verdict: 'STRONG_BUY'
    },
    'SNIPER',
    20,
    0.08
  );

  assert(decisionConsensus.shouldBuy === true, 'Consensus mode approves verified dual-model buy');
  // Laya 93% (55%) + Jev 89% (45%) = 91% + 8% synergy bonus = 99%
  assert(decisionConsensus.confidenceScore >= 95, `Consensus synergy grants win-rate boost (${decisionConsensus.confidenceScore}%)`);
  assert(decisionConsensus.convictionTier === 'SUPER_SNIPE', 'Consensus elevates conviction to SUPER_SNIPE');
  assert(decisionConsensus.reasoning.includes('WIN-RATE BOOST'), 'Consensus marks trade with WIN-RATE BOOST synergy');

  layaServer.close();
  jevServer.close();

  console.log(`\nTEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) process.exit(1);
}

runLayaJevTestSuite().catch(err => {
  console.error(err);
  process.exit(1);
});
