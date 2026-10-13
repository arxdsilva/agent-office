import { ValidationError } from '@agent-office/core'

/** 'catalog', 'p/<prj_…>' or 's/<ses_…>'. Anything else (e.g. '../x') is rejected. */
export const PARTITION = /^(catalog|[ps]\/[a-z]{3}_[a-z0-9]{10,24})$/

export function checkPartition(partition: string): void {
  if (typeof partition !== 'string' || !PARTITION.test(partition)) {
    throw new ValidationError('invalid vault partition')
  }
}
