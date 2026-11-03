import {
  addGroupMembers,
  createGroup,
  findGroups,
  getGroupAppData,
  GroupMemberNotFoundError,
  GroupNotFoundError,
  leaveGroup,
  listGroupMembers,
  reconcileGroupMembers,
  removeGroupMembers,
  setGroupMemberRole,
  SUPER_ADMINS_MANAGE_POLICY,
  UnreachableMembersError,
  updateGroup,
  updateGroupAppData,
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
    appData: jest.fn().mockResolvedValue('tag'),
    updateAppData: jest.fn().mockResolvedValue(undefined),
    addAdmin: jest.fn().mockResolvedValue(undefined),
    removeAdmin: jest.fn().mockResolvedValue(undefined),
    addSuperAdmin: jest.fn().mockResolvedValue(undefined),
    removeSuperAdmin: jest.fn().mockResolvedValue(undefined),
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
      newGroupCustomPermissionsWithIdentities: jest.fn().mockResolvedValue(group),
      findGroup: jest.fn().mockResolvedValue(group),
      syncAllConversations: jest.fn().mockResolvedValue(undefined),
      listGroups: jest.fn().mockResolvedValue([]),
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

/** A member row as the SDK reports it. */
function row(inboxId: string, address: string, permissionLevel = 'member') {
  return { inboxId, identities: [{ kind: 'ETHEREUM', identifier: address }], permissionLevel };
}

describe('createGroup options', () => {
  test('carries app data, and superAdminsManage creates with the custom super-admin policy', async () => {
    const client = mockClient(mockGroup());
    await createGroup(['0xal'], { appData: 'app:v1', permissions: 'superAdminsManage' });
    expect(client.conversations.newGroupWithIdentities).not.toHaveBeenCalled();
    expect(client.conversations.newGroupCustomPermissionsWithIdentities).toHaveBeenCalledWith(
      [expect.objectContaining({ identifier: '0xal' })],
      SUPER_ADMINS_MANAGE_POLICY,
      expect.objectContaining({ appData: 'app:v1' }),
    );
  });

  test('a full policy set is passed through as given', async () => {
    const client = mockClient(mockGroup());
    const policy = { ...SUPER_ADMINS_MANAGE_POLICY, addMemberPolicy: 'allow' as const };
    await createGroup(['0xal'], { permissions: policy });
    expect(client.conversations.newGroupCustomPermissionsWithIdentities).toHaveBeenCalledWith(expect.anything(), policy, expect.anything());
  });

  test('adminsManage and the adminOnly shorthand use the built-in admin_only level', async () => {
    const client = mockClient(mockGroup());
    await createGroup(['0xal'], { permissions: 'adminsManage', appData: 'x' });
    expect(client.conversations.newGroupWithIdentities).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ permissionLevel: 'admin_only', appData: 'x' }),
    );
  });

  test('makes the named members super admins and admins once the group exists', async () => {
    const group = mockGroup();
    group.members.mockResolvedValue([row('me', '0xME', 'super_admin'), row('al', '0xAL'), row('bo', '0xBO')]);
    mockClient(group);
    await createGroup(['0xal', '0xbo'], { superAdmins: ['0xAL'], admins: ['0xbo'] });
    expect(group.addSuperAdmin).toHaveBeenCalledWith('al');
    expect(group.addAdmin).toHaveBeenCalledWith('bo');
  });
});

describe('setGroupMemberRole', () => {
  test('promotes an admin to super admin, dropping the admin role', async () => {
    const group = mockGroup();
    group.members.mockResolvedValue([row('me', '0xME', 'super_admin'), row('al', '0xAL', 'admin')]);
    mockClient(group);
    await setGroupMemberRole('g-1', '0xAL', 'super_admin');
    expect(group.addSuperAdmin).toHaveBeenCalledWith('al');
    expect(group.removeAdmin).toHaveBeenCalledWith('al');
  });

  test('demotes a super admin to a plain member', async () => {
    const group = mockGroup();
    group.members.mockResolvedValue([row('me', '0xME', 'super_admin'), row('al', '0xAL', 'super_admin')]);
    mockClient(group);
    await setGroupMemberRole('g-1', '0xal', 'member');
    expect(group.removeSuperAdmin).toHaveBeenCalledWith('al');
    expect(group.removeAdmin).not.toHaveBeenCalled();
  });

  test('does nothing when the member already holds the role', async () => {
    const group = mockGroup();
    mockClient(group);
    await setGroupMemberRole('g-1', '0xal', 'member');
    expect(group.addAdmin).not.toHaveBeenCalled();
    expect(group.removeAdmin).not.toHaveBeenCalled();
  });

  test('throws for someone who is not a member', async () => {
    mockClient(mockGroup());
    await expect(setGroupMemberRole('g-1', '0xzz', 'admin')).rejects.toBeInstanceOf(GroupMemberNotFoundError);
  });
});

test('getGroupAppData and updateGroupAppData read and replace the tag', async () => {
  const group = mockGroup();
  mockClient(group);
  expect(await getGroupAppData('g-1')).toBe('tag');
  await updateGroupAppData('g-1', 'tag:v2');
  expect(group.updateAppData).toHaveBeenCalledWith('tag:v2');
});

describe('findGroups', () => {
  function listed(id: string, createdAt: number, appData: string) {
    return {
      id, createdAt, groupName: id, groupImageUrl: '', groupDescription: '', state: 'allowed',
      appData: jest.fn().mockResolvedValue(appData),
    };
  }

  test('syncs, then returns the groups the predicate accepts, oldest first', async () => {
    const client = mockClient(mockGroup());
    client.conversations.listGroups.mockResolvedValue([
      listed('newer', 2_000, 'lib:a'), listed('other', 1_500, 'something else'), listed('older', 1_000, 'lib:a'),
    ]);
    const found = await findGroups((g) => g.appData === 'lib:a');
    expect(client.conversations.syncAllConversations).toHaveBeenCalled();
    expect(found.map((g) => g.id)).toEqual(['older', 'newer']);
    expect(found[0]).toEqual(expect.objectContaining({ appData: 'lib:a', createdAt: 1_000, consentState: 'allowed' }));
  });

  test('lists allowed and unknown groups unless told otherwise', async () => {
    const client = mockClient(mockGroup());
    await findGroups();
    expect(client.conversations.listGroups.mock.calls[0][2]).toEqual(['allowed', 'unknown']);
    await findGroups(undefined, { consentStates: ['denied'] });
    expect(client.conversations.listGroups.mock.calls[1][2]).toEqual(['denied']);
  });
});

describe('reconcileGroupMembers', () => {
  function rosterGroup(rows: ReturnType<typeof row>[]) {
    const group = mockGroup();
    group.members.mockResolvedValue(rows);
    return group;
  }

  test('commits nothing when the group already matches', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin'), row('al', '0xAL')]);
    mockClient(group);
    const result = await reconcileGroupMembers('g-1', { members: ['0xal'] });
    expect(result).toEqual({ added: [], removed: [], roleChanges: [], unreachable: [], changed: false });
    expect(group.addMembersByIdentity).not.toHaveBeenCalled();
    expect(group.removeMembersByIdentity).not.toHaveBeenCalled();
  });

  test('adds who is missing before removing who should not be there', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin'), row('al', '0xAL'), row('ex', '0xEX')]);
    const order: string[] = [];
    group.addMembersByIdentity.mockImplementation(async () => { order.push('add'); return {}; });
    group.removeMembersByIdentity.mockImplementation(async () => { order.push('remove'); });
    mockClient(group);
    const result = await reconcileGroupMembers('g-1', { members: ['0xAL', '0xBO'] });
    expect(result.added).toEqual(['0xbo']);
    expect(result.removed).toEqual(['0xex']);
    expect(result.changed).toBe(true);
    expect(order).toEqual(['add', 'remove']);
  });

  test('skips and reports addresses with no inbox instead of failing', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin')]);
    mockClient(group, { '0xno': false });
    const result = await reconcileGroupMembers('g-1', { members: ['0xno', '0xok'] });
    expect(result.unreachable).toEqual(['0xno']);
    expect(result.added).toEqual(['0xok']);
  });

  test('never removes me or a protected member', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin'), row('bw', '0xBW')]);
    mockClient(group);
    const result = await reconcileGroupMembers('g-1', { members: [], protect: ['0xBW'] });
    expect(result.removed).toEqual([]);
    expect(group.removeMembersByIdentity).not.toHaveBeenCalled();
  });

  test('with roles given, promotes the listed and demotes the rest; a protected member keeps a higher role', async () => {
    const group = rosterGroup([
      row('me', '0xME', 'super_admin'), row('al', '0xAL'), row('ex', '0xEX', 'super_admin'), row('bw', '0xBW', 'super_admin'),
    ]);
    mockClient(group);
    const result = await reconcileGroupMembers('g-1', {
      members: ['0xal', '0xex', '0xbw'], superAdmins: ['0xal'], protect: ['0xbw'],
    });
    expect(result.roleChanges).toEqual([
      { address: '0xal', role: 'super_admin' },
      { address: '0xex', role: 'member' },
    ]);
    expect(group.addSuperAdmin).toHaveBeenCalledWith('al');
    expect(group.removeSuperAdmin).toHaveBeenCalledWith('ex');
    expect(group.removeSuperAdmin).not.toHaveBeenCalledWith('bw');
  });

  test('without roles, leaves everyone\'s role alone', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin'), row('al', '0xAL', 'admin')]);
    mockClient(group);
    await reconcileGroupMembers('g-1', { members: ['0xal'] });
    expect(group.removeAdmin).not.toHaveBeenCalled();
  });

  test('a failed commit syncs and runs once more against the fresh state', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin')]);
    group.addMembersByIdentity
      .mockRejectedValueOnce(new Error('commit conflict'))
      .mockResolvedValue({});
    mockClient(group);
    const result = await reconcileGroupMembers('g-1', { members: ['0xal'] });
    expect(group.addMembersByIdentity).toHaveBeenCalledTimes(2);
    expect(result.added).toEqual(['0xal']);
  });

  test('a second failure propagates', async () => {
    const group = rosterGroup([row('me', '0xME', 'super_admin')]);
    group.addMembersByIdentity.mockRejectedValue(new Error('still failing'));
    mockClient(group);
    await expect(reconcileGroupMembers('g-1', { members: ['0xal'] })).rejects.toThrow('still failing');
  });
});
