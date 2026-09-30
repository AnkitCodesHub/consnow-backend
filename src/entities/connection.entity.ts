import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

export enum ConnectionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

@Entity('connections')
@Unique(['userAId', 'userBId'])
export class Connection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_a_id' })
  @Index()
  userA: User;

  @Column({ name: 'user_a_id' })
  userAId: string;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_b_id' })
  @Index()
  userB: User;

  @Column({ name: 'user_b_id' })
  userBId: string;

  @Column({
    type: 'enum',
    enum: ConnectionStatus,
    default: ConnectionStatus.ACTIVE,
  })
  status: ConnectionStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
