/**
 * Why a transaction ended REJECTED or FAILED. These strings are part of the
 * public contract (API responses and events): add new ones, never rename.
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A ROLLBACK of a WIN/REFUND would leave the balance negative. Needs a human, not a retry. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Transaction currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** The wallet does not belong to the playerId sent. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',

  /** The referenced transaction never arrived within the retry budget. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference belongs to another player, wallet, round or currency. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** e.g. a REFUND pointing to a WIN, or a ROLLBACK pointing to a LOSS. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Reference exists but was itself rejected or failed, so there is nothing to revert. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND/ROLLBACK amount differs from the reference (partial reversals are not supported). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Reference was already reverted by a REFUND or ROLLBACK. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  /** Infrastructure kept failing after every retry (status FAILED, not REJECTED). */
  ProcessingFailed = 'PROCESSING_FAILED',
}
