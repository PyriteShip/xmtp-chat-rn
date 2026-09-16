import { useSyncExternalStore } from 'react';
import {
  getXmtpClientStatus,
  retryXmtpClient,
  subscribeXmtpClient,
  type XmtpClientStatus,
} from './client';

export interface UseXmtpClientStatusResult {
  status: XmtpClientStatus;
  /** Re-run creation for the identity that failed. See `retryXmtpClient`. */
  retry: typeof retryXmtpClient;
}

/**
 * Client creation status for a surface that depends on messaging, with the
 * retry that recovers a failure. A surface that reports messaging as
 * unavailable should offer `retry` — without it, a failed creation stays failed
 * until the app restarts.
 */
export function useXmtpClientStatus(): UseXmtpClientStatusResult {
  const status = useSyncExternalStore(subscribeXmtpClient, getXmtpClientStatus, getXmtpClientStatus);
  return { status, retry: retryXmtpClient };
}
