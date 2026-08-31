import type { Database } from 'bun:sqlite'

export type ChannelMemberType = 'human' | 'agent'
export type ChannelRole = 'owner' | 'moderator' | 'member'

export type ChannelMembership = {
  channel_id: string
  member_type: ChannelMemberType
  member_id: string
  role: ChannelRole
  joined_at: string
  updated_at: string
  left_at: string | null
  status: 'active' | 'removed'
}

export function activeChannelMembership(
  db: Database,
  channelId: string,
  memberType: ChannelMemberType,
  memberId: string,
): ChannelMembership | null {
  return (db.prepare(`SELECT channel_id, member_type, member_id, role, joined_at, updated_at, left_at, status
    FROM channel_memberships
    WHERE channel_id=? AND member_type=? AND member_id=? AND status='active'`)
    .get(channelId, memberType, memberId) as ChannelMembership | null) || null
}

export function listChannelMemberships(db: Database, channelId: string, includeRemoved = false): ChannelMembership[] {
  const where = includeRemoved ? '' : `AND status='active'`
  return db.prepare(`SELECT channel_id, member_type, member_id, role, joined_at, updated_at, left_at, status
    FROM channel_memberships WHERE channel_id=? ${where}
    ORDER BY member_type DESC, role, joined_at`).all(channelId) as ChannelMembership[]
}

/**
 * Compatibility is deliberately one-way: only a private channel whose human
 * membership backfill is absent may fall back to its legacy owner. Shared
 * channels never use group_conversations.user_id as an authorization source.
 */
export function channelRoleForUser(db: Database, channelId: string, userId: string): ChannelRole | null {
  const membership = activeChannelMembership(db, channelId, 'human', userId)
  if (membership) return membership.role

  const channel = db.prepare(`SELECT scope, owner_user_id, user_id FROM group_conversations WHERE id=?`).get(channelId) as any
  if (!channel || channel.scope !== 'private') return null
  const activeHumanCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM channel_memberships
    WHERE channel_id=? AND member_type='human' AND status='active'`).get(channelId) as any)?.n || 0)
  if (activeHumanCount !== 0) return null
  return (channel.owner_user_id || channel.user_id) === userId ? 'owner' : null
}

export function canReadChannel(db: Database, channelId: string, userId: string): boolean {
  return channelRoleForUser(db, channelId, userId) !== null
}

export function canPostChannel(db: Database, channelId: string, userId: string): boolean {
  return channelRoleForUser(db, channelId, userId) !== null
}

export function canManageMembers(
  db: Database,
  channelId: string,
  userId: string,
  targetRole: ChannelRole = 'member',
): boolean {
  const role = channelRoleForUser(db, channelId, userId)
  if (role === 'owner') return true
  return role === 'moderator' && targetRole === 'member'
}

export function canStopExecution(
  db: Database,
  channelId: string,
  userId: string,
  executionOwnerUserId: string | null,
): boolean {
  const role = channelRoleForUser(db, channelId, userId)
  if (role === 'owner' || role === 'moderator') return true
  return role === 'member' && Boolean(executionOwnerUserId) && executionOwnerUserId === userId
}

export function upsertChannelMembership(
  db: Database,
  input: {
    channelId: string
    memberType: ChannelMemberType
    memberId: string
    role: ChannelRole
    now?: string
  },
): void {
  const now = input.now || new Date().toISOString()
  db.run(`INSERT INTO channel_memberships
    (channel_id, member_type, member_id, role, joined_at, updated_at, left_at, status)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'active')
    ON CONFLICT(channel_id, member_type, member_id) DO UPDATE SET
      role=excluded.role, updated_at=excluded.updated_at, left_at=NULL, status='active'`, [
    input.channelId, input.memberType, input.memberId, input.role, now, now,
  ])
}

export function removeChannelMembership(
  db: Database,
  input: {
    channelId: string
    memberType: ChannelMemberType
    memberId: string
    actorUserId: string
    now?: string
  },
): { removed: boolean; error?: 'FORBIDDEN' | 'LAST_OWNER' | 'NOT_FOUND' } {
  const target = activeChannelMembership(db, input.channelId, input.memberType, input.memberId)
  if (!target) return { removed: false, error: 'NOT_FOUND' }
  if (!canManageMembers(db, input.channelId, input.actorUserId, target.role)) {
    return { removed: false, error: 'FORBIDDEN' }
  }
  if (target.member_type === 'human' && target.role === 'owner') {
    const owners = Number((db.prepare(`SELECT COUNT(*) AS n FROM channel_memberships
      WHERE channel_id=? AND member_type='human' AND role='owner' AND status='active'`)
      .get(input.channelId) as any)?.n || 0)
    if (owners <= 1) return { removed: false, error: 'LAST_OWNER' }
  }
  const now = input.now || new Date().toISOString()
  const result = db.prepare(`UPDATE channel_memberships
    SET status='removed', left_at=?, updated_at=?
    WHERE channel_id=? AND member_type=? AND member_id=? AND status='active'`)
    .run(now, now, input.channelId, input.memberType, input.memberId)
  return result.changes === 1 ? { removed: true } : { removed: false, error: 'NOT_FOUND' }
}
