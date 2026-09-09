// Stub for the native XMTP SDK. Every method is a jest.fn() so a test can drive
// the client lifecycle — including the failure modes that only ever appeared on
// device, like an inbox at the 10-installation cap.
class PublicIdentity {
  constructor(identifier, kind) { this.identifier = identifier; this.kind = kind; }
}

const Client = {
  create: jest.fn(),
  dropClient: jest.fn().mockResolvedValue(undefined),
  getOrCreateInboxId: jest.fn().mockResolvedValue('inbox-1'),
  inboxStatesForInboxIds: jest.fn().mockResolvedValue([{ installations: [] }]),
  revokeInstallations: jest.fn().mockResolvedValue(undefined),
};

class XMTPPush {
  constructor(client) { this.client = client; }
  subscribe = jest.fn().mockResolvedValue(undefined);
  static register = jest.fn();
}

class ReplyCodec {}
class ReactionCodec {}
class ReactionV2Codec {}
class ReadReceiptCodec {
  contentType = { authorityId: 'xmtp.org', typeId: 'readReceipt', versionMajor: 1, versionMinor: 0 };
}

module.exports = {
  Client, PublicIdentity, XMTPPush,
  ReplyCodec, ReactionCodec, ReactionV2Codec, ReadReceiptCodec,
};
