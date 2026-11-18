import chalk from 'chalk';
import Table from 'cli-table3';
import { AgentConfig, CandidateToken, Position, TokenCreationEvent, TradeEvent } from './types';
import { SolanaService } from './services/solana';
import { FilterEngine } from './services/filterEngine';
import { RiskManager, ExitSignal } from './services/riskManager';
import { PumpPortalService } from './services/pumpPortal';
import { PaperTrader } from './services/paperTrader';
import { LiveTrader } from './services/liveTrader';
import { WebServer } from './services/webServer';
import { NotificationService } from './services/notificationService';
import { RugCheckService } from './services/rugCheck';
import { CopyTrader } from './services/copyTrader';
import { TradeJournal } from './services/db';
import { StrategyManager, StrategyType } from './strategies';
import { GasOptimizer } from './services/gasOptimizer';
import { BondingCurveCalculator } from './services/bondingCurve';
import { SQLiteMemory } from './services/sqliteMemory';
import { AIBrain } from './services/aiBrain';
import { ProfitVault } from './services/profitVault';
import { ResearchEngine, TokenCategory } from './services/researchEngine';
import { WhaleTracker, WhaleAlert } from './services/whaleTracker';
import { PositionSizer } from './services/positionSizer';
import { MigrationPredictor, MigrationPrediction } from './services/migrationPredictor';
import { StrategyCoordinator, MarketRegime } from './services/strategyCoordinator';
import { TelegramBot } from './services/telegramBot';
import { ClusterDetector } from './services/clusterDetector';
import { StealthRugDetector } from './services/stealthRugDetector';
import { RpcFailoverManager } from './services/rpcFailover';
import { SocialSentimentAnalyzer } from './services/socialSentiment';
import { LossRecoveryManager } from './services/lossRecovery';
import { SandwichGuard } from './services/sandwichGuard';
import { ReinvestmentEngine } from './services/reinvestmentEngine';
import { Backtester } from './services/backtester';

export class PumpFunAgent {
  private config: AgentConfig;
  private solanaService: SolanaService;
  private filterEngine: FilterEngine;
  private riskManager: RiskManager;
  private pumpPortal: PumpPortalService;
  private paperTrader?: PaperTrader;
  private liveTrader?: LiveTrader;
  private webServer: WebServer;
  private notificationService: NotificationService;
  private rugCheckService: RugCheckService;
  private copyTrader: CopyTrader;
  private journal: TradeJournal;
  private strategyManager: StrategyManager;
  private gasOptimizer: GasOptimizer;
  private sqliteMemory: SQLiteMemory;
  private aiBrain: AIBrain;
  private profitVault: ProfitVault;
  private researchEngine: ResearchEngine;
  private whaleTracker: WhaleTracker;
  private positionSizer: PositionSizer;
  private migrationPredictor: MigrationPredictor;
  private strategyCoordinator: StrategyCoordinator;
  private telegramBot: TelegramBot;
  private clusterDetector: ClusterDetector;
  private stealthRugDetector: StealthRugDetector;
  private rpcFailover: RpcFailoverManager;
  private socialSentiment: SocialSentimentAnalyzer;
  private lossRecovery: LossRecoveryManager;
  private sandwichGuard: SandwichGuard;
  private reinvestmentEngine: ReinvestmentEngine;
  private backtester: Backtester;

  private isRunning: boolean = false;
  private isEvaluatingPositions: boolean = false;
  private isSyncingDashboard: boolean = false;
  private monitorInterval: NodeJS.Timeout | null = null;
  private dashboardInterval: NodeJS.Timeout | null = null;
  private processedTokensCount: number = 0;
  private passedTokensCount: number = 0;
  private devPubkeyMap: Map<string, string> = new Map();
  private tokenSymbolMap: Map<string, string> = new Map();
  private latestPredictions: Map<string, MigrationPrediction> = new Map();
  private candidateWatchlist: Map<string, CandidateToken> = new Map();
  private static readonly MAX_CANDIDATE_WATCHLIST = 80;
  private static readonly CANDIDATE_WATCHLIST_TTL_MS = 90000;

  constructor(config: AgentConfig) {
    this.config = config;
    this.solanaService = new SolanaService(config.rpcUrl, config.privateKey);
    this.rpcFailover = new RpcFailoverManager(config.rpcUrl);
    this.rpcFailover.setOnFailover((node) => {
      this.solanaService.updateConnection(node.connection);
    });
    this.filterEngine = new FilterEngine(config);
    this.riskManager = new RiskManager(config);
    this.pumpPortal = new PumpPortalService(this.solanaService);
    this.journal = new TradeJournal(config.tradingMode === 'paper' ? 1.0 : 0);
    this.sqliteMemory = new SQLiteMemory();
    this.aiBrain = new AIBrain(this.sqliteMemory);
    this.profitVault = new ProfitVault(config, this.sqliteMemory, this.solanaService);
    this.strategyManager = new StrategyManager(config.activeStrategy);
    this.gasOptimizer = new GasOptimizer(() => this.solanaService.getConnection());
    this.researchEngine = new ResearchEngine();
    this.whaleTracker = new WhaleTracker();
    this.positionSizer = new PositionSizer(config);
    this.migrationPredictor = new MigrationPredictor();
    this.strategyCoordinator = new StrategyCoordinator(config.activeStrategy, true);
    this.telegramBot = new TelegramBot();
    this.clusterDetector = new ClusterDetector();
    this.stealthRugDetector = new StealthRugDetector();
    this.socialSentiment = new SocialSentimentAnalyzer();
    this.lossRecovery = new LossRecoveryManager();
    this.sandwichGuard = new SandwichGuard();
    this.reinvestmentEngine = new ReinvestmentEngine(config.solPerTrade, 0.05);
    this.backtester = new Backtester(this.sqliteMemory);
    this.webServer = new WebServer(this.journal, this.backtester);
    this.notificationService = new NotificationService();
    this.rugCheckService = new RugCheckService(this.solanaService);
    this.copyTrader = new CopyTrader();

    if (config.tradingMode === 'live') {
      this.liveTrader = new LiveTrader(config, this.pumpPortal, this.solanaService, this.journal, this.sqliteMemory, this.profitVault);
    } else {
      this.paperTrader = new PaperTrader(config, 1.0, this.journal, this.sqliteMemory, this.profitVault);
    }

    this.webServer.registerActionHandlers(
      this.panicSellAll.bind(this),
      this.sellSinglePosition.bind(this),
      this.changeStrategy.bind(this),
      this.updateConfig.bind(this)
    );

    this.telegramBot.registerHandlers({
      getStatus: async () => {
        const stats = await this.getTraderStats();
        const mode = this.config.tradingMode.toUpperCase();
        const strat = this.strategyCoordinator.getActiveStrategy();
        const pnlEmoji = stats.realizedPnlSol >= 0 ? '🟢' : '🔴';
        const pnlSign = stats.realizedPnlSol >= 0 ? '+' : '';

        return (
          `📊 <b>QUANTUM MATRIX TELEMETRY</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⚡ <b>Mode:</b> <code>${mode}</code> | <b>Engine:</b> 🟢 <code>ACTIVE</code>\n` +
          `🎯 <b>Active Strategy:</b> <b>${strat}</b>\n` +
          `💰 <b>Bankroll:</b> <b>${stats.currentBalanceSol.toFixed(4)} SOL</b>\n` +
          `🔒 <b>Safe Vault:</b> <b>${this.profitVault.getTotalVaulted().toFixed(4)} SOL</b> (Cycle #${this.profitVault.getCycleCount()})\n` +
          `📈 <b>Realized PnL:</b> ${pnlEmoji} <b>${pnlSign}${stats.realizedPnlSol.toFixed(4)} SOL</b>\n` +
          `🏆 <b>Win Rate:</b> <b>${stats.winRate.toFixed(1)}%</b> (${stats.winningTrades}W / ${stats.losingTrades}L)\n` +
          `🔍 <b>Tokens Scanned:</b> ${this.processedTokensCount} | <b>Passed:</b> ${this.passedTokensCount}`
        );
      },
      getPositions: async () => {
        return this.config.tradingMode === 'live'
          ? (this.liveTrader?.getOpenPositions() || [])
          : (this.paperTrader?.getOpenPositions() || []);
      },
      panicSellAll: async () => {
        await this.panicSellAll();
      },
      sellSinglePosition: async (mint: string, ratio: number = 1.0) => {
        await this.sellSinglePosition(mint, ratio);
      },
      changeStrategy: (strategy: StrategyType) => {
        this.changeStrategy(strategy);
      },
      getVaultSummary: async () => {
        return {
          totalVaulted: this.profitVault.getTotalVaulted(),
          cycles: this.profitVault.getCycleCount()
        };
      },
      getConfig: () => {
        return this.config;
      },
      updateConfig: (newConfig: Partial<AgentConfig>) => {
        this.updateConfig(newConfig);
      },
      getRecentAiDecisions: async () => {
        return this.sqliteMemory.getRecentAIDecisions(5);
      },
      getKothPredictions: () => {
        return Array.from(this.latestPredictions.values());
      }
    });
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.blue.bold('\n======================================================'));
    console.log(chalk.green.bold(` 🚀 PUMP.FUN TRADING AGENT (QUANTUM PRO v9.0 TITAN)`));
    console.log(chalk.blue.bold('======================================================\n'));

    await this.sqliteMemory.init();
    await this.profitVault.init();
    await this.webServer.start();

    if (this.config.tradingMode === 'live' && this.liveTrader) {
      await this.liveTrader.init();
      if (!this.solanaService.getKeypair()) {
        console.error(chalk.red.bold('❌ Cannot run in LIVE mode without a valid SOLANA_PRIVATE_KEY in .env!'));
        process.exit(1);
      }
      await this.liveTrader.restoreFromMemory();
    } else if (this.paperTrader) {
      await this.paperTrader.restoreFromMemory();
      console.log(chalk.magenta(`[Agent] Paper Trading Active (Trading Bankroll: ${this.paperTrader.getBalance().toFixed(4)} SOL | Vaulted: ${this.profitVault.getTotalVaulted().toFixed(4)} SOL)`));
    }

    console.log(chalk.yellow(`[Agent] Active Matrix Configuration:`));
    console.log(chalk.gray(`  • AI Model: ${this.config.aiProvider} (${this.config.aiModel})`));
    console.log(chalk.gray(`  • Multi-RPC Failover: Active (${this.rpcFailover.getActiveUrl()})`));
    console.log(chalk.gray(`  • Sandwich Guard: Active (Auto-Tolerancing MEV Risk)`));
    console.log(chalk.gray(`  • Stealth Drain Detector: Active`));
    console.log(chalk.gray(`  • Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? 'Active (Polling Commands)' : 'Disabled'}`));
    console.log(chalk.gray(`  • Profit Vault: Base ${this.config.baseBankrollSol} SOL | Milestone Lock: +${this.config.profitVaultThresholdSol} SOL\n`));

    this.pumpPortal.connect(
      this.handleNewToken.bind(this),
      this.handleTokenTrade.bind(this)
    );

    if (this.copyTrader.isEnabled()) {
      this.pumpPortal.subscribeAccountTrades(this.copyTrader.getTrackedWallets());
    }

    this.monitorInterval = setInterval(() => {
      this.evaluateActivePositions().catch(err => {
        console.error(chalk.red(`[Agent] Position monitor error: ${err?.message || err}`));
      });
    }, 1000);

    this.dashboardInterval = setInterval(() => {
      this.syncAndRenderDashboard().catch(err => {
        console.error(chalk.red(`[Agent] Dashboard render error: ${err?.message || err}`));
      });
    }, 4000);
  }

  public changeStrategy(strategy: StrategyType): void {
    this.strategyCoordinator.setActiveStrategy(strategy);
    this.strategyManager.setActiveStrategy(strategy);
    this.config.activeStrategy = strategy;
    console.log(chalk.cyan.bold(`[Agent] Switched active strategy to: ${strategy}`));
    this.webServer.broadcastLog(`Switched active strategy to: ${strategy}`);
  }

  public updateConfig(newConfig: Partial<AgentConfig>): void {
    Object.assign(this.config, newConfig);
    console.log(chalk.cyan(`[Agent] Config updated live from Web UI`));
    this.webServer.broadcastLog(`Live config updated from dashboard`);
  }

  private async handleNewToken(token: TokenCreationEvent): Promise<void> {
    this.processedTokensCount++;
    this.strategyCoordinator.recordTokenLaunch();
    this.clusterDetector.registerLaunch(token.mint);
    this.devPubkeyMap.set(token.mint, token.traderPublicKey);
    this.tokenSymbolMap.set(token.mint, token.symbol);
    this.webServer.broadcastNewToken(token);

    const filterResult = this.filterEngine.evaluateToken(token);
    if (!filterResult.passed) return;

    const isAlreadyOpen = this.config.tradingMode === 'live'
      ? this.liveTrader?.getPosition(token.mint)?.status === 'OPEN'
      : this.paperTrader?.getPosition(token.mint)?.status === 'OPEN';
    if (isAlreadyOpen || this.candidateWatchlist.has(token.mint)) return;

    // NEVER buy new coins at creation — ALL tokens go to Candidate Watchlist
    // and must prove real buyer momentum, volume & price movement before entry
    let initialPrice = 0.00000003;
    if (token.vSolInBondingCurve && token.vTokensInBondingCurve && token.vTokensInBondingCurve > 0) {
      initialPrice = BondingCurveCalculator.calculateSpotPriceSol(token.vSolInBondingCurve, token.vTokensInBondingCurve);
    }

    // Maintain max watchlist size to prevent memory leaks
    if (this.candidateWatchlist.size >= PumpFunAgent.MAX_CANDIDATE_WATCHLIST) {
      const oldestMint = this.candidateWatchlist.keys().next().value;
      if (oldestMint) {
        this.candidateWatchlist.delete(oldestMint);
        this.pumpPortal.unsubscribeTokenTrades([oldestMint]);
      }
    }

    this.candidateWatchlist.set(token.mint, {
      token,
      addedAt: Date.now(),
      initialPriceSol: initialPrice,
      latestPriceSol: initialPrice,
      highestPriceSol: initialPrice,
      tradesCount: 0,
      buyCount: 0,
      sellCount: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      uniqueBuyers: new Set<string>(),
      bondingCurveProgress: token.vSolInBondingCurve ? BondingCurveCalculator.calculateProgress(token.vSolInBondingCurve) : 0,
      lastTradeTimestamp: Date.now(),
      evaluating: false
    });

    // Subscribe to live trade events for this candidate coin so we catch momentum!
    this.pumpPortal.subscribeTokenTrades([token.mint]);
  }

  private async executeMovingCoinBuy(candidate: CandidateToken, priceGainPct: number): Promise<void> {
    const token = candidate.token;

    // 1. Capacity check
    const canOpen = this.config.tradingMode === 'live'
      ? await this.liveTrader?.canOpenPosition(token.mint)
      : this.paperTrader?.canOpenPosition(token.mint);
    if (!canOpen) {
      candidate.evaluating = false;
      return;
    }

    // 2. Circuit breaker check
    const stats = await this.getTraderStats();
    if (this.riskManager.checkCircuitBreaker(stats.realizedPnlSol)) {
      candidate.evaluating = false;
      return;
    }

    // 3. RugCheck on the active coin
    const rugCheck = await this.rugCheckService.evaluateToken(token.mint, token.traderPublicKey);
    if (!rugCheck.isSafe) {
      console.log(chalk.yellow(`[RugCheck Rejected Moving Coin] ⚠️ ${token.symbol}: ${rugCheck.risks.join(', ')}`));
      this.webServer.broadcastLog(`RugCheck rejected moving coin ${token.symbol}: ${rugCheck.risks.join(', ')}`);
      this.candidateWatchlist.delete(token.mint);
      this.pumpPortal.unsubscribeTokenTrades([token.mint]);
      return;
    }

    // 4. Deep Research & Sentiment
    const research = await this.researchEngine.conductResearch(token);
    const sentiment = this.socialSentiment.analyzeToken(token);

    // 5. AI Brain Evaluation with confirmed trade volume
    const aiDecision = await this.aiBrain.evaluateOpportunity(
      token,
      research,
      this.strategyCoordinator.getActiveStrategy(),
      candidate.buyVolumeSol,
      rugCheck.score / 100
    );

    await this.sqliteMemory.recordAIDecision(
      token.mint,
      token.symbol,
      aiDecision.shouldBuy ? 'BUY' : 'SKIP',
      aiDecision.confidenceScore,
      `[Momentum Moving Coin] ${aiDecision.reasoning}`,
      [...aiDecision.tags, 'MovingCoin', 'ConfirmedMomentum']
    );

    if (!aiDecision.shouldBuy || aiDecision.confidenceScore < this.config.minAiConfidence) {
      console.log(chalk.gray(`[AI Brain Skipped] Moving coin ${token.symbol} (Score: ${aiDecision.confidenceScore}%, Min: ${this.config.minAiConfidence}%)`));
      this.candidateWatchlist.delete(token.mint);
      this.pumpPortal.unsubscribeTokenTrades([token.mint]);
      return;
    }

    // 6. Dynamic Sizing
    const currentBal = this.config.tradingMode === 'live' ? await this.solanaService.getBalance() : (this.paperTrader?.getBalance() || 1.0);
    const recoveryMultiplier = this.lossRecovery.getRecoveryMultiplier(aiDecision.confidenceScore);
    const devRepScore = Math.max(0, 100 - rugCheck.score);
    const baseDynamicSizeSol = this.positionSizer.calculateTradeSize(
      aiDecision.confidenceScore,
      this.journal.getAnalytics().winRate,
      devRepScore,
      currentBal
    );

    const compoundedSizeSol = this.reinvestmentEngine.calculateCompoundedTradeSize(stats.realizedPnlSol, currentBal);
    const finalSizeSol = Number((Math.max(baseDynamicSizeSol, compoundedSizeSol) * recoveryMultiplier).toFixed(4));

    const sandwich = this.sandwichGuard.evaluateSandwichRisk(finalSizeSol, token.vSolInBondingCurve || 30000000000);
    const effectiveSlippage = sandwich.isHighRisk ? sandwich.maxSafeSlippagePct : this.config.slippagePercent;

    if (this.config.tradingMode === 'live') {
      const optimalFee = await this.gasOptimizer.getOptimalPriorityFee();
      this.config.priorityFeeLamports = optimalFee;
    }

    this.passedTokensCount++;
    console.log(
      chalk.green.bold(
        `\n[🔥 Moving Coin Breakout Confirmed!] 🚀 ${token.symbol} (${token.name})\n` +
        `  • Activity: ${candidate.buyCount} buys across ${candidate.uniqueBuyers.size} unique wallets\n` +
        `  • Volume: ${candidate.buyVolumeSol.toFixed(3)} SOL buy flow (Net: +${(candidate.buyVolumeSol - candidate.sellVolumeSol).toFixed(3)} SOL)\n` +
        `  • Curve Progress: ${candidate.bondingCurveProgress.toFixed(1)}% | Price Gain: +${priceGainPct.toFixed(1)}%\n` +
        `  • Virality Tier: ${sentiment.sentimentTier} (${sentiment.viralityScore}/100)\n` +
        `  • Trade Size: ${finalSizeSol.toFixed(4)} SOL | AI Confidence: ${aiDecision.confidenceScore}%\n` +
        `  • Mint: ${token.mint}`
      )
    );

    let position: Position | null = null;
    const buyTags = [...aiDecision.tags, 'MomentumBreakout', 'MovingCoin'];
    const buyReason = `Live momentum breakout: ${candidate.buyCount} buys, ${candidate.buyVolumeSol.toFixed(2)} SOL vol, +${priceGainPct.toFixed(1)}% gain`;

    if (this.config.tradingMode === 'live' && this.liveTrader) {
      position = await this.liveTrader.executeBuy(
        token,
        buyTags,
        this.strategyCoordinator.getActiveStrategy(),
        aiDecision.confidenceScore,
        buyReason,
        finalSizeSol,
        effectiveSlippage
      );
    } else if (this.paperTrader) {
      position = this.paperTrader.simulateBuy(
        token,
        buyTags,
        this.strategyCoordinator.getActiveStrategy(),
        aiDecision.confidenceScore,
        buyReason,
        finalSizeSol,
        effectiveSlippage
      );
    }

    // Remove from candidate watchlist since it is now an active position
    this.candidateWatchlist.delete(token.mint);

    if (position) {
      position.category = research.category;
      position.researchScore = research.researchScore;
      position.bondingCurveProgress = candidate.bondingCurveProgress;
      this.webServer.broadcastLog(`[Momentum Engine] Bought moving coin ${position.symbol} (${finalSizeSol.toFixed(3)} SOL, +${priceGainPct.toFixed(1)}% gain)`);
      await this.notificationService.notifyBuy(position, this.config.tradingMode);
      await this.telegramBot.notifyBuy(position, finalSizeSol);
      await this.syncAndRenderDashboard();
    }
  }

  private async executeStrategyTradeBuy(
    trade: TradeEvent,
    strategyName: string,
    reason: string,
    sizeMultiplier: number = 1.0
  ): Promise<void> {
    const symbol = this.tokenSymbolMap.get(trade.mint) || trade.mint.substring(0, 6).toUpperCase();

    const canOpen = this.config.tradingMode === 'live'
      ? await this.liveTrader?.canOpenPosition(trade.mint)
      : this.paperTrader?.canOpenPosition(trade.mint);
    if (!canOpen) return;

    const stats = await this.getTraderStats();
    if (this.riskManager.checkCircuitBreaker(stats.realizedPnlSol)) return;

    const rugCheck = await this.rugCheckService.evaluateToken(trade.mint, trade.traderPublicKey);
    if (!rugCheck.isSafe) {
      console.log(chalk.yellow(`[RugCheck Rejected ${strategyName}] ⚠️ ${symbol}: ${rugCheck.risks.join(', ')}`));
      this.webServer.broadcastLog(`RugCheck rejected ${strategyName} on ${symbol}: ${rugCheck.risks.join(', ')}`);
      return;
    }

    const mockToken: TokenCreationEvent = {
      signature: trade.signature,
      mint: trade.mint,
      traderPublicKey: trade.traderPublicKey,
      txType: 'create',
      initialBuy: this.config.solPerTrade,
      bondingCurveKey: trade.bondingCurveKey,
      vTokensInBondingCurve: trade.vTokensInBondingCurve,
      vSolInBondingCurve: trade.vSolInBondingCurve,
      marketCapSol: trade.marketCapSol,
      name: `${symbol} Token`,
      symbol: symbol,
      uri: '',
      timestamp: Date.now()
    };

    const currentBal = this.config.tradingMode === 'live' ? await this.solanaService.getBalance() : (this.paperTrader?.getBalance() || 1.0);
    const baseDynamicSizeSol = this.positionSizer.calculateTradeSize(80, 50, 50, currentBal);
    const finalSizeSol = Number((baseDynamicSizeSol * sizeMultiplier).toFixed(4));
    const effectiveSlippage = this.config.slippagePercent;

    console.log(
      chalk.magenta.bold(
        `\n[Strategy Triggered] 🎯 [${strategyName}] ${symbol}\n` +
        `  • Reason: ${reason}\n` +
        `  • Trade Size: ${finalSizeSol.toFixed(4)} SOL\n` +
        `  • Mint: ${trade.mint}`
      )
    );

    let position: Position | null = null;
    if (this.config.tradingMode === 'live' && this.liveTrader) {
      position = await this.liveTrader.executeBuy(
        mockToken,
        [strategyName, 'Momentum'],
        strategyName,
        80,
        reason,
        finalSizeSol,
        effectiveSlippage
      );
    } else if (this.paperTrader) {
      position = this.paperTrader.simulateBuy(
        mockToken,
        [strategyName, 'Momentum'],
        strategyName,
        80,
        reason,
        finalSizeSol,
        effectiveSlippage
      );
    }

    if (position) {
      this.passedTokensCount++;
      this.pumpPortal.subscribeTokenTrades([position.mint]);
      this.webServer.broadcastLog(`[${strategyName}] Bought ${position.symbol} (${finalSizeSol.toFixed(3)} SOL) - ${reason}`);
      await this.notificationService.notifyBuy(position, this.config.tradingMode);
      await this.telegramBot.notifyBuy(position, finalSizeSol);
      await this.syncAndRenderDashboard();
    }
  }

  private async handleTokenTrade(trade: TradeEvent): Promise<void> {
    const symbol = this.tokenSymbolMap.get(trade.mint) || 'UNKNOWN';

    const clusterReport = this.clusterDetector.trackEarlyTrade(trade);
    if (clusterReport && clusterReport.isBundled) {
      this.webServer.broadcastLog(`⚠️ Sybil Bundle Trap Rejected: ${trade.mint.substring(0,6)} (${clusterReport.warnings.join(', ')})`);
    }

    const stealthDrain = this.stealthRugDetector.trackTrade(trade);
    if (stealthDrain && stealthDrain.isDraining) {
      const position = this.config.tradingMode === 'live'
        ? this.liveTrader?.getPosition(trade.mint)
        : this.paperTrader?.getPosition(trade.mint);

      if (position && position.status === 'OPEN') {
        this.webServer.broadcastLog(`🚨 Stealth Drain Detected on ${position.symbol}! Executing defensive exit.`);
        const exitSignal: ExitSignal = {
          action: 'SELL',
          mint: position.mint,
          reason: 'CIRCUIT_BREAKER',
          sellRatio: 1.0,
          pnlPercent: position.pnlPercent,
          pnlSol: position.pnlSol
        };
        await this.executeExit(position, exitSignal);
      }
    }

    const whaleAlert = this.whaleTracker.evaluateTrade(trade, symbol);
    if (whaleAlert) {
      this.webServer.broadcastLog(`🐋 Whale Alert: ${whaleAlert.label} ${whaleAlert.action} ${whaleAlert.solAmount.toFixed(2)} SOL on ${whaleAlert.mint}`);
      this.telegramBot.notifyWhaleAlert(whaleAlert.label, whaleAlert.action, whaleAlert.solAmount, whaleAlert.mint);
    }

    if (trade.vSolInBondingCurve) {
      const pred = this.migrationPredictor.trackTick(trade.mint, symbol, trade.vSolInBondingCurve);
      this.latestPredictions.set(trade.mint, pred);
      if (pred.isImminent) {
        this.webServer.broadcastLog(`👑 KOTH Raydium Imminent: ${pred.symbol} (${pred.progressPercent}% - ~${pred.estimatedMinutesToGraduation || '?'} mins left)`);
      }
    }

    const isAlreadyOpen = this.config.tradingMode === 'live'
      ? this.liveTrader?.getPosition(trade.mint)?.status === 'OPEN'
      : this.paperTrader?.getPosition(trade.mint)?.status === 'OPEN';

    if (!isAlreadyOpen && this.copyTrader.shouldCopy(trade)) {
      const label = this.copyTrader.getWalletLabel(trade.traderPublicKey);
      this.webServer.broadcastLog(`🦈 Shark copy-trade triggered: ${label} on ${trade.mint}`);
      await this.executeStrategyTradeBuy(trade, 'COPY_WHALE', `Shark Follower: ${label}`, 1.2);
    }

    // Process Candidate Watchlist for moving coins (filters out dead 0-volume launches)
    const candidate = this.candidateWatchlist.get(trade.mint);
    if (!isAlreadyOpen && candidate) {
      candidate.tradesCount++;
      candidate.lastTradeTimestamp = Date.now();
      const rawSol = (trade.solAmount && !isNaN(trade.solAmount) && trade.solAmount > 0) ? trade.solAmount : 0;
      const sol = rawSol > 1e6 ? rawSol / 1e9 : rawSol;

      if (trade.txType === 'buy') {
        candidate.buyCount++;
        candidate.buyVolumeSol += sol;
        if (trade.traderPublicKey) {
          candidate.uniqueBuyers.add(trade.traderPublicKey);
        }
      } else if (trade.txType === 'sell') {
        candidate.sellCount++;
        candidate.sellVolumeSol += sol;
      }

      if (trade.vSolInBondingCurve && trade.vTokensInBondingCurve && trade.vTokensInBondingCurve > 0) {
        const spot = BondingCurveCalculator.calculateSpotPriceSol(trade.vSolInBondingCurve, trade.vTokensInBondingCurve);
        candidate.latestPriceSol = spot;
        if (spot > candidate.highestPriceSol) candidate.highestPriceSol = spot;
        candidate.bondingCurveProgress = BondingCurveCalculator.calculateProgress(trade.vSolInBondingCurve);
      }

      const priceGainPct = candidate.initialPriceSol > 0
        ? ((candidate.latestPriceSol - candidate.initialPriceSol) / candidate.initialPriceSol) * 100
        : 0;

      const minTrades = this.config.minBuyTradeCount || 5;
      const minBuyVol = this.config.minBuyVolumeSol || 0.5;
      const minProgress = this.config.minBondingCurveProgressPct || 1.5;

      // Confirmed Moving Coin criteria (strict — only buy coins that are ACTUALLY moving):
      // 1. At least minTrades buy trades across >= 3 unique buyer wallets (not wash trading)
      // 2. Cumulative buy volume >= minBuyVol SOL with buy volume dominating sell volume
      // 3. Confirmed positive price gain >= 2.0% AND bonding curve progress >= minProgress%
      // 4. Net buy volume positive (more buyers than sellers)
      const hasActiveBuyers = candidate.buyCount >= minTrades && candidate.uniqueBuyers.size >= 3;
      const hasVolumeBreakout = candidate.buyVolumeSol >= minBuyVol && candidate.buyVolumeSol > (candidate.sellVolumeSol * 1.3);
      const hasPriceMomentum = priceGainPct >= 2.0 && candidate.bondingCurveProgress >= minProgress;

      if (!candidate.evaluating && hasActiveBuyers && hasVolumeBreakout && hasPriceMomentum) {
        candidate.evaluating = true;
        await this.executeMovingCoinBuy(candidate, priceGainPct);
      }
    }

    if (!isAlreadyOpen) {
      const stratDecision = this.strategyManager.evaluateTradeTick(trade);
      if (stratDecision.shouldBuy) {
        await this.executeStrategyTradeBuy(
          trade,
          this.strategyCoordinator.getActiveStrategy(),
          stratDecision.reason,
          stratDecision.suggestedSizeMultiplier
        );
      }
    }

    const position = this.config.tradingMode === 'live'
      ? this.liveTrader?.getPosition(trade.mint)
      : this.paperTrader?.getPosition(trade.mint);

    if (!position || position.status !== 'OPEN') return;

    let newPriceSol = 0;
    if (trade.vSolInBondingCurve && trade.vTokensInBondingCurve && trade.vTokensInBondingCurve > 0) {
      newPriceSol = BondingCurveCalculator.calculateSpotPriceSol(trade.vSolInBondingCurve, trade.vTokensInBondingCurve);
      position.bondingCurveProgress = BondingCurveCalculator.calculateProgress(trade.vSolInBondingCurve);
    } else if (trade.solAmount && trade.tokenAmount && trade.tokenAmount > 0) {
      const sol = trade.solAmount > 1e6 ? trade.solAmount / 1e9 : trade.solAmount;
      const tokens = trade.tokenAmount > 1e6 ? trade.tokenAmount / 1e6 : trade.tokenAmount;
      newPriceSol = sol / tokens;
    }

    if (newPriceSol <= 0 || isNaN(newPriceSol) || !isFinite(newPriceSol)) return;

    const exitSignal = this.riskManager.updatePositionPrice(position, newPriceSol);
    if (exitSignal) {
      await this.executeExit(position, exitSignal);
    }
  }

  private async evaluateActivePositions(): Promise<void> {
    if (this.isEvaluatingPositions) return;
    this.isEvaluatingPositions = true;
    try {
      const positions = this.config.tradingMode === 'live'
        ? (this.liveTrader?.getOpenPositions() || [])
        : (this.paperTrader?.getOpenPositions() || []);

      for (const pos of positions) {
        const exitSignal = this.riskManager.updatePositionPrice(pos, pos.currentPriceSol);
        if (exitSignal) {
          await this.executeExit(pos, exitSignal);
        }
      }

      // Prune dead candidate coins that showed zero momentum within TTL (waste coins)
      const now = Date.now();
      const deadMints: string[] = [];
      for (const [mint, cand] of this.candidateWatchlist.entries()) {
        if (now - cand.addedAt > PumpFunAgent.CANDIDATE_WATCHLIST_TTL_MS) {
          deadMints.push(mint);
        }
      }
      if (deadMints.length > 0) {
        for (const mint of deadMints) {
          this.candidateWatchlist.delete(mint);
        }
        this.pumpPortal.unsubscribeTokenTrades(deadMints);
      }
    } finally {
      this.isEvaluatingPositions = false;
    }
  }

  private async executeExit(position: Position, exitSignal: ExitSignal): Promise<void> {
    const devPubkey = this.devPubkeyMap.get(position.mint);
    if (this.config.tradingMode === 'live' && this.liveTrader) {
      await this.liveTrader.executeSell(exitSignal, devPubkey);
    } else if (this.paperTrader) {
      await this.paperTrader.simulateSell(exitSignal, devPubkey);
    }

    const isWin = exitSignal.pnlSol >= 0;
    this.lossRecovery.recordOutcome(isWin);

    if (position.category) {
      this.researchEngine.recordSectorOutcome(position.category as TokenCategory, isWin, exitSignal.pnlSol);
    }

    this.clusterDetector.cleanup(position.mint);
    this.stealthRugDetector.cleanup(position.mint);
    if (position.status === 'CLOSED') {
      this.pumpPortal.unsubscribeTokenTrades([position.mint]);
    }

    this.webServer.broadcastLog(`Exited ${position.symbol} (${exitSignal.reason}) PnL: ${exitSignal.pnlPercent.toFixed(2)}%`);
    await this.notificationService.notifySell(position, exitSignal, this.config.tradingMode);
    await this.telegramBot.notifySell(position, exitSignal, this.config.tradingMode);
    await this.syncAndRenderDashboard();
  }

  public async panicSellAll(): Promise<void> {
    console.log(chalk.red.bold('\n[Agent] 🚨 EXECUTING PANIC SELL ALL ON ALL POSITIONS!'));
    const positions = this.config.tradingMode === 'live'
      ? (this.liveTrader?.getOpenPositions() || [])
      : (this.paperTrader?.getOpenPositions() || []);

    for (const pos of positions) {
      const emergencySignal: ExitSignal = {
        action: 'SELL',
        mint: pos.mint,
        reason: 'STOP_LOSS',
        sellRatio: 1.0,
        pnlPercent: pos.pnlPercent,
        pnlSol: pos.pnlSol
      };
      await this.executeExit(pos, emergencySignal);
    }
    this.webServer.broadcastLog('🚨 PANIC SELL ALL completed.');
  }

  public async sellSinglePosition(mint: string, ratio: number = 1.0): Promise<void> {
    const position = this.config.tradingMode === 'live'
      ? this.liveTrader?.getPosition(mint)
      : this.paperTrader?.getPosition(mint);

    if (position && position.status === 'OPEN') {
      const clampedRatio = Math.max(0.1, Math.min(1.0, ratio));
      const manualSignal: ExitSignal = {
        action: 'SELL',
        mint: position.mint,
        reason: clampedRatio >= 1.0 ? 'STOP_LOSS' : 'TAKE_PROFIT_1',
        sellRatio: clampedRatio,
        pnlPercent: position.pnlPercent,
        pnlSol: position.pnlSol
      };
      await this.executeExit(position, manualSignal);
    }
  }

  private async getTraderStats() {
    if (this.config.tradingMode === 'live' && this.liveTrader) {
      return await this.liveTrader.getStats();
    } else if (this.paperTrader) {
      return this.paperTrader.getStats();
    }
    return {
      startingBalanceSol: 0,
      currentBalanceSol: 0,
      vaultedBalanceSol: 0,
      vaultCyclesCompleted: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      realizedPnlSol: 0,
      totalVolumeSol: 0,
      winRate: 0,
      profitFactor: 0,
      expectancySol: 0,
      equityCurve: []
    };
  }

  public async syncAndRenderDashboard(): Promise<void> {
    if (this.isSyncingDashboard) return;
    this.isSyncingDashboard = true;
    try {
      const stats = await this.getTraderStats();

      const openPositions: Position[] = this.config.tradingMode === 'live'
        ? (this.liveTrader?.getOpenPositions() || [])
        : (this.paperTrader?.getOpenPositions() || []);

      const analytics = this.journal.getAnalytics();
      const vaultCycles = await this.profitVault.getHistory();
      const sectorStats = this.researchEngine.getSectorSummary();
      const whaleAlerts = this.whaleTracker.getRecentAlerts();
      const predictions = Array.from(this.latestPredictions.values()).slice(-6);

      const regime = this.strategyCoordinator.evaluateRegime(
        stats.winRate,
        stats.realizedPnlSol,
        predictions.filter(p => p.isImminent).length
      );

      if (this.config.activeStrategy !== regime.currentStrategy) {
        this.strategyManager.setActiveStrategy(regime.currentStrategy);
        this.config.activeStrategy = regime.currentStrategy;
      }

      this.webServer.broadcastState({
        config: this.config,
        stats,
        analytics,
        positions: openPositions,
        journalEntries: this.journal.getEntries().slice(-15).reverse(),
        vaultCycles: vaultCycles,
        sectorStats: sectorStats,
        whaleAlerts: whaleAlerts,
        predictions: predictions,
        marketRegime: regime,
        totalVaultedSol: this.profitVault.getTotalVaulted(),
        vaultCycleCount: this.profitVault.getCycleCount(),
        scannedCount: this.processedTokensCount,
        passedCount: this.passedTokensCount,
        candidateWatchlistCount: this.candidateWatchlist.size,
        activeStrategy: this.strategyCoordinator.getActiveStrategy()
      });

      const pnlColor = stats.realizedPnlSol >= 0 ? chalk.green : chalk.red;

      console.log(chalk.gray('\n---------------- [QUANTUM MATRIX v9.0 DASHBOARD] ----------------'));
      console.log(
        `Mode: ${chalk.bold.yellow(this.config.tradingMode.toUpperCase())} | ` +
        `Strategy: ${chalk.bold.cyan(this.strategyCoordinator.getActiveStrategy())} | ` +
        `Bankroll: ${chalk.bold(stats.currentBalanceSol.toFixed(4))} SOL | ` +
        `Vault: ${chalk.bold.yellow('🔒 ' + this.profitVault.getTotalVaulted().toFixed(4) + ' SOL (Cycle #' + this.profitVault.getCycleCount() + ')')} | ` +
        `Realized PnL: ${pnlColor((stats.realizedPnlSol >= 0 ? '+' : '') + stats.realizedPnlSol.toFixed(4) + ' SOL')} | ` +
        `Watchlist: ${chalk.bold.magenta(this.candidateWatchlist.size.toString())} moving candidates`
      );

      if (openPositions.length > 0) {
        const table = new Table({
          head: ['Token', 'Sector', 'AI Conf', 'Invested', 'Entry', 'Current', 'PnL %', 'PnL (SOL)'],
          style: { head: ['cyan'] }
        });

        for (const pos of openPositions) {
          const itemPnlColor = pos.pnlPercent >= 0 ? chalk.green : chalk.red;
          table.push([
            pos.symbol,
            pos.category || 'TECH_AI',
            pos.aiConfidence ? `${pos.aiConfidence}%` : 'N/A',
            `${pos.investedSol.toFixed(4)} SOL`,
            pos.entryPriceSol.toExponential(2),
            pos.currentPriceSol.toExponential(2),
            itemPnlColor(`${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(2)}%`),
            itemPnlColor(`${pos.pnlSol >= 0 ? '+' : ''}${pos.pnlSol.toFixed(4)}`)
          ]);
        }
        console.log(table.toString());
      } else {
        console.log(chalk.gray('  (Quantum Matrix monitoring Bonding Curves, Telegram Bot & Sandwich Guard...)'));
      }
      console.log(chalk.gray('-------------------------------------------------------------------\n'));
    } finally {
      this.isSyncingDashboard = false;
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
    this.candidateWatchlist.clear();
    this.telegramBot.stop();
    this.rpcFailover.stop();
    this.pumpPortal.disconnect();
    this.webServer.stop();
    await this.sqliteMemory.close();
    console.log(chalk.yellow('[Agent] Stopped cleanly. All positions and memory persisted in SQLite.'));
  }
}
