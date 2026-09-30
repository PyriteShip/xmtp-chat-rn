/**
 * Group creation and membership, by wallet address.
 *
 * Standalone functions rather than hook methods, like `sendCard` and
 * `blockContact`: a host creates a group from a picker screen that has no
 * thread open, and manages members from a settings screen beside one. An open
 * `useGroup` sees every change here live — each one lands in the group as an
 * MLS update message, which the hook answers by re-reading the group's name,
 * image and members.
 *
 * Addresses in, addresses out, lowercased. Adding a wallet with no XMTP inbox
 * would fail inside MLS with an opaque error, so the reachability check runs
 * first and names every such address at once (`UnreachableMembersError`).
 *
 * Permissions are the network's, not this module's: in an `adminOnly` group a
 * non-admin's add, remove or rename is rejected by the SDK, and that error
 * propagates unchanged.
 */

import { PublicIdentity, type Group, type InboxId } from '@xmtp/react-native-sdk';
import { getActiveXmtpClient } from './client';

/** Some addresses have no XMTP inbox on this network, so they can't be members. */
export class UnreachableMembersError extends Error {
  constructor(public readonly addresses: string[]) {
    super(`No XMTP inbox for: ${addresses.join(', ')}`);
    this.name = 'UnreachableMembersError';
  }
}

/** This installation holds no group with that id. */
export class GroupNotFoundError extends Error {
  constructor(public readonly groupId: string) {
    super(`Group not found: ${groupId}`);
    this.name = 'GroupNotFoundError';
  }
}

export interface CreateGroupOptions {
  name?: string;
  imageUrl?: string;
  description?: string;
  /**
   * Only admins may add or remove members and change the name, image and
   * description. The creator is the group's super admin either way. Default
   * false: every member may.
   */
  adminOnly?: boolean;
}

export interface GroupMember {
  inboxId: InboxId;
  /** Primary Ethereum address, lowercased ('' when the inbox has none). */
  address: string;
  role: 'member' | 'admin' | 'super_admin';
  isMe: boolean;
}

function requireClient() {
  const client = getActiveXmtpClient();
  if (!client) throw new Error('Messaging unavailable');
  return client;
}

async function requireGroup(groupId: string): Promise<Group<any>> {
  const group = await requireClient().conversations.findGroup(groupId as any);
  if (!group) throw new GroupNotFoundError(groupId);
  return group as Group<any>;
}

function identities(addresses: string[]): PublicIdentity[] {
  return addresses.map((a) => new PublicIdentity(a, 'ETHEREUM'));
}

/** Lowercase, dedupe, and drop the active wallet's own address. */
function normalize(addresses: string[]): string[] {
  const me = requireClient().publicIdentity?.identifier?.toLowerCase();
  return [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a && a !== me);
}

/** Throw naming every address with no inbox; resolves when all are reachable. */
async function assertReachable(addresses: string[]): Promise<void> {
  if (addresses.length === 0) return;
  const result = await requireClient().canMessage(identities(addresses));
  const byAddress = new Map(Object.entries(result).map(([k, v]) => [k.toLowerCase(), v]));
  const missing = addresses.filter((a) => !byAddress.get(a));
  if (missing.length > 0) throw new UnreachableMembersError(missing);
}

/**
 * Create a group with these members (the active wallet is added as its super
 * admin) and return its id — open it with `useGroup`.
 */
export async function createGroup(memberAddresses: string[], options: CreateGroupOptions = {}): Promise<string> {
  const members = normalize(memberAddresses);
  await assertReachable(members);
  const group = await requireClient().conversations.newGroupWithIdentities(identities(members), {
    name: options.name,
    imageUrl: options.imageUrl,
    description: options.description,
    permissionLevel: options.adminOnly ? 'admin_only' : 'all_members',
  });
  return group.id;
}

export async function addGroupMembers(groupId: string, addresses: string[]): Promise<void> {
  const members = normalize(addresses);
  if (members.length === 0) return;
  const group = await requireGroup(groupId);
  await assertReachable(members);
  await group.addMembersByIdentity(identities(members));
}

export async function removeGroupMembers(groupId: string, addresses: string[]): Promise<void> {
  const members = normalize(addresses);
  if (members.length === 0) return;
  const group = await requireGroup(groupId);
  await group.removeMembersByIdentity(identities(members));
}

/** Change the group's name, image or description; fields left out are untouched. */
export async function updateGroup(
  groupId: string,
  changes: { name?: string; imageUrl?: string; description?: string },
): Promise<void> {
  const group = await requireGroup(groupId);
  if (changes.name !== undefined) await group.updateName(changes.name);
  if (changes.imageUrl !== undefined) await group.updateImageUrl(changes.imageUrl);
  if (changes.description !== undefined) await group.updateDescription(changes.description);
}

/**
 * Leave the group, and deny it so it drops out of `useConversations` (which
 * lists allowed and unknown conversations only) rather than lingering as an
 * inactive row. The other members see this member removed.
 */
export async function leaveGroup(groupId: string): Promise<void> {
  const group = await requireGroup(groupId);
  await group.leaveGroup();
  await group.updateConsent('denied');
}

/** The group's members as this installation last synced them. */
export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const group = await requireGroup(groupId);
  return toGroupMembers(await group.members(), requireClient().inboxId);
}

/** Shared with useGroup, which re-reads members on every membership change. */
export function toGroupMembers(
  members: { inboxId: InboxId; identities: { kind: string; identifier: string }[]; permissionLevel: string }[],
  myInboxId: InboxId,
): GroupMember[] {
  return members.map((m) => {
    const eth = m.identities.find((i) => i.kind === 'ETHEREUM') ?? m.identities[0];
    return {
      inboxId: m.inboxId,
      address: eth?.identifier?.toLowerCase() ?? '',
      role: m.permissionLevel as GroupMember['role'],
      isMe: m.inboxId === myInboxId,
    };
  });
}
