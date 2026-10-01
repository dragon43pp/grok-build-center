/**
 * Re-export of the shared session contract.
 *
 * The contract itself lives in `shared/session-history.ts`, because the
 * renderer needs the same types and the same aggregation helpers. The readers
 * in this directory import `../types`, and this shim keeps that path working
 * while there is exactly one definition.
 *
 * Anything that needs to *read* sessions belongs in this directory; anything
 * that only describes or adds up what was read belongs in `shared/`.
 */
export * from '../../shared/session-history'
