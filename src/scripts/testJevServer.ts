import http from 'http';
import { SQLiteMemory } from '../services/sqliteMemory';
import { AIBrain } from '../services/aiBrain';

async function testJevServerIntegration() {
  console.log('Testing Jev AI System One local HTTP server integration...');

  // 1. Spin up a mock local Jev System One server on port 8000
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      console.log(`[Mock Local Jev Server] Received evaluation request for state length: ${parsed.state.length}`);
      
      // Return System One typed primitives
      const responsePayload = {
        model: 'jev-latest',
        answers: {
          should_buy: {
            type: 'noul',
            noul: 0.92
          },
          conviction_tier: {
            type: 'choice',
            choice: 'SUPER_SNIPE',
            confidence: 0.94
          },
          risk_level: {
            type: 'choice',
            choice: 'SAFE_CLEAN',
            confidence: 0.95
          },
          target_take_profit: {
            type: 'choice',
            choice: 'TP_75',
            confidence: 0.89
          }
        },
        usage: { input_tokens: 150, output_tokens: 12 }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise<void>(resolve => server.listen(8000, resolve));
  console.log('[Mock Local Jev Server] Listening on http://localhost:8000');

  process.env.AI_PROVIDER = 'jev';
  process.env.JEV_URL = 'http://localhost:8000/v1/systemone';

  const memory = new SQLiteMemory();
  await memory.init();
  const aiBrain = new AIBrain(memory);

  const decision = await aiBrain.evaluateOpportunity(
    {
      signature: 'sig_jev_test',
      mint: 'MintJevTest1111111111111111111111111111111',
      traderPublicKey: 'DevJev11111111111111111111111111111111111',
      txType: 'create',
      initialBuy: 0.5,
      name: 'Alpha Jev Token',
      symbol: 'AJEV',
      uri: 'https://ipfs.io/ipfs/test',
      timestamp: Date.now()
    },
    {
      mint: 'MintJevTest1111111111111111111111111111111',
      symbol: 'AJEV',
      name: 'Alpha Jev Token',
      category: 'TECH_AI',
      researchScore: 92,
      summary: 'Verified high conviction',
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      hasGithubOrDocs: true,
      narrativeTags: ['AI', 'SYSTEM_ONE'],
      categoryMomentumScore: 95,
      verdict: 'STRONG_BUY'
    },
    'SNIPER',
    15,
    0.1
  );

  console.log('Jev AI Decision Result:', decision);

  server.close();

  if (
    decision.shouldBuy === true &&
    decision.confidenceScore === 92 &&
    decision.convictionTier === 'SUPER_SNIPE' &&
    decision.suggestedTpPercent === 75 &&
    decision.providerUsed.includes('Jev AI')
  ) {
    console.log('✅ ALL JEV SYSTEM ONE INTEGRATION TESTS PASSED!');
  } else {
    console.error('❌ Jev AI integration test failed:', decision);
    process.exit(1);
  }
}

testJevServerIntegration().catch(err => {
  console.error(err);
  process.exit(1);
});
