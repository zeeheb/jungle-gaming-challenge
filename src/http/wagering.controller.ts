import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { assertActsAsItself } from '../application/provider-identity';
import { ProcessWagerTransaction } from '../application/wagering/process-wager-transaction';
import { WagerTransactionQueries } from '../application/wagering/wager-transaction-queries';
import { parseIdempotencyKey, parseWagerRequest } from '../application/wagering/wager-request';
import { CorrelationId } from './correlation-id';
import { AuthenticatedProvider, ProviderAuthGuard } from './provider-auth.guard';
import { httpStatusFor, submissionView, transactionView, type SubmissionView, type TransactionView } from './views';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WagerTransactionQueries) private readonly transactions: WagerTransactionQueries,
  ) {}

  /** 200 processed, 202 pending, 422 rejected; the same status again on every replay. */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @AuthenticatedProvider() provider: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionView> {
    const key = parseIdempotencyKey(idempotencyKey);
    const payload = parseWagerRequest(body);
    assertActsAsItself(provider, payload.providerId);
    const result = await this.processWager.execute({ idempotencyKey: key, payload, correlationId });
    response.status(httpStatusFor(result.transaction.status));
    return submissionView(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(
    @Param('transactionId') transactionId: string,
    @AuthenticatedProvider() provider: string | undefined,
  ): Promise<TransactionView> {
    const transaction = await this.transactions.getById(transactionId);
    assertActsAsItself(provider, transaction.providerId);
    return transactionView(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @AuthenticatedProvider() provider: string | undefined,
  ): Promise<TransactionView> {
    assertActsAsItself(provider, providerId);
    return transactionView(await this.transactions.getByExternalId(providerId, externalTransactionId));
  }
}
