import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';
import { loadConfig } from '../config';

async function main() {
  console.log(chalk.cyan.bold('\n======================================================'));
  console.log(chalk.cyan.bold('  💸 Solana Bot Wallet -> Phantom Withdraw / Sweep Tool'));
  console.log(chalk.cyan.bold('======================================================\n'));

  const config = loadConfig();
  const args = process.argv.slice(2);

  // 1. Check Bot Private Key
  if (!config.privateKey || config.privateKey.trim().length === 0) {
    console.error(chalk.red('❌ Error: No SOLANA_PRIVATE_KEY configured in .env file.'));
    console.log(chalk.yellow('Please configure your bot\'s private key in .env before withdrawing.\n'));
    process.exit(1);
  }

  let botKeypair: Keypair;
  try {
    const trimmed = config.privateKey.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      botKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
    } else {
      botKeypair = Keypair.fromSecretKey(bs58.decode(trimmed));
    }
  } catch (err: any) {
    console.error(chalk.red(`❌ Error loading bot private key: ${err.message}`));
    process.exit(1);
  }

  const botPubkey = botKeypair.publicKey;
  console.log(chalk.gray(`• Bot Wallet (Source):      ${chalk.bold.white(botPubkey.toBase58())}`));

  // 2. Determine Destination Address (Phantom)
  let destinationStr = args[0] || config.vaultDestinationWallet;
  let amountArg = args[1] || 'all';

  // If first argument is 'all' or a number and no second arg, check if destination was in .env
  if (args[0] && (args[0].toLowerCase() === 'all' || !isNaN(parseFloat(args[0])))) {
    if (config.vaultDestinationWallet) {
      destinationStr = config.vaultDestinationWallet;
      amountArg = args[0];
    }
  }

  if (!destinationStr || destinationStr.trim().length === 0) {
    console.log(chalk.yellow('⚠️  No destination Phantom wallet address specified.'));
    console.log(chalk.white('\nUsage:'));
    console.log(chalk.cyan('  npm run withdraw <PHANTOM_ADDRESS> [amount_sol|all]'));
    console.log(chalk.gray('  Example: npm run withdraw 7XYZ...abc all'));
    console.log(chalk.gray('  Example: npm run withdraw 7XYZ...abc 0.05'));
    console.log(chalk.white('\nOr set VAULT_DESTINATION_WALLET in your .env file:'));
    console.log(chalk.cyan('  VAULT_DESTINATION_WALLET=YourPhantomAddressHere'));
    console.log(chalk.cyan('  npm run withdraw\n'));
    process.exit(1);
  }

  let destPubkey: PublicKey;
  try {
    destPubkey = new PublicKey(destinationStr.trim());
    if (!PublicKey.isOnCurve(destPubkey.toBuffer())) {
      console.warn(chalk.yellow('⚠️  Warning: The destination address may be an off-curve address / PDA.'));
    }
  } catch (err: any) {
    console.error(chalk.red(`❌ Invalid Phantom destination public key: "${destinationStr}" (${err.message})`));
    process.exit(1);
  }

  console.log(chalk.gray(`• Phantom Wallet (Target):  ${chalk.bold.yellow(destPubkey.toBase58())}`));

  if (botPubkey.toBase58() === destPubkey.toBase58()) {
    console.error(chalk.red('❌ Source and destination addresses are identical.'));
    process.exit(1);
  }

  // 3. Connect to RPC with failover support
  const rpcList = [
    config.rpcUrl,
    'https://api.mainnet-beta.solana.com'
  ].filter((url, index, arr) => url && arr.indexOf(url) === index);

  let connection: Connection | null = null;
  let botBalanceLamports = 0;

  for (const rpcUrl of rpcList) {
    try {
      console.log(chalk.gray(`• Connecting to RPC:        ${rpcUrl}...`));
      const conn = new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000
      });
      botBalanceLamports = await conn.getBalance(botPubkey, 'confirmed');
      connection = conn;
      console.log(chalk.green(`  Connected successfully to RPC.`));
      break;
    } catch (err: any) {
      console.warn(chalk.yellow(`  RPC failed (${rpcUrl}): ${err.message}. Trying next fallback...`));
    }
  }

  if (!connection) {
    console.error(chalk.red('❌ Failed to connect to all provided RPC endpoints. Please check network connectivity or your SOLANA_RPC_URL.'));
    process.exit(1);
  }

  const botBalanceSol = botBalanceLamports / LAMPORTS_PER_SOL;
  console.log(chalk.cyan(`• Current Bot Balance:      ${botBalanceSol.toFixed(6)} SOL (${botBalanceLamports.toLocaleString()} lamports)`));

  if (botBalanceLamports <= 5000) {
    console.log(chalk.yellow('\n⚠️  Bot wallet balance is 0 or too low to cover standard transaction fees (5,000 lamports).'));
    console.log(chalk.gray('No remaining funds to sweep.\n'));
    process.exit(0);
  }

  // 4. Calculate Exact Fee and Transfer Amount
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Construct a dummy tx to accurately get exact transaction fee from Solana RPC
  const testTx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: botPubkey
  }).add(
    SystemProgram.transfer({
      fromPubkey: botPubkey,
      toPubkey: destPubkey,
      lamports: 1000
    })
  );

  let exactFeeLamports = 5000;
  try {
    const feeResult = await connection.getFeeForMessage(testTx.compileMessage(), 'confirmed');
    if (feeResult.value !== null && feeResult.value > 0) {
      exactFeeLamports = feeResult.value;
    }
  } catch {
    exactFeeLamports = 5000;
  }

  let transferLamports = 0;
  const isSweepAll = amountArg.toLowerCase() === 'all';

  if (isSweepAll) {
    // When sweeping all, send total balance minus exact fee so the remaining account balance becomes exactly 0
    transferLamports = botBalanceLamports - exactFeeLamports;
    if (transferLamports <= 0) {
      console.error(chalk.red(`❌ Balance (${botBalanceSol} SOL) is insufficient to pay network fee (${exactFeeLamports / LAMPORTS_PER_SOL} SOL).`));
      process.exit(1);
    }
  } else {
    const requestedSol = parseFloat(amountArg);
    if (isNaN(requestedSol) || requestedSol <= 0) {
      console.error(chalk.red(`❌ Invalid amount specified: "${amountArg}". Provide a positive number or "all".`));
      process.exit(1);
    }
    transferLamports = Math.floor(requestedSol * LAMPORTS_PER_SOL);
    const remainingAfterTransfer = botBalanceLamports - transferLamports - exactFeeLamports;

    if (remainingAfterTransfer < 0) {
      const maxPossibleSol = (botBalanceLamports - exactFeeLamports) / LAMPORTS_PER_SOL;
      console.error(
        chalk.red(
          `❌ Insufficient funds. Requested: ${requestedSol} SOL + fee, Available: ${botBalanceSol.toFixed(6)} SOL. (Max sweepable: ~${maxPossibleSol.toFixed(6)} SOL)`
        )
      );
      process.exit(1);
    }

    // Solana rent-exemption check for partial balance:
    // If remaining balance is between 1 and 890,880 lamports (~0.00089 SOL), Solana rejects it unless 0
    const MIN_RENT_EXEMPT_LAMPORTS = 890880;
    if (remainingAfterTransfer > 0 && remainingAfterTransfer < MIN_RENT_EXEMPT_LAMPORTS) {
      console.warn(
        chalk.yellow(
          `⚠️  Notice: Remaining balance (${remainingAfterTransfer} lamports) is below Solana rent exemption threshold (${MIN_RENT_EXEMPT_LAMPORTS} lamports). Automatically sweeping all remaining funds to 0.`
        )
      );
      transferLamports = botBalanceLamports - exactFeeLamports;
    }
  }

  const transferSol = transferLamports / LAMPORTS_PER_SOL;
  console.log(chalk.green.bold(`\nReady to transfer: ${transferSol.toFixed(6)} SOL to ${destPubkey.toBase58()}`));
  console.log(chalk.gray(`Network transaction fee: ${(exactFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${exactFeeLamports} lamports)`));

  // 5. Build and Send Final Transaction
  try {
    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: botPubkey
    }).add(
      SystemProgram.transfer({
        fromPubkey: botPubkey,
        toPubkey: destPubkey,
        lamports: transferLamports
      })
    );

    console.log(chalk.yellow('\n⏳ Broadcasting transaction to Solana network...'));

    const signature = await sendAndConfirmTransaction(connection, transaction, [botKeypair], {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed'
    });

    console.log(chalk.green.bold('\n======================================================'));
    console.log(chalk.green.bold('🎉 TRANSFER SUCCESSFUL!'));
    console.log(chalk.green.bold('======================================================'));
    console.log(chalk.white(`• Amount Transferred: ${chalk.bold.green(transferSol.toFixed(6))} SOL`));
    console.log(chalk.white(`• From (Bot):         ${chalk.bold.gray(botPubkey.toBase58())}`));
    console.log(chalk.white(`• To (Phantom):       ${chalk.bold.yellow(destPubkey.toBase58())}`));
    console.log(chalk.white(`• Transaction ID:     ${chalk.bold.cyan(signature)}`));
    console.log(chalk.gray(`• Solscan:            https://solscan.io/tx/${signature}`));
    console.log(chalk.gray(`• Solana Explorer:    https://explorer.solana.com/tx/${signature}`));

    // 6. Verify updated balance
    const updatedBalanceLamports = await connection.getBalance(botPubkey, 'confirmed');
    console.log(chalk.cyan(`\n• Updated Bot Wallet Balance: ${(updatedBalanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`));
  } catch (err: any) {
    console.error(chalk.red(`\n❌ Transaction failed: ${err.message}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
