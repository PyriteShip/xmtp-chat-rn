import {
  addGroupMembers,
  createGroup,
  GroupNotFoundError,
  leaveGroup,
  listGroupMembers,
  removeGroupMembers,
  UnreachableMembersError,
  updateGroup,
} from './groups';

const mockGetActiveXmtpClient = jest.fn();
jest.mock('./client', () => ({ getActiveXmtpClient: () => mockGetActiveXmtpClient() }));

beforeEach(() => jest.clearAllMocks());

function mockGroup() {
  return {
    id: 'g-1',
    addMembersByIdentity: jest.fn().mockResolvedValue({}),
    removeMembersByIdentity: jest.fn().mockResolvedValue(undefined),
    updateName: jest.fn().mockResolvedValue(undefined),
    updateImageUrl: jest.fn().mockResolvedValue(undefined),
    updateDescription: jest.fn().mockResolvedValue(undefined),
    leaveGroup: jest.fn().mockResolvedValue(undefined),
    updateConsent: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue(undefined),
    members: jest.fn().mockResolvedValue([
      { inboxId: 'me', identities: [{ kind: 'ETHEREUM', identifier: '0xME' }], permissionLevel: 'super_admin' },
      { inboxId: 'al', identities: [{ kind: 'ETHEREUM', identifier: '0xAL' }], permissionLevel: 'member' },
    ]),
  };
}

function mockClient(group: ReturnType<typeof mockGroup> | undefined, reachable: Record<string, boolean> = {}) {
  const client = {
    inboxId: 'me',
    publicIdentity: { identifier: '0xME', kind: 'ETHEREUM' },
    canMessage: jest.fn(async (ids: { identifier: string }[]) =>
      Object.fromEntries(ids.map((i) => [i.identifier, reachable[i.identifier] ?? true]))),
    conversations: {
      newGroupWithIdentities: jest.fn().mockResolvedValue(group),
      findGroup: jest.fn().mockResolvedValue(group),
    },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);
  return client;
}

describe('createGroup', () => {
  test('creates with lowercased member addresses and metadata, returning the id', async () => {
    const client = mockClient(mockGroup());
    const id = await createGroup(['0xAL', '0xBO'], { name: 'Climbers', description: 'Weekend crew' });
    expect(id).toBe('g-1');
    expect(client.conversations.newGroupWithIdentities).toHaveBeenCalledWith(
      [expect.objectContaining({ identifier: '0xal', kind: 'ETHEREUM' }), expect.objectContaining({ identifier: '0xbo' })],
      expect.objectContaining({ name: 'Climbers', description: 'Weekend crew', permissionLevel: 'all_members' }),
    );
  });

  test('adminOnly restricts membership and metadata changes to admins', async () => {
    const client = mockClient(mockGroup());
    await createGroup(['0xal'], { adminOnly: true });
    expect(client.conversations.newGroupWithIdentities).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ permissionLevel: 'admin_only' }),
    );
  });

  test('names every address with no XMTP inbox instead of creating', async () => {
    const client = mockClient(mockGroup(), { '0xbo': false, '0xcy': false });
    const err = await createGroup(['0xal', '0xBO', '0xcy']).catch((e) => e);
    expect(err).toBeInstanceOf(UnreachableMembersError);
    expect(err.addresses).toEqual(['0xbo', '0xcy']);
    expect(client.conversations.newGroupWithIdentities).not.toHaveBeenCalled();
  });

  test('dedupes addresses and drops my own', async () => {
    const client = mockClient(mockGroup());
    await createGroup(['0xal', '0xAL', '0xme']);
    const identities = client.conversations.newGroupWithIdentities.mock.calls[0][0];
    expect(identities.map((i: any) => i.identifier)).toEqual(['0xal']);
  });
});

test('addGroupMembers checks reachability, then adds', async () => {
  const group = mockGroup();
  mockClient(group, { '0xbo': false });
  await expect(addGroupMembers('g-1', ['0xBO'])).rejects.toBeInstanceOf(UnreachableMembersError);
  expect(group.addMembersByIdentity).not.toHaveBeenCalled();

  await addGroupMembers('g-1', ['0xCY']);
  expect(group.addMembersByIdentity).toHaveBeenCalledWith([expect.objectContaining({ identifier: '0xcy' })]);
});

test('removeGroupMembers removes by address', async () => {
  const group = mockGroup();
  mockClient(group);
  await removeGroupMembers('g-1', ['0xAL']);
  expect(group.removeMembersByIdentity).toHaveBeenCalledWith([expect.objectContaining({ identifier: '0xal' })]);
});

test('updateGroup changes only the fields given', async () => {
  const group = mockGroup();
  mockClient(group);
  await updateGroup('g-1', { name: 'New name' });
  expect(group.updateName).toHaveBeenCalledWith('New name');
  expect(group.updateImageUrl).not.toHaveBeenCalled();
  expect(group.updateDescription).not.toHaveBeenCalled();
});

test('leaveGroup leaves and denies consent, so the group drops out of the inbox', async () => {
  const group = mockGroup();
  mockClient(group);
  await leaveGroup('g-1');
  expect(group.leaveGroup).toHaveBeenCalled();
  expect(group.updateConsent).toHaveBeenCalledWith('denied');
});

test('listGroupMembers returns addresses and roles, me marked', async () => {
  mockClient(mockGroup());
  expect(await listGroupMembers('g-1')).toEqual([
    { inboxId: 'me', address: '0xme', role: 'super_admin', isMe: true },
    { inboxId: 'al', address: '0xal', role: 'member', isMe: false },
  ]);
});

test('an unknown group id throws GroupNotFoundError', async () => {
  mockClient(undefined);
  await expect(updateGroup('g-x', { name: 'x' })).rejects.toBeInstanceOf(GroupNotFoundError);
});
