import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum ConnectionRequestStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  CANCELLED = 'cancelled',
}

/**
 * A "Connect" tap between two people who were connected before and one of them
 * disconnected. Expiry is computed (status pending AND expires_at in the future),
 * so no cleanup job is needed.
 */
@Entity('connection_requests')
export class ConnectionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'from_user_id', type: 'uuid' })
  fromUserId: string;

  @Column({ name: 'to_user_id', type: 'uuid' })
  toUserId: string;

  @Column({ type: 'varchar', length: 16, default: ConnectionRequestStatus.PENDING })
  status: ConnectionRequestStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}
