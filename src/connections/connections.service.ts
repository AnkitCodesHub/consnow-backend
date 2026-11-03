import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThan, Repository } from 'typeorm';
import { Connection, ConnectionStatus } from '../entities/connection.entity';
import { User } from '../entities/user.entity';
import {
  ConnectionRequest,
  ConnectionRequestStatus,
} from '../entities/connection-request.entity';

/** How long a Connect request stays open. */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** After a decline, the sender must wait this long before asking again. */
export const DECLINE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
/** Server-side Undo window (the app shows a 5 s snackbar; the extra covers slow networks). */
export const UNDO_WINDOW_MS = 15 * 1000;

/** What a friend row looks like from the caller's side. */
export type PeerState =
  | 'connected'
  | 'disconnected'
  | 'request_sent'
  | 'request_received'
  | 'cooldown';

export type ConnectionEventType =
  | 'connected'
  | 'disconnected'
  | 'request_sent'
  | 'request_received'
  | 'request_accepted'
  | 'request_declined'
  | 'request_cancelled';

/** Sent to ONE user (userId) about one friend (peerId). Used for WebSocket + push. */
export interface ConnectionEvent {
  userId: string;
  peerId: string;
  type: ConnectionEventType;
  peerName?: string;
  requestId?: string;
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);
  private readonly listeners: ((e: ConnectionEvent) => unknown)[] = [];

  constructor(
    @InjectRepository(Connection)
    private readonly connectionRepository: Repository<Connection>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(ConnectionRequest)
    private readonly requestRepository: Repository<ConnectionRequest>,
  ) {}

  /** WebSocket gateway and push service subscribe here (avoids a module cycle). */
  onEvent(listener: (e: ConnectionEvent) => unknown) {
    this.listeners.push(listener);
  }

  private emit(...events: ConnectionEvent[]) {
    for (const e of events) {
      for (const l of this.listeners) {
        Promise.resolve()
          .then(() => l(e))
          .catch((err) => this.logger.warn(`listener failed: ${err?.message ?? err}`));
      }
    }
  }

  // ── Connect by code (first time) ────────────────────────────────────────

  async createConnection(currentUserId: string, connectionCode: string) {
    const targetUser = await this.userRepository.findOne({
      where: { connectionCode: connectionCode.toUpperCase() },
    });

    if (!targetUser) {
      throw new NotFoundException('Invalid connection code');
    }

    if (targetUser.id === currentUserId) {
      throw new BadRequestException('Cannot connect to yourself');
    }

    const existing = await this.findPair(currentUserId, targetUser.id);

    if (existing) {
      if (existing.status === ConnectionStatus.ACTIVE) {
        // Idempotent: return existing active connection without error
        return this.formatConnection(existing, currentUserId);
      }
      if (existing.status === ConnectionStatus.REVOKED) {
        // They were connected and one side disconnected. Re-entering the code must NOT
        // silently reconnect (that would skip the other person's consent), so it sends
        // a normal Connect request instead. Mutual requests still connect instantly.
        const result = await this.requestConnect(currentUserId, targetUser.id);
        const fresh = (await this.findPair(currentUserId, targetUser.id))!;
        return { ...this.formatConnection(fresh, currentUserId), ...result };
      }
      throw new ConflictException('Connection already exists');
    }

    const connection = this.connectionRepository.create({
      userAId: currentUserId,
      userBId: targetUser.id,
      status: ConnectionStatus.ACTIVE,
    });

    const saved = await this.connectionRepository.save(connection);
    // Reload with relations
    const loaded = await this.connectionRepository.findOne({
      where: { id: saved.id },
      relations: ['userA', 'userB'],
    });
    const me = loaded!.userAId === currentUserId ? loaded!.userA : loaded!.userB;
    this.emit({ userId: targetUser.id, peerId: currentUserId, type: 'connected', peerName: me?.name });
    return this.formatConnection(loaded!, currentUserId);
  }

  // ── Friends list ────────────────────────────────────────────────────────

  /**
   * includeDisconnected=false keeps the old response (active only) for app versions
   * that don't know about disconnected rows yet.
   */
  async getConnections(currentUserId: string, includeDisconnected = false) {
    const statuses = includeDisconnected
      ? [ConnectionStatus.ACTIVE, ConnectionStatus.REVOKED]
      : [ConnectionStatus.ACTIVE];
    const connections = await this.connectionRepository.find({
      where: [
        { userAId: currentUserId, status: In(statuses) },
        { userBId: currentUserId, status: In(statuses) },
      ],
      relations: ['userA', 'userB'],
      order: { createdAt: 'ASC' },
    });

    if (!includeDisconnected) {
      return connections.map((c) => this.formatConnection(c, currentUserId));
    }

    const now = new Date();
    const [pending, recentDeclines] = await Promise.all([
      this.requestRepository.find({
        where: [
          { fromUserId: currentUserId, status: ConnectionRequestStatus.PENDING, expiresAt: MoreThan(now) },
          { toUserId: currentUserId, status: ConnectionRequestStatus.PENDING, expiresAt: MoreThan(now) },
        ],
      }),
      this.requestRepository.find({
        where: {
          fromUserId: currentUserId,
          status: ConnectionRequestStatus.DECLINED,
          respondedAt: MoreThan(new Date(now.getTime() - DECLINE_COOLDOWN_MS)),
        },
      }),
    ]);

    return connections.map((c) => {
      const base = this.formatConnection(c, currentUserId);
      const peerId = base.peer.id;
      if (c.status === ConnectionStatus.ACTIVE) {
        return { ...base, state: 'connected' as PeerState };
      }
      const incoming = pending.find((r) => r.fromUserId === peerId && r.toUserId === currentUserId);
      const outgoing = pending.find((r) => r.fromUserId === currentUserId && r.toUserId === peerId);
      const declined = recentDeclines
        .filter((r) => r.toUserId === peerId && r.respondedAt)
        .sort((a, b) => b.respondedAt!.getTime() - a.respondedAt!.getTime())[0];

      let state: PeerState = 'disconnected';
      let request: ConnectionRequest | undefined;
      let cooldownUntil: string | null = null;
      if (incoming) {
        state = 'request_received';
        request = incoming;
      } else if (outgoing) {
        state = 'request_sent';
        request = outgoing;
      } else if (declined) {
        state = 'cooldown';
        cooldownUntil = new Date(declined.respondedAt!.getTime() + DECLINE_COOLDOWN_MS).toISOString();
      }
      return {
        ...base,
        state,
        requestId: request?.id ?? null,
        requestExpiresAt: request?.expiresAt?.toISOString() ?? null,
        cooldownUntil,
        disconnectedByMe: c.disconnectedBy === currentUserId,
      };
    });
  }

  // ── Disconnect + Undo ───────────────────────────────────────────────────

  async disconnect(currentUserId: string, peerId: string) {
    const conn = await this.requirePair(currentUserId, peerId);
    if (conn.status === ConnectionStatus.REVOKED) {
      return { state: 'disconnected' as PeerState, undoUntil: null };
    }
    const now = new Date();
    conn.status = ConnectionStatus.REVOKED;
    conn.disconnectedBy = currentUserId;
    conn.disconnectedAt = now;
    await this.connectionRepository.save(conn);
    await this.closePendingBetween(currentUserId, peerId, ConnectionRequestStatus.CANCELLED);

    // Silent for the other person (no push), but both screens update live.
    this.emit(
      { userId: peerId, peerId: currentUserId, type: 'disconnected' },
      { userId: currentUserId, peerId, type: 'disconnected' },
    );
    return {
      state: 'disconnected' as PeerState,
      undoUntil: new Date(now.getTime() + UNDO_WINDOW_MS).toISOString(),
    };
  }

  async undoDisconnect(currentUserId: string, peerId: string) {
    const conn = await this.requirePair(currentUserId, peerId);
    if (conn.status === ConnectionStatus.ACTIVE) return { state: 'connected' as PeerState };
    const withinWindow =
      conn.disconnectedBy === currentUserId &&
      conn.disconnectedAt != null &&
      Date.now() - conn.disconnectedAt.getTime() <= UNDO_WINDOW_MS;
    if (!withinWindow) {
      throw new ConflictException('Undo is no longer available. Send a Connect request instead.');
    }
    await this.activate(conn);
    await this.closePendingBetween(currentUserId, peerId, ConnectionRequestStatus.CANCELLED);
    this.emit(
      { userId: peerId, peerId: currentUserId, type: 'connected' },
      { userId: currentUserId, peerId, type: 'connected' },
    );
    return { state: 'connected' as PeerState };
  }

  // ── Requests ────────────────────────────────────────────────────────────

  /** Tap "Connect" on a disconnected friend. */
  async requestConnect(currentUserId: string, peerId: string) {
    if (currentUserId === peerId) throw new BadRequestException('Cannot connect to yourself');
    const conn = await this.findPair(currentUserId, peerId);
    if (!conn) {
      throw new NotFoundException('You were never connected with this user. Use their code instead.');
    }
    if (conn.status === ConnectionStatus.ACTIVE) return { state: 'connected' as PeerState };

    const now = new Date();

    // Both tapped Connect: that is mutual consent, connect right away.
    const incoming = await this.requestRepository.findOne({
      where: {
        fromUserId: peerId,
        toUserId: currentUserId,
        status: ConnectionRequestStatus.PENDING,
        expiresAt: MoreThan(now),
      },
    });
    if (incoming) {
      await this.acceptRequest(currentUserId, incoming.id);
      return { state: 'connected' as PeerState };
    }

    const outgoing = await this.requestRepository.findOne({
      where: {
        fromUserId: currentUserId,
        toUserId: peerId,
        status: ConnectionRequestStatus.PENDING,
        expiresAt: MoreThan(now),
      },
    });
    if (outgoing) {
      return {
        state: 'request_sent' as PeerState,
        requestId: outgoing.id,
        requestExpiresAt: outgoing.expiresAt.toISOString(),
      };
    }

    const declined = await this.requestRepository.findOne({
      where: {
        fromUserId: currentUserId,
        toUserId: peerId,
        status: ConnectionRequestStatus.DECLINED,
        respondedAt: MoreThan(new Date(now.getTime() - DECLINE_COOLDOWN_MS)),
      },
      order: { respondedAt: 'DESC' },
    });
    if (declined?.respondedAt) {
      const cooldownUntil = new Date(declined.respondedAt.getTime() + DECLINE_COOLDOWN_MS);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Request was declined. You can ask again later.',
          cooldownUntil: cooldownUntil.toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const request = await this.requestRepository.save(
      this.requestRepository.create({
        fromUserId: currentUserId,
        toUserId: peerId,
        status: ConnectionRequestStatus.PENDING,
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      }),
    );
    const me = await this.userRepository.findOne({ where: { id: currentUserId } });
    this.emit(
      { userId: peerId, peerId: currentUserId, type: 'request_received', requestId: request.id, peerName: me?.name },
      { userId: currentUserId, peerId, type: 'request_sent', requestId: request.id },
    );
    return {
      state: 'request_sent' as PeerState,
      requestId: request.id,
      requestExpiresAt: request.expiresAt.toISOString(),
    };
  }

  /** Requests waiting for MY answer (the inbox). Expired ones are left out. */
  async listIncomingRequests(currentUserId: string) {
    const requests = await this.requestRepository.find({
      where: {
        toUserId: currentUserId,
        status: ConnectionRequestStatus.PENDING,
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });
    if (requests.length === 0) return [];
    const users = await this.userRepository.find({
      where: { id: In(requests.map((r) => r.fromUserId)) },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return requests.map((r) => ({
      id: r.id,
      from: { id: r.fromUserId, name: names.get(r.fromUserId) ?? '' },
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  async acceptRequest(currentUserId: string, requestId: string) {
    const request = await this.requirePendingRequest({ id: requestId, toUserId: currentUserId });
    const conn = await this.requirePair(currentUserId, request.fromUserId);
    await this.activate(conn);
    request.status = ConnectionRequestStatus.ACCEPTED;
    request.respondedAt = new Date();
    await this.requestRepository.save(request);
    // An opposite request (I had also asked) is now settled too
    await this.closePendingBetween(currentUserId, request.fromUserId, ConnectionRequestStatus.ACCEPTED);

    const me = await this.userRepository.findOne({ where: { id: currentUserId } });
    this.emit(
      { userId: request.fromUserId, peerId: currentUserId, type: 'request_accepted', peerName: me?.name, requestId },
      { userId: currentUserId, peerId: request.fromUserId, type: 'connected', requestId },
    );
    const fresh = (await this.findPair(currentUserId, request.fromUserId))!;
    return { ...this.formatConnection(fresh, currentUserId), state: 'connected' as PeerState };
  }

  async declineRequest(currentUserId: string, requestId: string) {
    const request = await this.requestRepository.findOne({
      where: { id: requestId, toUserId: currentUserId },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== ConnectionRequestStatus.PENDING) return { success: true };
    request.status = ConnectionRequestStatus.DECLINED;
    request.respondedAt = new Date();
    await this.requestRepository.save(request);
    this.emit(
      { userId: request.fromUserId, peerId: currentUserId, type: 'request_declined', requestId },
      { userId: currentUserId, peerId: request.fromUserId, type: 'request_declined', requestId },
    );
    return { success: true };
  }

  async cancelRequest(currentUserId: string, requestId: string) {
    const request = await this.requestRepository.findOne({
      where: { id: requestId, fromUserId: currentUserId },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== ConnectionRequestStatus.PENDING) return { success: true };
    request.status = ConnectionRequestStatus.CANCELLED;
    request.respondedAt = new Date();
    await this.requestRepository.save(request);
    this.emit(
      { userId: request.toUserId, peerId: currentUserId, type: 'request_cancelled', requestId },
      { userId: currentUserId, peerId: request.toUserId, type: 'request_cancelled', requestId },
    );
    return { success: true };
  }

  // ── Consent check used by steps / activity / profile views ──────────────

  async hasActiveConnection(userIdA: string, userIdB: string): Promise<boolean> {
    const count = await this.connectionRepository
      .createQueryBuilder('c')
      .where(
        '((c.user_a_id = :a AND c.user_b_id = :b) OR (c.user_a_id = :b AND c.user_b_id = :a))',
        { a: userIdA, b: userIdB },
      )
      .andWhere('c.status = :status', { status: ConnectionStatus.ACTIVE })
      .getCount();

    return count > 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private findPair(a: string, b: string) {
    return this.connectionRepository.findOne({
      where: [
        { userAId: a, userBId: b },
        { userAId: b, userBId: a },
      ],
      relations: ['userA', 'userB'],
    });
  }

  private async requirePair(a: string, b: string) {
    const conn = await this.findPair(a, b);
    if (!conn) throw new NotFoundException('Connection not found');
    return conn;
  }

  private async requirePendingRequest(where: FindOptionsWhere<ConnectionRequest>) {
    const request = await this.requestRepository.findOne({ where });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== ConnectionRequestStatus.PENDING || request.expiresAt.getTime() <= Date.now()) {
      throw new HttpException('This request has expired or was already answered', HttpStatus.GONE);
    }
    return request;
  }

  private async activate(conn: Connection) {
    conn.status = ConnectionStatus.ACTIVE;
    conn.disconnectedBy = null;
    conn.disconnectedAt = null;
    await this.connectionRepository.save(conn);
  }

  /** Close every still-pending request between two users (either direction). */
  private async closePendingBetween(a: string, b: string, status: ConnectionRequestStatus) {
    const open = await this.requestRepository.find({
      where: [
        { fromUserId: a, toUserId: b, status: ConnectionRequestStatus.PENDING },
        { fromUserId: b, toUserId: a, status: ConnectionRequestStatus.PENDING },
      ],
    });
    if (open.length === 0) return;
    const now = new Date();
    for (const r of open) {
      r.status = status;
      r.respondedAt = now;
    }
    await this.requestRepository.save(open);
  }

  private formatConnection(connection: Connection, currentUserId: string) {
    const peer =
      connection.userAId === currentUserId
        ? connection.userB
        : connection.userA;
    return {
      id: connection.id,
      status: connection.status,
      peer: {
        id: peer.id,
        name: peer.name,
        sharingEnabled: peer.sharingEnabled,
      },
      createdAt: connection.createdAt,
    };
  }
}
