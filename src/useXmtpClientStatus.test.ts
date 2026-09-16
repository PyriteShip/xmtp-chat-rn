import { act, renderHook } from '@testing-library/react-native';
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import { dropXmtpClient, getOrCreateXmtpClient } from './client';
import { useXmtpClientStatus } from './useXmtpClientStatus';

const create = Client.create as jest.Mock;
const identity = { address: '0xABC', signer: {} as any };

beforeEach(async () => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await dropXmtpClient();
});

test('re-renders through a failure and the retry that recovers it', async () => {
  const { result } = renderHook(() => useXmtpClientStatus());
  expect(result.current.status.state).toBe('idle');

  create.mockRejectedValueOnce(new Error('network down'));
  await act(async () => { await getOrCreateXmtpClient(identity).catch(() => {}); });
  expect(result.current.status).toEqual({ state: 'failed', address: '0xabc', error: 'network down' });

  create.mockResolvedValueOnce({ installationId: 'inst-2' });
  await act(async () => { await result.current.retry(); });
  expect(result.current.status.state).toBe('ready');
});
