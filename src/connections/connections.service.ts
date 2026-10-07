import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Connection, ConnectionStatus } from '../entities/connection.entity';
import { User } from '../entities/user.entity';

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(Connection)
    private readonly connectionRepository: Repository<Connection>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

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

    // Check for existing connection in either direction (idempotency)
  const existing = await this.connectionRepository
    .createQueryBuilder('c')
    .leftJoinAndSelect('c.userA', 'userA')
    .leftJoinAndSelect('c.userB', 'userB')
    .where(
        '((c.user_a_id = :uid AND c.user_b_id = :tid) OR (c.user_a_id = :tid AND c.user_b_id = :uid))',
        { uid: currentUserId, tid: targetUser.id },
    )
    .getOne();

    if (existing) {
      if (existing.status === ConnectionStatus.ACTIVE) {
        // Idempotent: return existing active connection without error
        return this.formatConnection(existing, currentUserId);
      }
      if (existing.status === ConnectionStatus.REVOKED) {
        // Reactivate
        existing.status = ConnectionStatus.ACTIVE;
        const saved = await this.connectionRepository.save(existing);
        return this.formatConnection(saved, currentUserId);
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
    return this.formatConnection(loaded!, currentUserId);
  }

  async getConnections(currentUserId: string) {
    const connections = await this.connectionRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.userA', 'userA')
      .leftJoinAndSelect('c.userB', 'userB')
      .where(
        '(c.user_a_id = :uid OR c.user_b_id = :uid) AND c.status = :status',
        { uid: currentUserId, status: ConnectionStatus.ACTIVE },
      )
      .getMany();

    return connections.map((c) => this.formatConnection(c, currentUserId));
  }

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
