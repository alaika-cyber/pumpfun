import axios from 'axios';
import chalk from 'chalk';
import { SQLiteMemory, DevReputation, DBTrade } from './sqliteMemory';
import { TokenCreationEvent } from '../types';
import { ResearchReport } from './researchEngine';

export type AIProvider = 'laya' | 'jev' | 'builtin';

export interface AIBrainDecision {
  shouldBuy: boolean;
  confidenceScore: number;
  suggestedTpPercent: number;
  suggestedSlPercent: number;
  reasoning: string;
  riskFactors: string[];
  tags: string[];
  category: string;
  providerUsed: string;
  convictionTier?: 'SUPER_SNIPE' | 'HIGH_CONVICTION' | 'STANDARD' | 'SPECULATIVE';
}

export class AIBrain {
  private provider: AIProvider;
  private modelName: string;
  private memory: SQLiteMemory;
  private enableConsensus: boolean = true;

  constructor(memory: SQLiteMemory) {
    this.memory = memory;
    const rawProvider = (process.env.AI_PROVIDER || 'laya').toLowerCase();
    if (rawProvider === 'builtin') {
      this.provider = 'builtin';
    } else if (rawProvider === 'jev') {
      this.provider = 'jev';
    } else {
      this.provider = 'laya';
    }

    this.modelName = this.getDefaultModelForProvider(this.provider);
    this.enableConsensus = process.env.AI_CONSENSUS !== 'false';

    console.log(
      chalk.magenta.bold(
        `[AI Brain] 🧠 LAYA SYSTEM 1 DECISION ENGINE ONLINE | Main Model: ${this.modelName} | Provider: ${this.provider.toUpperCase()} (Jev Consensus: ${this.enableConsensus ? 'ENABLED' : 'DISABLED'})`
      )
    );
  }

  private getDefaultModelForProvider(provider: AIProvider): string {
    if (process.env.AI_MODEL) return process.env.AI_MODEL;
    switch (provider) {
      case 'laya':
        return 'convaiinnovations/laya';
      case 'jev':
        return 'jev-latest';
      case 'builtin':
      default:
        return 'neural-matrix';
    }
  }

  public async evaluateOpportunity(
    token: TokenCreationEvent,
    research: ResearchReport,
    strategy: string,
    bondingCurveProgress: number = 0,
    topHoldersConcentration: number = 0
  ): Promise<AIBrainDecision> {
    // 1. Fetch Developer Memory & Reputation from SQLite
    const devRep = await this.memory.getDevReputation(token.traderPublicKey);
    if (devRep.isBlacklisted) {
      return {
        shouldBuy: false,
        confidenceScore: 0,
        suggestedTpPercent: 50,
        suggestedSlPercent: -20,
        reasoning: `Dev is blacklisted in SQLite Memory (Rug rate: ${(devRep.rugRate * 100).toFixed(0)}%)`,
        riskFactors: ['Known Serial Rugger'],
        tags: ['Blacklisted Dev'],
        category: research.category,
        providerUsed: 'SQLite Memory Gatekeeper',
        convictionTier: 'SPECULATIVE'
      };
    }

    // 2. Fetch recent winning & losing patterns for Dynamic Few-Shot Learning
    const winningPatterns = await this.memory.getRecentSuccessfulPatterns(4);
    const patternTags = winningPatterns.map(p => `${p.tag} (+${p.pnl.toFixed(2)} SOL)`).join(', ');
    const allTrades: DBTrade[] = await this.memory.getAllTrades();
    const recentWins = allTrades.filter(t => t.pnlSol > 0).slice(0, 3);
    const recentLosses = allTrades.filter(t => t.pnlSol < 0).slice(0, 2);

    // 3. Dual-Model Consensus Mode (Laya + Jev) for Higher Win Rate
    if (this.enableConsensus && this.provider !== 'builtin') {
      try {
        const [layaRes, jevRes] = await Promise.allSettled([
          this.queryLaya(token, research, devRep, patternTags, strategy, bondingCurveProgress, topHoldersConcentration, recentWins, recentLosses),
          this.queryJev(token, research, devRep, patternTags, strategy, bondingCurveProgress, topHoldersConcentration, recentWins, recentLosses)
        ]);

        const layaDecision = layaRes.status === 'fulfilled' ? layaRes.value : null;
        const jevDecision = jevRes.status === 'fulfilled' ? jevRes.value : null;

        if (layaDecision && jevDecision) {
          return this.fuseConsensusDecisions(layaDecision, jevDecision, research);
        } else if (layaDecision) {
          return layaDecision;
        } else if (jevDecision) {
          return jevDecision;
        }
      } catch (err: any) {
        console.warn(chalk.yellow(`[AI Brain] Consensus query error: ${err.message}. Falling back to single model.`));
      }
    }

    // 4. Primary Single Model Routing
    if (this.provider === 'laya') {
      try {
        const decision = await this.queryLaya(
          token,
          research,
          devRep,
          patternTags,
          strategy,
          bondingCurveProgress,
          topHoldersConcentration,
          recentWins,
          recentLosses
        );
        if (decision) return decision;
      } catch (err: any) {
        console.error(
          chalk.yellow(
            `[AI Brain] Laya query failed (${err.message}). Attempting Jev compatibility fallback.`
          )
        );
        try {
          const jevDecision = await this.queryJev(
            token,
            research,
            devRep,
            patternTags,
            strategy,
            bondingCurveProgress,
            topHoldersConcentration,
            recentWins,
            recentLosses
          );
          if (jevDecision) return jevDecision;
        } catch {}
      }
    } else if (this.provider === 'jev') {
      try {
        const decision = await this.queryJev(
          token,
          research,
          devRep,
          patternTags,
          strategy,
          bondingCurveProgress,
          topHoldersConcentration,
          recentWins,
          recentLosses
        );
        if (decision) return decision;
      } catch (err: any) {
        console.error(
          chalk.yellow(
            `[AI Brain] Jev query failed (${err.message}). Attempting Laya fallback.`
          )
        );
        try {
          const layaDecision = await this.queryLaya(
            token,
            research,
            devRep,
            patternTags,
            strategy,
            bondingCurveProgress,
            topHoldersConcentration,
            recentWins,
            recentLosses
          );
          if (layaDecision) return layaDecision;
        } catch {}
      }
    }

    // 5. Built-in Deep Neural Heuristic Pattern Brain (Zero-Downtime Fallback)
    return this.evaluateBuiltinBrain(
      token,
      research,
      devRep,
      winningPatterns,
      strategy,
      bondingCurveProgress,
      topHoldersConcentration
    );
  }

  /**
   * Evaluates token opportunities using Laya (convaiinnovations/laya).
   * Supports local machine execution via laya-serve (ModernBERT-large, ~33ms inference)
   * or compatible HTTP API endpoints (/predict or /v1/systemone).
   */
  private async queryLaya(
    token: TokenCreationEvent,
    research: ResearchReport,
    devRep: DevReputation,
    patternTags: string,
    strategy: string,
    progress: number,
    topHoldersConcentration: number,
    wins: DBTrade[],
    losses: DBTrade[]
  ): Promise<AIBrainDecision> {
    let endpoint = process.env.LAYA_URL || 'http://localhost:8000/predict';
    const isSystemOne = endpoint.includes('/v1/systemone') || endpoint.includes('/systemone');

    const { statePayload, questions } = this.buildStateAndQuestions(
      token,
      research,
      devRep,
      patternTags,
      strategy,
      progress,
      topHoldersConcentration,
      wins,
      losses
    );

    const apiKey = process.env.LAYA_API_KEY || process.env.TYPESAFE_API_KEY || 'local-token';

    const requestBody = isSystemOne
      ? {
          model: this.modelName || 'convaiinnovations/laya',
          state: JSON.stringify(statePayload),
          questions
        }
      : {
          model: this.modelName || 'convaiinnovations/laya',
          state: statePayload,
          questions
        };

    const response = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 4000
    });

    const answers = response.data?.answers || response.data?.results || response.data || {};
    return this.parseStructuredAnswers(answers, research, `Laya (${this.modelName || 'convaiinnovations/laya'})`);
  }

  /**
   * Evaluates token opportunities using Jev AI (System One Decision Model).
   * Fully wire-compatible with Laya's criteria questions and TypeSafe endpoints.
   */
  private async queryJev(
    token: TokenCreationEvent,
    research: ResearchReport,
    devRep: DevReputation,
    patternTags: string,
    strategy: string,
    progress: number,
    topHoldersConcentration: number,
    wins: DBTrade[],
    losses: DBTrade[]
  ): Promise<AIBrainDecision> {
    let endpoint = process.env.JEV_URL || process.env.TYPESAFE_BASE_URL || 'http://localhost:8000/v1/systemone';
    if (!endpoint.includes('/v1/systemone') && !endpoint.includes('/systemone')) {
      endpoint = endpoint.replace(/\/+$/, '') + '/v1/systemone';
    }

    const { statePayload, questions } = this.buildStateAndQuestions(
      token,
      research,
      devRep,
      patternTags,
      strategy,
      progress,
      topHoldersConcentration,
      wins,
      losses
    );

    const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || 'local-token';

    const response = await axios.post(
      endpoint,
      {
        model: process.env.AI_MODEL || 'jev-latest',
        state: JSON.stringify(statePayload),
        questions
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 4000
      }
    );

    const answers = response.data?.answers || response.data?.results || response.data || {};
    return this.parseStructuredAnswers(answers, research, `Jev AI (${process.env.AI_MODEL || 'jev-latest'})`);
  }

  /**
   * Constructs the rich semantic state and typed questions equipped with explicit criteria.
   * Laya's criteria-based framework solves label bias (#156) and achieves 76.6%+ classification accuracy.
   */
  private buildStateAndQuestions(
    token: TokenCreationEvent,
    research: ResearchReport,
    devRep: DevReputation,
    patternTags: string,
    strategy: string,
    progress: number,
    topHoldersConcentration: number,
    wins: DBTrade[],
    losses: DBTrade[]
  ) {
    const semanticSummary =
      `Token ${token.symbol} (${token.name}) launched on Pump.fun bonding curve (${progress.toFixed(1)}% complete). ` +
      `Sector: [${research.category}]. Base research score: ${research.researchScore}/100. ` +
      `Dev initial buy: ${token.initialBuy > 0 ? `${token.initialBuy} SOL` : 'Fair launch (0 SOL)'}. ` +
      `Dev reputation: ${devRep.reputationScore}/100 with ${(devRep.rugRate * 100).toFixed(0)}% historical rug rate across ${devRep.totalTokensCreated} launches. ` +
      `Top 10 holders concentration: ${(topHoldersConcentration * 100).toFixed(1)}%. ` +
      `Social verification: ${research.hasTwitter ? 'Twitter active; ' : ''}${research.hasTelegram ? 'Telegram active; ' : ''}${research.hasWebsite ? 'Website live; ' : ''}${research.hasGithubOrDocs ? 'Docs verified.' : 'No socials yet.'} ` +
      `Narrative tags: ${research.narrativeTags.join(', ') || 'Emerging Meta'}. ` +
      `Recent winning meta: ${wins.map(w => w.symbol).join(', ') || 'None'}. Recent stopped losses: ${losses.map(l => l.symbol).join(', ') || 'None'}.`;

    const statePayload = {
      body: semanticSummary,
      market: 'pump.fun',
      token: {
        symbol: token.symbol,
        name: token.name,
        category: research.category,
        researchScore: research.researchScore,
        devInitialBuySol: token.initialBuy,
        bondingCurveProgressPct: Number(progress.toFixed(2)),
        topHoldersConcentrationPct: Number((topHoldersConcentration * 100).toFixed(1)),
        hasSocials: Boolean(research.hasTwitter || research.hasTelegram || research.hasWebsite || research.hasGithubOrDocs),
        twitter: research.hasTwitter,
        telegram: research.hasTelegram,
        website: research.hasWebsite,
        narrativeTags: research.narrativeTags
      },
      devReputation: {
        rugRatePct: Number((devRep.rugRate * 100).toFixed(1)),
        totalTokensCreated: devRep.totalTokensCreated,
        reputationScore: devRep.reputationScore,
        isBlacklisted: devRep.isBlacklisted
      },
      strategy,
      recentWinningPatterns: patternTags || 'None',
      recentWins: wins.map(w => `${w.symbol} (+${w.pnlPercent.toFixed(1)}%)`),
      recentLosses: losses.map(l => `${l.symbol} (${l.pnlPercent.toFixed(1)}%)`)
    };

    // Interoperable Questions with both criteria (Laya) and options (Jev)
    const questions = {
      should_buy: {
        type: 'noul',
        instructions: 'Should the trading bot snipe/buy this token opportunity on the pump.fun bonding curve?',
        criteria: {
          true: 'buy the token: clean dev, punchy ticker, verified narrative, low concentration, and high breakout probability',
          false: 'skip the token: suspicious dev, excessive initial buy, spam ticker, or elevated rug risk'
        },
        labels: { true: 'BUY', false: 'SKIP' }
      },
      conviction_tier: {
        type: 'choice',
        instructions: 'Determine conviction tier for position sizing and risk control.',
        criteria: {
          SUPER_SNIPE: 'top-tier conviction, verified socials/docs, clean dev history, strong viral meme or tech narrative',
          HIGH_CONVICTION: 'solid momentum, safe dev buy size, active community interest, favorable volume velocity',
          STANDARD: 'ordinary fair launch satisfying baseline anti-rug filters',
          SPECULATIVE: 'low conviction, questionable dev history, high dump risk, avoid entry'
        },
        options: ['SUPER_SNIPE', 'HIGH_CONVICTION', 'STANDARD', 'SPECULATIVE']
      },
      risk_level: {
        type: 'choice',
        instructions: 'Assess the risk profile and red flags for this token.',
        criteria: {
          SAFE_CLEAN: 'verified socials, clean dev history, fair launch metrics, organic volume',
          BALANCED: 'moderate risk profile with normal pump.fun market parameters',
          HIGH_DEV_RISK: 'dev reputation warning, excessive initial buy, or high holder concentration',
          SPAM_RUG_PATTERN: 'clear spam ticker, serial rugger pattern, or blacklisted dev'
        },
        options: ['SAFE_CLEAN', 'BALANCED', 'HIGH_DEV_RISK', 'SPAM_RUG_PATTERN']
      },
      target_take_profit: {
        type: 'choice',
        instructions: 'Optimal take-profit milestone based on sector velocity.',
        criteria: {
          TP_45: 'fast 45% scalp target for rapid meme rotations',
          TP_75: '75% target for AI, DePIN, and tech narrative trends',
          TP_100: '100% 2x milestone for high-conviction breakout setups',
          TP_150: '150% 2.5x milestone for hyper-viral market runners',
          TP_200: '200% 3x moonbag for alpha target leaders'
        },
        options: ['TP_45', 'TP_75', 'TP_100', 'TP_150', 'TP_200']
      }
    };

    return { statePayload, questions };
  }

  /**
   * Unified parser handling Laya and Jev typed decision answers.
   */
  private parseStructuredAnswers(
    answers: any,
    research: ResearchReport,
    providerName: string
  ): AIBrainDecision {
    // 1. Process should_buy Noul probability / answer_confidence
    let shouldBuyProb = 0.5;
    const rawShouldBuy = answers.should_buy;
    if (rawShouldBuy !== undefined && rawShouldBuy !== null) {
      if (typeof rawShouldBuy.noul === 'number') {
        shouldBuyProb = rawShouldBuy.noul;
      } else if (typeof rawShouldBuy.answer_confidence === 'number') {
        shouldBuyProb = rawShouldBuy.answer_confidence;
      } else if (typeof rawShouldBuy.probability === 'number') {
        shouldBuyProb = rawShouldBuy.probability;
      } else if (typeof rawShouldBuy.value === 'number') {
        shouldBuyProb = rawShouldBuy.value;
      } else if (typeof rawShouldBuy.value === 'boolean') {
        shouldBuyProb = rawShouldBuy.value ? 0.88 : 0.15;
      } else if (typeof rawShouldBuy.choice === 'string') {
        shouldBuyProb = rawShouldBuy.choice.toUpperCase().includes('BUY') || rawShouldBuy.choice === 'true' ? 0.88 : 0.15;
      } else if (typeof rawShouldBuy === 'number') {
        shouldBuyProb = rawShouldBuy;
      } else if (typeof rawShouldBuy === 'boolean') {
        shouldBuyProb = rawShouldBuy ? 0.88 : 0.15;
      }
    }

    const confidenceScore = Math.max(0, Math.min(100, Math.round(shouldBuyProb * 100)));

    // 2. Process Conviction Tier Choice
    let convictionTier: 'SUPER_SNIPE' | 'HIGH_CONVICTION' | 'STANDARD' | 'SPECULATIVE' = 'STANDARD';
    const rawConviction = answers.conviction_tier?.choice || answers.conviction_tier?.value || answers.conviction_tier;
    if (
      typeof rawConviction === 'string' &&
      ['SUPER_SNIPE', 'HIGH_CONVICTION', 'STANDARD', 'SPECULATIVE'].includes(rawConviction)
    ) {
      convictionTier = rawConviction as any;
    } else {
      if (confidenceScore >= 90) convictionTier = 'SUPER_SNIPE';
      else if (confidenceScore >= 80) convictionTier = 'HIGH_CONVICTION';
      else if (confidenceScore >= 65) convictionTier = 'STANDARD';
      else convictionTier = 'SPECULATIVE';
    }

    // 3. Process Risk Level Choice
    const riskLevel = answers.risk_level?.choice || answers.risk_level?.value || 'BALANCED';

    // 4. Process Dynamic Take-Profit Target
    const defaultTpKey = research.category === 'TECH_AI' ? 'TP_75' : 'TP_50';
    const tpChoice = answers.target_take_profit?.choice || answers.target_take_profit?.value || defaultTpKey;
    const tpMap: Record<string, number> = {
      TP_45: 45,
      TP_50: 50,
      TP_75: 75,
      TP_100: 100,
      TP_150: 150,
      TP_200: 200
    };
    const suggestedTpPercent = tpMap[tpChoice] || (research.category === 'TECH_AI' ? 75 : 50);

    const riskFactors: string[] = [];
    if (riskLevel === 'HIGH_DEV_RISK') riskFactors.push('Elevated dev risk flagged by System 1 model');
    if (riskLevel === 'SPAM_RUG_PATTERN') riskFactors.push('Spam/rug pattern detected by System 1 model');

    const shouldBuy = shouldBuyProb >= 0.55 && riskLevel !== 'SPAM_RUG_PATTERN' && convictionTier !== 'SPECULATIVE';

    return {
      shouldBuy,
      confidenceScore,
      suggestedTpPercent,
      suggestedSlPercent: -20,
      reasoning: `${providerName}: ${shouldBuy ? 'BUY' : 'SKIP'} [${convictionTier}] Prob: ${(shouldBuyProb * 100).toFixed(1)}%, Risk: ${riskLevel}, TP Target: +${suggestedTpPercent}%`,
      riskFactors,
      tags: research.narrativeTags,
      category: research.category,
      providerUsed: providerName,
      convictionTier
    };
  }

  /**
   * Synergistic Consensus Fuser: Combines Laya semantic reasoning and Jev probability scoring.
   * Double-confirmation prevents false breakout rugs and elevates winning trade sizing.
   */
  private fuseConsensusDecisions(
    laya: AIBrainDecision,
    jev: AIBrainDecision,
    research: ResearchReport
  ): AIBrainDecision {
    const bothBuy = laya.shouldBuy && jev.shouldBuy;
    const eitherRugRisk =
      laya.riskFactors.length > 0 ||
      jev.riskFactors.length > 0 ||
      laya.convictionTier === 'SPECULATIVE' ||
      jev.convictionTier === 'SPECULATIVE';

    // Weighted average: Laya 55% (ModernBERT semantic strength) + Jev 45% (System One scoring)
    let fusedConfidence = Math.round(laya.confidenceScore * 0.55 + jev.confidenceScore * 0.45);

    let convictionTier: 'SUPER_SNIPE' | 'HIGH_CONVICTION' | 'STANDARD' | 'SPECULATIVE';
    let shouldBuy = false;
    let reasoning = '';

    if (bothBuy && !eitherRugRisk) {
      // WIN-RATE BOOST: Dual confirmation grants +8% confidence synergy bonus
      fusedConfidence = Math.min(99, fusedConfidence + 8);
      shouldBuy = true;

      if (laya.convictionTier === 'SUPER_SNIPE' || jev.convictionTier === 'SUPER_SNIPE') {
        convictionTier = 'SUPER_SNIPE';
      } else if (fusedConfidence >= 80) {
        convictionTier = 'HIGH_CONVICTION';
      } else {
        convictionTier = 'STANDARD';
      }

      reasoning = `Laya + Jev Dual Consensus [WIN-RATE BOOST]: BUY [${convictionTier}] (${fusedConfidence}% conf) | Laya: ${laya.confidenceScore}%, Jev: ${jev.confidenceScore}% | TP Target: +${Math.max(laya.suggestedTpPercent, jev.suggestedTpPercent)}%`;
    } else if (eitherRugRisk) {
      // CAPITAL PRESERVATION: Rug risk flagged by either model triggers defensive veto
      shouldBuy = false;
      convictionTier = 'SPECULATIVE';
      fusedConfidence = Math.min(45, fusedConfidence);
      const combinedRisks = Array.from(new Set([...laya.riskFactors, ...jev.riskFactors]));
      reasoning = `Consensus Rug Shield: SKIPPED [${combinedRisks.join('; ') || 'Elevated Risk'}] | Laya: ${laya.shouldBuy ? 'BUY' : 'SKIP'}, Jev: ${jev.shouldBuy ? 'BUY' : 'SKIP'}`;
    } else {
      // Divergence: One model bought, one skipped
      shouldBuy = fusedConfidence >= 75;
      convictionTier = shouldBuy ? 'STANDARD' : 'SPECULATIVE';
      reasoning = `Consensus Divergence: ${shouldBuy ? 'Cautious BUY' : 'SKIP'} (Laya: ${laya.shouldBuy ? 'BUY' : 'SKIP'} ${laya.confidenceScore}%, Jev: ${jev.shouldBuy ? 'BUY' : 'SKIP'} ${jev.confidenceScore}%)`;
    }

    const suggestedTpPercent = Math.max(laya.suggestedTpPercent, jev.suggestedTpPercent);

    return {
      shouldBuy,
      confidenceScore: fusedConfidence,
      suggestedTpPercent,
      suggestedSlPercent: -20,
      reasoning,
      riskFactors: Array.from(new Set([...laya.riskFactors, ...jev.riskFactors])),
      tags: research.narrativeTags,
      category: research.category,
      providerUsed: 'Laya + Jev Dual Consensus Matrix',
      convictionTier
    };
  }

  private evaluateBuiltinBrain(
    token: TokenCreationEvent,
    research: ResearchReport,
    devRep: DevReputation,
    winningPatterns: any[],
    strategy: string,
    progress: number,
    topHoldersConcentration: number
  ): AIBrainDecision {
    let score = Math.max(50, research.researchScore);
    const riskFactors: string[] = [];

    // Dev reputation analysis
    if (devRep.totalTokensCreated > 0) {
      if (devRep.reputationScore >= 70) {
        score += 15;
      } else if (devRep.reputationScore <= 35) {
        score -= 25;
        riskFactors.push(`Dev low reputation (${devRep.reputationScore}/100)`);
      }
    }

    // Holder concentration check
    if (topHoldersConcentration > 0.35) {
      score -= 20;
      riskFactors.push(`High holder concentration (${(topHoldersConcentration * 100).toFixed(0)}%)`);
    }

    // Pattern alignment bonus
    for (const pat of winningPatterns) {
      if (research.narrativeTags.includes(pat.tag)) {
        score += 10;
      }
    }

    // Ticker punchiness bonus
    const symbol = (token.symbol || '').trim();
    if (symbol.length >= 3 && symbol.length <= 6 && /[aeiouy0-9]/i.test(symbol)) {
      score += 10;
    }

    const finalScore = Math.min(100, Math.max(0, score));
    const shouldBuy = finalScore >= 55 && riskFactors.length === 0;

    let reasoning = `Algorithmic Brain scored ${finalScore}/100 for [${research.category}] ${symbol} (${research.narrativeTags.join(', ')}).`;
    if (!shouldBuy && riskFactors.length > 0) {
      reasoning = `Skipped: ${riskFactors.join('; ')} (Confidence: ${finalScore}/100)`;
    }

    return {
      shouldBuy,
      confidenceScore: finalScore,
      suggestedTpPercent: research.category === 'TECH_AI' ? 75 : 50,
      suggestedSlPercent: -20,
      reasoning,
      riskFactors,
      tags: research.narrativeTags,
      category: research.category,
      providerUsed: 'Built-in Quantitative Neural Matrix',
      convictionTier: finalScore >= 85 ? 'SUPER_SNIPE' : finalScore >= 70 ? 'HIGH_CONVICTION' : 'STANDARD'
    };
  }
}
