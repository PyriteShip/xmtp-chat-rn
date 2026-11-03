/**
 * Group creation and membership, by wallet address.
 *
 * Standalone functions rather than hook methods, like `sendCard` and
 * `blockContact`: a host creates a group from a picker screen that has no
 * thread open, and manages members from a settings screen beside one. An open
 * `useGroup` sees every change here live — each one lands in the group as an
 * MLS update message, which the hook answers by re-reading the group's name,
 * image, app data and members.
 *
 * Addresses in, addresses out, lowercased. Adding a wallet with no XMTP inbox
 * would fail inside MLS with an opaque error, so the reachability check runs
 * first and names every such address at once (`UnreachableMembersError`).
 *
 * Permissions are the network's, not this module's: a member without the
 * permission a change needs is rejected by the SDK, and that error propagates
 * unchanged. A group's permissions are fixed at creation (`permissions`), and
 * its members' roles change with `setGroupMemberRole`.
 *
 * A group can carry `appData`, an opaque string the host owns — typically a
 * tag that marks a group as one the host made and can recognise again
 * (`findGroups`, and `useConversations`' group filter).
 *
 * `reconcileGroupMembers` keeps a group matched to a roster whose source of
 * truth lives outside XMTP. It commits only the difference, so any member's
 * device may run it, as often as it likes.
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

/** This address is not a member of the group. */
export class GroupMemberNotFoundError extends Error {
  constructor(public readonly groupId: string, public readonly address: string) {
    super(`${address} is not a member of group ${groupId}`);
    this.name = 'GroupMemberNotFoundError';
  }
}

export type GroupRole = 'member' | 'admin' | 'super_admin';

/** Who may make one kind of change (the SDK's `PermissionOption`). */
export type GroupPermissionOption = 'allow' | 'deny' | 'admin' | 'superAdmin';

/** A full permission policy (the SDK's `PermissionPolicySet`, which it does not export). */
export interface GroupPolicySet {
  addMemberPolicy: GroupPermissionOption;
  removeMemberPolicy: GroupPermissionOption;
  addAdminPolicy: GroupPermissionOption;
  removeAdminPolicy: GroupPermissionOption;
  updateGroupNamePolicy: GroupPermissionOption;
  updateGroupDescriptionPolicy: GroupPermissionOption;
  updateGroupImagePolicy: GroupPermissionOption;
  updateMessageDisappearingPolicy: GroupPermissionOption;
  updateAppDataPolicy: GroupPermissionOption;
}

/**
 * Who may change a group, fixed at creation.
 * - `everyoneManages`: any member adds and removes members and edits the
 *   group's details.
 * - `adminsManage`: admins (and super admins) do.
 * - `superAdminsManage`: only super admins make any change, including who is
 *   an admin and the group's `appData`.
 * Or a full `GroupPolicySet` for anything else.
 */
export type GroupPermissions = 'everyoneManages' | 'adminsManage' | 'superAdminsManage' | GroupPolicySet;

export const SUPER_ADMINS_MANAGE_POLICY: GroupPolicySet = {
  addMemberPolicy: 'superAdmin',
  removeMemberPolicy: 'superAdmin',
  addAdminPolicy: 'superAdmin',
  removeAdminPolicy: 'superAdmin',
  updateGroupNamePolicy: 'superAdmin',
  updateGroupDescriptionPolicy: 'superAdmin',
  updateGroupImagePolicy: 'superAdmin',
  updateMessageDisappearingPolicy: 'superAdmin',
  updateAppDataPolicy: 'superAdmin',
};

export interface CreateGroupOptions {
  name?: string;
  imageUrl?: string;
  description?: string;
  /** An opaque string the host owns, readable by every member (see `findGroups`). */
  appData?: string;
  /** Who may change the group. Default `everyoneManages`. */
  permissions?: GroupPermissions;
  /** Members to make super admins once the group exists (the creator always is one). */
  superAdmins?: string[];
  /** Members to make admins once the group exists. */
  admins?: string[];
  /** Shorthand for `permissions: 'adminsManage'`; ignored when `permissions` is given. */
  adminOnly?: boolean;
}

export interface GroupMember {
  inboxId: InboxId;
  /** Primary Ethereum address, lowercased ('' when the inbox has none). */
  address: string;
  role: GroupRole;
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

/** Which of `addresses` have an XMTP inbox, by lowercased address. */
async function reachability(addresses: string[]): Promise<Map<string, boolean>> {
  if (addresses.length === 0) return new Map();
  const result = await requireClient().canMessage(identities(addresses));
  return new Map(Object.entries(result).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Throw naming every address with no inbox; resolves when all are reachable. */
async function assertReachable(addresses: string[]): Promise<void> {
  const reach = await reachability(addresses);
  const missing = addresses.filter((a) => !reach.get(a));
  if (missing.length > 0) throw new UnreachableMembersError(missing);
}

/**
 * Create a group with these members (the active wallet is added as its super
 * admin) and return its id — open it with `useGroup`. `superAdmins` and
 * `admins` must be among the members; they get their role once the group
 * exists.
 */
export async function createGroup(memberAddresses: string[], options: CreateGroupOptions = {}): Promise<string> {
  const members = normalize(memberAddresses);
  await assertReachable(members);
  const permissions = options.permissions ?? (options.adminOnly ? 'adminsManage' : 'everyoneManages');
  const details = {
    name: options.name,
    imageUrl: options.imageUrl,
    description: options.description,
    appData: options.appData,
  };
  const conversations = requireClient().conversations;
  const group = (permissions === 'everyoneManages' || permissions === 'adminsManage'
    ? await conversations.newGroupWithIdentities(identities(members), {
        ...details,
        permissionLevel: permissions === 'adminsManage' ? 'admin_only' : 'all_members',
      })
    : await conversations.newGroupCustomPermissionsWithIdentities(
        identities(members),
        permissions === 'superAdminsManage' ? SUPER_ADMINS_MANAGE_POLICY : permissions,
        details,
      )) as Group<any>;

  const wanted = new Map<string, GroupRole>();
  for (const a of normalize(options.admins ?? [])) wanted.set(a, 'admin');
  for (const a of normalize(options.superAdmins ?? [])) wanted.set(a, 'super_admin');
  if (wanted.size > 0) {
    for (const m of toGroupMembers(await group.members(), requireClient().inboxId)) {
      const role = wanted.get(m.address);
      if (role) await applyRole(group, m, role);
    }
  }
  return group.id;
}

/** Move one member from their current role to `role`; false when they already hold it. */
async function applyRole(group: Group<any>, member: GroupMember, role: GroupRole): Promise<boolean> {
  if (member.role === role) return false;
  if (role === 'super_admin') {
    await group.addSuperAdmin(member.inboxId);
    if (member.role === 'admin') await group.removeAdmin(member.inboxId);
  } else if (role === 'admin') {
    if (member.role === 'super_admin') await group.removeSuperAdmin(member.inboxId);
    await group.addAdmin(member.inboxId);
  } else {
    if (member.role === 'super_admin') await group.removeSuperAdmin(member.inboxId);
    if (member.role === 'admin') await group.removeAdmin(member.inboxId);
  }
  return true;
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

/**
 * Make a member a plain member, an admin or a super admin; a no-op when they
 * already hold that role. The caller needs the group's add/remove-admin
 * permission (super admin under every preset).
 */
export async function setGroupMemberRole(groupId: string, address: string, role: GroupRole): Promise<void> {
  const group = await requireGroup(groupId);
  const target = address.trim().toLowerCase();
  const member = toGroupMembers(await group.members(), requireClient().inboxId).find((m) => m.address === target);
  if (!member) throw new GroupMemberNotFoundError(groupId, target);
  await applyRole(group, member, role);
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

/** The group's `appData` ('' when unset), as this installation last synced it. */
export async function getGroupAppData(groupId: string): Promise<string> {
  const group = await requireGroup(groupId);
  return (await group.appData()) ?? '';
}

/** Replace the group's `appData`. Needs the group's update-app-data permission. */
export async function updateGroupAppData(groupId: string, appData: string): Promise<void> {
  const group = await requireGroup(groupId);
  await group.updateAppData(appData);
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
      role: m.permissionLevel as GroupRole,
      isMe: m.inboxId === myInboxId,
    };
  });
}

export type GroupConsentState = 'allowed' | 'denied' | 'unknown';

/** A group as `findGroups` reports it. */
export interface GroupInfo {
  id: string;
  name: string;
  imageUrl: string;
  description: string;
  appData: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Whether this installation has allowed, denied or not yet decided on the group. */
  consentState: GroupConsentState;
}

/**
 * The groups this installation belongs to that `predicate` accepts, oldest
 * first: how a host finds the groups it tagged (by `appData`), and picks the
 * oldest when two were created for the same purpose at once. Syncs first.
 * `consentStates` defaults to allowed and unknown, the groups an inbox lists.
 */
export async function findGroups(
  predicate: (group: GroupInfo) => boolean = () => true,
  options: { consentStates?: GroupConsentState[] } = {},
): Promise<GroupInfo[]> {
  const conversations = requireClient().conversations;
  await conversations.syncAllConversations();
  const groups = (await conversations.listGroups(
    { name: true, imageUrl: true, description: true },
    undefined,
    options.consentStates ?? ['allowed', 'unknown'],
  )) as Group<any>[];
  const infos = await Promise.all(groups.map(async (g): Promise<GroupInfo> => ({
    id: g.id,
    name: g.groupName ?? '',
    imageUrl: g.groupImageUrl ?? '',
    description: g.groupDescription ?? '',
    appData: await readAppData(g),
    createdAt: g.createdAt,
    consentState: g.state as GroupConsentState,
  })));
  return infos.filter(predicate).sort((a, b) => a.createdAt - b.createdAt);
}

/** A group's app data, '' when unset or unreadable (shared with useConversations / useGroup). */
export async function readAppData(group: { appData: () => Promise<string> }): Promise<string> {
  try {
    return (await group.appData()) ?? '';
  } catch {
    return '';
  }
}

/** The roster `reconcileGroupMembers` matches a group to. */
export interface GroupRoster {
  /** Everyone who should be a member, besides me. */
  members: string[];
  /**
   * The roles members should hold. Given either list, every address in it
   * gets that role (super admin wins over admin) and every other address in
   * `members` becomes a plain member; omit both and roles are left alone.
   */
  superAdmins?: string[];
  admins?: string[];
  /**
   * Never removed, and never demoted below the role they hold, whatever the
   * roster says. I always am.
   */
  protect?: string[];
}

/** What `reconcileGroupMembers` changed, by lowercased address. */
export interface ReconcileResult {
  added: string[];
  removed: string[];
  /** Members whose role changed, with the role they now hold. */
  roleChanges: { address: string; role: GroupRole }[];
  /** Roster addresses with no XMTP inbox on this network, so not added. */
  unreachable: string[];
  /** Whether anything was committed. */
  changed: boolean;
}

/**
 * Match a group's members (and, when asked, their roles) to `roster`: add who
 * is missing, remove who should not be there, and fix roles, committing only
 * the difference — nothing at all when the group already matches. Adds run
 * before removals, so the group is never emptied part-way. Addresses with no
 * XMTP inbox are skipped and reported in `unreachable` rather than failing the
 * call. I am never removed or demoted, nor is anyone in `protect`.
 *
 * Several members' devices may run this for one group at once, so a failure
 * (most often another device's commit landing first) syncs the group and runs
 * the whole reconcile once more against the fresh state; a second failure
 * propagates. The caller needs whatever permissions the changes take.
 */
export async function reconcileGroupMembers(groupId: string, roster: GroupRoster): Promise<ReconcileResult> {
  const group = await requireGroup(groupId);
  try {
    return await reconcileOnce(group, roster);
  } catch {
    await group.sync();
    return reconcileOnce(group, roster);
  }
}

async function reconcileOnce(group: Group<any>, roster: GroupRoster): Promise<ReconcileResult> {
  const myInboxId = requireClient().inboxId;
  await group.sync();
  const wanted = new Set(normalize(roster.members));
  const protect = new Set(normalize(roster.protect ?? []));
  const managesRoles = roster.superAdmins !== undefined || roster.admins !== undefined;
  const roles = new Map<string, GroupRole>();
  if (managesRoles) {
    for (const a of wanted) roles.set(a, 'member');
    for (const a of normalize(roster.admins ?? [])) roles.set(a, 'admin');
    for (const a of normalize(roster.superAdmins ?? [])) roles.set(a, 'super_admin');
  }

  let current = toGroupMembers(await group.members(), myInboxId);
  const present = new Set(current.map((m) => m.address));
  const result: ReconcileResult = { added: [], removed: [], roleChanges: [], unreachable: [], changed: false };

  const missing = [...wanted].filter((a) => !present.has(a));
  if (missing.length > 0) {
    const reach = await reachability(missing);
    result.unreachable = missing.filter((a) => !reach.get(a));
    const toAdd = missing.filter((a) => reach.get(a));
    if (toAdd.length > 0) {
      await group.addMembersByIdentity(identities(toAdd));
      result.added = toAdd;
    }
  }

  const toRemove = current
    .filter((m) => !m.isMe && m.address !== '' && !wanted.has(m.address) && !protect.has(m.address))
    .map((m) => m.address);
  if (toRemove.length > 0) {
    await group.removeMembersByIdentity(identities(toRemove));
    result.removed = toRemove;
  }

  if (managesRoles) {
    if (result.added.length > 0 || result.removed.length > 0) {
      current = toGroupMembers(await group.members(), myInboxId);
    }
    for (const m of current) {
      if (m.isMe) continue;
      const role = roles.get(m.address);
      if (!role) continue;
      if (protect.has(m.address) && rank(role) < rank(m.role)) continue;
      if (await applyRole(group, m, role)) result.roleChanges.push({ address: m.address, role });
    }
  }

  result.changed = result.added.length > 0 || result.removed.length > 0 || result.roleChanges.length > 0;
  return result;
}

function rank(role: GroupRole): number {
  return role === 'super_admin' ? 2 : role === 'admin' ? 1 : 0;
}
