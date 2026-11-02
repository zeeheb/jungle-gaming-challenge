import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransaction } from '../application/wagering/process-wager-transaction';
import { WagerTransactionQueries } from '../application/wagering/wager-transaction-queries';
import { parseIdempotencyKey, parseWagerRequest } from '../application/wagering/wager-request';
import { CorrelationId } from './correlation-id';
import { httpStatusFor, submissionView, transactionView, type SubmissionView, type TransactionView } from './views';

@Controller()
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
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionView> {
    const result = await this.processWager.execute({
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
      payload: parseWagerRequest(body),
      correlationId,
    });
    response.status(httpStatusFor(result.transaction.status));
    return submissionView(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return transactionView(await this.transactions.getById(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return transactionView(await this.transactions.getByExternalId(providerId, externalTransactionId));
  }
}
