import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { OpenWallet, parseOpenWalletRequest } from '../application/wallets/open-wallet';
import { WalletQueries } from '../application/wallets/wallet-queries';
import { CorrelationId } from './correlation-id';
import { walletView, type WalletView } from './views';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly wallets: WalletQueries,
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
}
