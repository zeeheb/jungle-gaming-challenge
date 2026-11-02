import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { OpenWallet, parseOpenWalletRequest } from '../application/wallets/open-wallet';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet';
import { WalletQueries } from '../application/wallets/wallet-queries';
import { CorrelationId } from './correlation-id';
import {
  ledgerPageView,
  reconciliationView,
  walletView,
  type LedgerPageView,
  type ReconciliationView,
  type WalletView,
} from './views';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly wallets: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /** 201 with the new wallet; 409 if the player already has one in this currency. */
  @Post()
  async open(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<WalletView> {
    const wallet = await this.openWallet.execute({ ...parseOpenWalletRequest(body), correlationId });
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return walletView(await this.wallets.getById(walletId));
  }

  /** Oldest entry first; follow nextCursor until it is null. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPageView> {
    return ledgerPageView(await this.wallets.getLedger(walletId, { cursor, limit }));
  }

  /** 200 whether or not the wallet is consistent: the check itself worked, `consistent` carries the verdict. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return reconciliationView(await this.reconcileWallet.execute(walletId));
  }
}
