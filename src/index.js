import { logger } from './logger.js';
import { startWebhookServer } from './webhook.js';
import { executeAction, getBalance, getPositions } from './trader.js';
import { runStrategyOnce, watchStrategy } from './strategy.js';

function parseArgs(tokens) {
  const args = {};
  const positional = [];

  for (const token of tokens) {
    if (token.startsWith('--')) {
      const [key, ...rest] = token.slice(2).split('=');
      args[key] = rest.length > 0 ? rest.join('=') : true;
    } else {
      positional.push(token);
    }
  }

  return { args, positional };
}

function printHelp() {
  console.log(`simple-trade-bot

Usage:
  node src/index.js serve
      Start the TradingView webhook server.

  node src/index.js balance <profileId> [spot|future]
      Show non-zero balances.

  node src/index.js positions <profileId>
      Show open futures positions.

  node src/index.js order --profile=<id> --market=<spot|future> --symbol=<SYMBOL> --action=<long|short|close> --amount=<n> [--amount-type=quote|base] [--price=<n>]

  node src/index.js strategy --profile=<id> --market=<spot|future> --symbol=<SYMBOL> --amount=<n> [--amount-type=quote|base] [--timeframe=15m] [--fast=7] [--slow=25] [--trend=99] [--dry-run] [--watch] [--interval=30]
      MA cross strategy (long: MA7 cross up MA25 & price>MA99; short: MA7 cross down MA25 & price<MA99).

Examples:
  node src/index.js order --profile=binance1 --market=spot --symbol=BTCUSDT --action=long --amount=100
  node src/index.js order --profile=binance1 --market=future --symbol=BTCUSDT --action=short --amount=50 --amount-type=quote
  node src/index.js order --profile=binance1 --market=future --symbol=BTC/USDT:USDT --action=close
  node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --timeframe=15m --dry-run
  node src/index.js strategy --profile=binance1 --market=future --symbol=BTCUSDT --amount=50 --watch --interval=30
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { args, positional } = parseArgs(rest);

  switch (command) {
    case 'serve':
      startWebhookServer();
      break;

    case 'balance': {
      const profileId = positional[0] || args.profile;
      const market = positional[1] || args.market || 'spot';
      const balances = await getBalance(profileId, market);
      console.table(balances);
      break;
    }

    case 'positions': {
      const profileId = positional[0] || args.profile;
      const positions = await getPositions(profileId);
      console.table(positions);
      break;
    }

    case 'order': {
      const result = await executeAction({
        profileId: args.profile,
        market: args.market,
        ticker: args.symbol,
        action: args.action,
        amount: args.amount,
        amountType: args['amount-type'],
        price: args.price
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'strategy': {
      const request = {
        profileId: args.profile,
        market: args.market,
        ticker: args.symbol || args.ticker,
        timeframe: args.timeframe,
        amount: args.amount ? Number(args.amount) : undefined,
        amountType: args['amount-type'],
        fast: args.fast ? Number(args.fast) : undefined,
        slow: args.slow ? Number(args.slow) : undefined,
        trend: args.trend ? Number(args.trend) : undefined,
        interval: args.interval ? Number(args.interval) : undefined,
        dryRun: args['dry-run'] === true || args['dry-run'] === 'true'
      };

      if (args.watch === true || args.watch === 'true') {
        await watchStrategy(request);
      } else {
        const result = await runStrategyOnce(request);
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    default:
      printHelp();
  }
}

main().catch(error => {
  logger.error(error.message || String(error));
  process.exit(1);
});
