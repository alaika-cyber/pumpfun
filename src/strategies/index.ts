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

  public evaluateNewToken(_token: TokenCreationEvent, _viralityScore: number): StrategyDecision {
    // NEVER buy new coins at creation — all strategies route to the Candidate Watchlist
    // Tokens must prove live buyer momentum, volume, and price movement before entry
    return {
      shouldBuy: false,
      reason: 'All tokens routed to Momentum Watchlist — must confirm live trade velocity before entry',
      suggestedSizeMultiplier: 1.0
    };
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

    // Strategy 1: Migration / KOTH Breakout — only via confirmed candidate watchlist momentum
    if (this.activeStrategy === 'MIGRATION_KOTH') {
      if (trade.vSolInBondingCurve) {
        const progress = BondingCurveCalculator.calculateProgress(trade.vSolInBondingCurve);
        if (progress >= 45 && progress <= 95 && window.count >= 5 && window.buyVolumeSol >= 1.0) {
          return {
            shouldBuy: true,
            reason: `Raydium Migration velocity breakout! Progress: ${progress.toFixed(1)}% | 30s Buy Vol: ${window.buyVolumeSol.toFixed(2)} SOL`,
            suggestedSizeMultiplier: 1.2
          };
        }
      }
    }

    // Strategy 2: Momentum Scalper — requires heavy confirmed volume
    if (this.activeStrategy === 'MOMENTUM_SCALP') {
      if (window.count >= 5 && window.buyVolumeSol >= 1.0) {
        return {
          shouldBuy: true,
          reason: `Momentum Flow Surge! ${window.count} trades with ${window.buyVolumeSol.toFixed(2)} SOL volume in 30s`,
          suggestedSizeMultiplier: 1.0
        };
      }
    }

    // Strategy 3: Sniper Acceleration — requires strong confirmed momentum
    if (this.activeStrategy === 'SNIPER' && window.count >= 6 && window.buyVolumeSol >= 1.5) {
      return {
        shouldBuy: true,
        reason: `Confirmed Momentum Breakout! ${window.count} buys with ${window.buyVolumeSol.toFixed(2)} SOL volume`,
        suggestedSizeMultiplier: 1.0
      };
    }

    return { shouldBuy: false, reason: 'Conditions not met', suggestedSizeMultiplier: 1.0 };
  }
}
