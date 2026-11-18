import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58Module from 'bs58';
import axios from 'axios';
import chalk from 'chalk';
import { loadConfig } from '../config';
import { SQLiteMemory } from '../services/sqliteMemory';

const bs58 = (bs58Module as any).default || bs58Module;
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

interface OpenTokenPosition {
  mint: string;
  uiAmount: number;
  decimals: number;
  programId: string;
}

async function closeLivePositions() {
  console.log(chalk.cyan.bold('\n======================================================'));
  console.log(chalk.cyan.bold('  🎯 Solana Live Mode Position Closer'));
  console.log(chalk.cyan.bold('======================================================\n'));

  const config = loadConfig();

  if (!config.privateKey || config.privateKey.trim().length === 0) {
    console.error(chalk.red('❌ Error: No SOLANA_PRIVATE_KEY configured in .env file.'));
    process.exit(1);
  }

  let keypair: Keypair;
  try {
    const trimmed = config.privateKey.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(trimmed));
    }
  } catch (err: any) {
    console.error(chalk.red(`❌ Error loading private key: ${err.message}`));
    process.exit(1);
  }

  const walletPubkey = keypair.publicKey;
  console.log(chalk.gray(`• Wallet Public Key: ${chalk.bold.white(walletPubkey.toBase58())}`));

  const connection = new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');

  // 1. Check On-Chain SOL Balance (for gas fee)
  let balanceLamports = 0;
  try {
    balanceLamports = await connection.getBalance(walletPubkey);
  } catch (err: any) {
    console.warn(chalk.yellow(`Warning: RPC getBalance error (${err.message}). Trying fallback RPC...`));
    const fallbackConn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    balanceLamports = await fallbackConn.getBalance(walletPubkey);
  }

  const balanceSol = balanceLamports / 1e9;
  console.log(chalk.gray(`• On-Chain SOL Balance: ${chalk.bold.yellow(`${balanceSol.toFixed(6)} SOL`)} (${balanceLamports.toLocaleString()} Lamports)`));

  // 2. Scan both standard SPL Token & Token-2022 accounts
  console.log(chalk.cyan('\n🔍 Scanning blockchain for open token positions...'));

  const openPositions: OpenTokenPosition[] = [];

  // Scan SPL Token Program
  try {
    const splAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM_ID
    });
    for (const act of splAccounts.value) {
      const info = act.account.data.parsed.info;
      const uiAmt = parseFloat(info.tokenAmount.uiAmountString || '0');
      if (uiAmt > 0) {
        openPositions.push({
          mint: info.mint,
          uiAmount: uiAmt,
          decimals: info.tokenAmount.decimals,
          programId: 'SPL-Token'
        });
      }
    }
  } catch (err: any) {
    console.warn(chalk.yellow(`Warning scanning SPL Token program: ${err.message}`));
  }

  // Scan Token-2022 Program
  try {
    const token2022Accounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_2022_PROGRAM_ID
    });
    for (const act of token2022Accounts.value) {
      const info = act.account.data.parsed.info;
      const uiAmt = parseFloat(info.tokenAmount.uiAmountString || '0');
      if (uiAmt > 0) {
        openPositions.push({
          mint: info.mint,
          uiAmount: uiAmt,
          decimals: info.tokenAmount.decimals,
          programId: 'Token-2022'
        });
      }
    }
  } catch (err: any) {
    console.warn(chalk.yellow(`Warning scanning Token-2022 program: ${err.message}`));
  }

  if (openPositions.length === 0) {
    console.log(chalk.green('\n✅ No open token positions found on-chain for this wallet.'));
    // Also clean up SQLite active positions if any stale records exist
    const memory = new SQLiteMemory();
    await memory.init();
    await memory.close();
    return;
  }

  console.log(chalk.yellow(`\nFound ${openPositions.length} open position(s) to close:`));
  for (const pos of openPositions) {
    console.log(chalk.white(`  • Mint: ${chalk.bold.cyan(pos.mint)} | Amount: ${chalk.bold.yellow(pos.uiAmount.toLocaleString())} (${pos.programId})`));
  }

  // Check gas fee requirement
  const MIN_GAS_SOL = 0.0008; // ~800,000 lamports for base fee + priority fee
  if (balanceSol < MIN_GAS_SOL) {
    console.log(chalk.red.bold('\n❌ CANNOT EXECUTE TRANSACTION: INSUFFICIENT SOL FOR GAS FEE'));
    console.log(chalk.yellow(
      `\nTo close an open position on the Solana network, the blockchain requires a tiny transaction network fee (gas).\n` +
      `Current Balance: ${balanceSol.toFixed(6)} SOL (Need at least ~0.001 SOL).\n\n` +
      `👉 Please deposit a tiny amount of SOL (e.g. 0.002 to 0.005 SOL, ~$0.30 - $0.70) into your wallet:\n` +
      `   ${chalk.bold.green(walletPubkey.toBase58())}\n\n` +
      `Once funded, rerun this command to automatically close the position and recover your SOL:\n` +
      `   ${chalk.bold.cyan('npm run close-live')}\n`
    ));
    process.exit(1);
  }

  // 3. Execute 100% Sell via PumpPortal API for each open position
  for (const pos of openPositions) {
    console.log(chalk.cyan(`\n🚀 Submitting 100% SELL transaction for ${pos.mint}...`));

    try {
      const response = await axios.post(
        'https://pumpportal.fun/api/trade-local',
        {
          publicKey: walletPubkey.toBase58(),
          action: 'sell',
          mint: pos.mint,
          amount: '100%',
          denominatedInSol: 'false',
          slippage: 25,
          priorityFee: 0.0005,
          pool: 'pump'
        },
        {
          responseType: 'arraybuffer',
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );

      if (response.status !== 200) {
        console.error(chalk.red(`PumpPortal returned status: ${response.status}`));
        continue;
      }

      const txBuffer = Buffer.from(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([keypair]);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      });

      console.log(chalk.green.bold(`\n✅ Position Closed Successfully!`));
      console.log(chalk.green(`• Sold: 100% (${pos.uiAmount.toLocaleString()} tokens)`));
      console.log(chalk.cyan(`• Solscan TX: https://solscan.io/tx/${signature}\n`));
    } catch (err: any) {
      if (err.response && err.response.data) {
        const errorText = Buffer.from(err.response.data).toString('utf-8');
        console.error(chalk.red(`❌ PumpPortal Error: ${errorText}`));
      } else {
        console.error(chalk.red(`❌ Transaction Error: ${err.message}`));
      }
    }
  }

  // Clean SQLite active positions
  const memory = new SQLiteMemory();
  await memory.init();
  for (const pos of openPositions) {
    await memory.removeActivePosition(pos.mint);
  }
  await memory.close();
  console.log(chalk.green('✅ SQLite memory synchronized.'));
}

closeLivePositions().catch(err => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
