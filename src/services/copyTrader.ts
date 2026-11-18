import chalk from 'chalk';
import { TradeEvent } from '../types';

export const DEFAULT_SHARK_WALLETS: Record<string, string> = {
  '4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo': '@The__Solstice (Shark)',
  'CcJX975YTw8owyuRwyC1m9pyC3ZhRp89VM12pfUfDBcf': '@crackthecode (Shark)'
};

export class CopyTrader {
  private trackedWallets: Set<string> = new Set();
  private walletLabels: Map<string, string> = new Map();
  private minCopySolAmount: number = 0.05;
  private enabled: boolean = false;

  constructor() {
    // Register default sharks
    for (const [address, label] of Object.entries(DEFAULT_SHARK_WALLETS)) {
      this.trackedWallets.add(address);
      this.walletLabels.set(address, label);
    }

    // Register any additional wallets from env
    const raw = process.env.TRACKED_WALLETS || '';
    const wallets = raw.split(',').map(w => w.trim()).filter(Boolean);
    for (const w of wallets) {
      this.trackedWallets.add(w);
      if (!this.walletLabels.has(w)) {
        this.walletLabels.set(w, `Alpha Wallet (${w.substring(0, 6)}...)`);
      }
    }

    this.enabled = this.trackedWallets.size > 0;
    if (this.enabled) {
      console.log(chalk.cyan.bold(`[CopyTrader] 🦈 Tracking ${this.trackedWallets.size} Shark / Alpha Wallet(s):`));
      for (const [addr, label] of this.walletLabels.entries()) {
        console.log(chalk.gray(`  • ${label}: ${addr}`));
      }
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getTrackedWallets(): string[] {
    return Array.from(this.trackedWallets);
  }

  public getWalletLabel(pubkey: string): string {
    return this.walletLabels.get(pubkey) || `Shark (${pubkey.substring(0, 6)}...)`;
  }

  public shouldCopy(trade: TradeEvent): boolean {
    if (!this.enabled) return false;
    if (trade.txType !== 'buy') return false;

    const solAmount = trade.solAmount ? (trade.solAmount > 1e6 ? trade.solAmount / 1e9 : trade.solAmount) : 0;
    if (solAmount < this.minCopySolAmount) {
      return false; // Skip dust/micro buys
    }

    if (this.trackedWallets.has(trade.traderPublicKey)) {
      const label = this.getWalletLabel(trade.traderPublicKey);
      console.log(
        chalk.magenta.bold(
          `\n[🦈 SHARK BUY DETECTED] 🎯 ${label} bought ${solAmount.toFixed(3)} SOL of ${trade.mint}!`
        )
      );
      return true;
    }
    return false;
  }
}
