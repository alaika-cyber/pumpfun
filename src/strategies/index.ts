import { TokenCreationEvent, TradeEvent } from '../types';
import { BondingCurveCalculator } from '../services/bondingCurve';

export type StrategyType = 'SNIPER' | 'MIGRATION_KOTH' | 'MOMENTUM_SCALP' | 'COPY_WHALE';

export interface StrategyDecision {
  shouldBuy: boolean;
  reason: string;
  suggestedSizeMultiplier: number;
}

export class StrategyManager {
  private activeStrategy: StrategyType = 'SNIPER';
  private tradeWindowMap: Map<string, { count: number; firstSeen: number; buyVolumeSol: number }> = new Map();

  constructor(defaultStrategy: StrategyType = 'SNIPER') {
    this.activeStrategy = defaultStrategy;
  }

  public getActiveStrategy(): StrategyType {
    return this.activeStrategy;
  }

  public setActiveStrategy(strat: StrategyType): void {
    this.activeStrategy = strat;
  }

  public evaluateNewToken(token: TokenCreationEvent, viralityScore: number): StrategyDecision {
    const initialSol = (token.initialBuy && !isNaN(token.initialBuy) && token.initialBuy > 0)
      ? (token.initialBuy > 1e6 ? token.initialBuy / 1e9 : token.initialBuy)
      : 0;

    switch (this.activeStrategy) {
      case 'SNIPER':
        // Only trigger instant creation snipe if developer committed significant capital (>= 0.75 SOL)
        // Otherwise, send to Candidate Watchlist to confirm real buyer volume & momentum first
        if (initialSol >= 0.75 && viralityScore >= 60) {
          return {
            shouldBuy: true,
            reason: `High-conviction dev launch (${initialSol.toFixed(2)} SOL dev buy, Virality: ${viralityScore}/100)`,
            suggestedSizeMultiplier: 1.1
          };
        }
        return {
          shouldBuy: false,
          reason: `Low initial dev buy (${initialSol.toFixed(3)} SOL) - routing to Momentum Watchlist to verify live trade velocity`,
          suggestedSizeMultiplier: 1.0
        };

      case 'MIGRATION_KOTH':
        return {
          shouldBuy: false,
          reason: 'Migration strategy monitors bonding curve velocity (Raydium migration corridor)',
          suggestedSizeMultiplier: 1.0
        };

      case 'MOMENTUM_SCALP':
        return {
          shouldBuy: false,
          reason: 'Momentum Scalper requires live trade tick velocity and confirmed buyer momentum',
          suggestedSizeMultiplier: 1.0
        };

      case 'COPY_WHALE':
        return {
          shouldBuy: false,
          reason: 'Copy Whale strategy only follows target wallet trades',
          suggestedSizeMultiplier: 1.0
        };
    }
  }

  public evaluateTradeTick(trade: TradeEvent): StrategyDecision {
    const now = Date.now();
    const window = this.tradeWindowMap.get(trade.mint) || { count: 0, firstSeen: now, buyVolumeSol: 0 };
    const rawSol = (trade.solAmount && !isNaN(trade.solAmount) && trade.solAmount > 0) ? trade.solAmount : 0;
    const sol = rawSol > 1e6 ? rawSol / 1e9 : rawSol;

    if (now - window.firstSeen < 30000) { // 30-second rolling window
      window.count++;
      if (trade.txType === 'buy') {
        window.buyVolumeSol += sol;
      }
    } else {
      window.count = 1;
      window.firstSeen = now;
      window.buyVolumeSol = trade.txType === 'buy' ? sol : 0;
    }
    this.tradeWindowMap.set(trade.mint, window);

    // Periodic map garbage collection to prevent memory leaks
    if (this.tradeWindowMap.size > 2000) {
      for (const [mint, data] of this.tradeWindowMap.entries()) {
        if (now - data.firstSeen > 120000) {
          this.tradeWindowMap.delete(mint);
        }
      }
    }

    // Strategy 1: Migration / KOTH Breakout
    if (this.activeStrategy === 'MIGRATION_KOTH') {
      if (trade.vSolInBondingCurve) {
        const progress = BondingCurveCalculator.calculateProgress(trade.vSolInBondingCurve);
        if (progress >= 45 && progress <= 95 && window.buyVolumeSol >= 0.5) {
          return {
            shouldBuy: true,
            reason: `Raydium Migration velocity breakout! Progress: ${progress.toFixed(1)}% | 30s Buy Vol: ${window.buyVolumeSol.toFixed(2)} SOL`,
            suggestedSizeMultiplier: 1.2
          };
        }
      }
    }

    // Strategy 2: Momentum Scalper Surge
    if (this.activeStrategy === 'MOMENTUM_SCALP') {
      if (window.count >= 3 && window.buyVolumeSol >= 0.4) {
        return {
          shouldBuy: true,
          reason: `Momentum Flow Surge! ${window.count} trades with ${window.buyVolumeSol.toFixed(2)} SOL volume in 30s`,
          suggestedSizeMultiplier: 1.0
        };
      }
    }

    // Strategy 3: Global Sniper Acceleration
    if (this.activeStrategy === 'SNIPER' && window.count >= 4 && window.buyVolumeSol >= 0.6) {
      return {
        shouldBuy: true,
        reason: `Secondary Momentum Breakout! ${window.count} buys with ${window.buyVolumeSol.toFixed(2)} SOL volume`,
        suggestedSizeMultiplier: 1.0
      };
    }

    return { shouldBuy: false, reason: 'Conditions not met', suggestedSizeMultiplier: 1.0 };
  }
}
