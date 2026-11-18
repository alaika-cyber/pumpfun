import WebSocket from 'ws';
import axios from 'axios';
import chalk from 'chalk';
import { VersionedTransaction } from '@solana/web3.js';
import { SolanaService } from './solana';
import { TokenCreationEvent, TradeEvent } from '../types';

export class PumpPortalService {
  private wsUrl: string = 'wss://pumpportal.fun/api/data';
  private apiUrl: string = 'https://pumpportal.fun/api/trade-local';
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private activeSubscriptions: Set<string> = new Set();
  private activeAccountSubscriptions: Set<string> = new Set();
  private pendingSubscriptionQueue: Set<string> = new Set();
  private isIntentionallyClosed: boolean = false;

  private onNewTokenCallback?: (token: TokenCreationEvent) => void;
  private onTokenTradeCallback?: (trade: TradeEvent) => void;

  constructor(private solanaService: SolanaService) {}

  public connect(
    onNewToken: (token: TokenCreationEvent) => void,
    onTokenTrade: (trade: TradeEvent) => void
  ): void {
    this.isIntentionallyClosed = false;
    this.onNewTokenCallback = onNewToken;
    this.onTokenTradeCallback = onTokenTrade;
    this.initWebSocket();
  }

  private initWebSocket(): void {
    console.log(chalk.cyan(`[PumpPortal] Connecting to WebSocket: ${this.wsUrl}...`));
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log(chalk.green(`[PumpPortal] Connected successfully to stream!`));

      this.subscribeNewTokens();

      // Flush and resubscribe active subscriptions
      if (this.activeSubscriptions.size > 0) {
        this.flushSubscriptions(Array.from(this.activeSubscriptions));
      }

      if (this.activeAccountSubscriptions.size > 0) {
        this.flushAccountSubscriptions(Array.from(this.activeAccountSubscriptions));
      }

      if (this.pendingSubscriptionQueue.size > 0) {
        this.flushSubscriptions(Array.from(this.pendingSubscriptionQueue));
        this.pendingSubscriptionQueue.clear();
      }

      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch {
        // Ignore malformed frames
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: any) => {
      console.error(chalk.red(`[PumpPortal] WebSocket error: ${err.message}`));
      if (this.ws) {
        this.ws.close();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    this.reconnectAttempts++;
    // Exponential backoff with jitter: 1.5s, 3s, 6s, 12s, capped at 15s
    const baseDelay = Math.min(15000, 1500 * Math.pow(2, this.reconnectAttempts - 1));
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseDelay + jitter;

    console.log(chalk.yellow(`[PumpPortal] Reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt #${this.reconnectAttempts})...`));

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.initWebSocket();
    }, delay);
  }

  private handleMessage(msg: any): void {
    if (!msg) return;

    if (msg.txType === 'create' || (msg.mint && msg.name && msg.symbol && !msg.tokenAmount)) {
      // PumpPortal sends solAmount for initial SOL buy, or initialBuy as SOL (or raw tokens if large).
      let initialBuySol = 0;
      if (typeof msg.solAmount === 'number' && !isNaN(msg.solAmount) && msg.solAmount > 0) {
        initialBuySol = msg.solAmount > 1e6 ? msg.solAmount / 1e9 : msg.solAmount;
      } else if (typeof msg.initialBuy === 'number' && !isNaN(msg.initialBuy) && msg.initialBuy > 0) {
        initialBuySol = msg.initialBuy > 1e6 ? msg.initialBuy / 1e9 : (msg.initialBuy < 1000 ? msg.initialBuy : 0);
      }

      const tokenEvent: TokenCreationEvent = {
        signature: msg.signature || '',
        mint: msg.mint,
        traderPublicKey: msg.traderPublicKey || '',
        txType: 'create',
        initialBuy: initialBuySol,
        bondingCurveKey: msg.bondingCurveKey,
        vTokensInBondingCurve: msg.vTokensInBondingCurve,
        vSolInBondingCurve: msg.vSolInBondingCurve,
        marketCapSol: msg.marketCapSol,
        name: msg.name || 'Unknown',
        symbol: msg.symbol || 'UNKNOWN',
        uri: msg.uri || '',
        twitter: msg.twitter,
        telegram: msg.telegram,
        website: msg.website,
        timestamp: Date.now()
      };
      this.onNewTokenCallback?.(tokenEvent);
      return;
    }

    if (msg.txType === 'buy' || msg.txType === 'sell') {
      const tradeEvent: TradeEvent = {
        signature: msg.signature || '',
        mint: msg.mint,
        traderPublicKey: msg.traderPublicKey || '',
        txType: msg.txType,
        tokenAmount: msg.tokenAmount || 0,
        solAmount: msg.solAmount || 0,
        newTokenBalance: msg.newTokenBalance,
        bondingCurveKey: msg.bondingCurveKey,
        vTokensInBondingCurve: msg.vTokensInBondingCurve,
        vSolInBondingCurve: msg.vSolInBondingCurve,
        marketCapSol: msg.marketCapSol,
        timestamp: Date.now()
      };
      this.onTokenTradeCallback?.(tradeEvent);
      return;
    }
  }

  public subscribeNewTokens(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = { method: 'subscribeNewToken' };
    this.ws.send(JSON.stringify(payload));
  }

  private flushSubscriptions(mints: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || mints.length === 0) return;
    const payload = {
      method: 'subscribeTokenTrade',
      keys: mints
    };
    this.ws.send(JSON.stringify(payload));
  }

  public subscribeTokenTrades(mints: string[]): void {
    for (const m of mints) {
      this.activeSubscriptions.add(m);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      for (const m of mints) {
        this.pendingSubscriptionQueue.add(m);
      }
      return;
    }
    this.flushSubscriptions(mints);
  }

  public unsubscribeTokenTrades(mints: string[]): void {
    for (const m of mints) {
      this.activeSubscriptions.delete(m);
      this.pendingSubscriptionQueue.delete(m);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || mints.length === 0) return;
    const payload = {
      method: 'unsubscribeTokenTrade',
      keys: mints
    };
    this.ws.send(JSON.stringify(payload));
  }

  public subscribeAccountTrades(wallets: string[]): void {
    if (!wallets || wallets.length === 0) return;
    for (const w of wallets) {
      this.activeAccountSubscriptions.add(w);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.flushAccountSubscriptions(wallets);
  }

  private flushAccountSubscriptions(wallets: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || wallets.length === 0) return;
    const payload = {
      method: 'subscribeAccountTrade',
      keys: wallets
    };
    this.ws.send(JSON.stringify(payload));
    console.log(chalk.cyan(`[PumpPortal] 🐋 Subscribed to ${wallets.length} whale wallet(s) for copy-trading`));
  }

  public async executeLiveTrade(params: {
    action: 'buy' | 'sell';
    mint: string;
    amount: number | string;
    denominatedInSol: boolean;
    slippagePercent?: number;
    priorityFeeSol?: number;
    pool?: 'pump' | 'raydium' | 'auto';
  }): Promise<{ success: boolean; signature?: string; error?: string }> {
    const keypair = this.solanaService.getKeypair();
    if (!keypair) {
      return { success: false, error: 'No keypair configured for live trading' };
    }

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          publicKey: keypair.publicKey.toBase58(),
          action: params.action,
          mint: params.mint,
          amount: params.amount,
          denominatedInSol: params.denominatedInSol.toString(),
          slippage: params.slippagePercent || 15,
          priorityFee: params.priorityFeeSol || 0.001,
          pool: params.pool || 'pump'
        },
        {
          responseType: 'arraybuffer',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      if (response.status !== 200) {
        return { success: false, error: `API status ${response.status}` };
      }

      const txBuffer = Buffer.from(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);

      const connection = this.solanaService.getConnection();
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      });

      console.log(chalk.green(`[PumpPortal] Live ${params.action.toUpperCase()} submitted! Tx: ${signature}`));
      return { success: true, signature };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {}); // Suppress closure errors during intentional disconnect
      try {
        this.ws.close();
      } catch {
        // Suppress error if already closed
      }
      this.ws = null;
    }
    this.isConnected = false;
  }
}
