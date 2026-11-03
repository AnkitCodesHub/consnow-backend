import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 255, unique: true })
  @Index()
  email: string;

  @Column({ name: 'password_hash', length: 255 })
  passwordHash: string;

  @Column({ name: 'connection_code', length: 8, unique: true })
  @Index()
  connectionCode: string;

  @Column({ name: 'sharing_enabled', default: true })
  sharingEnabled: boolean;

  /** Firebase Cloud Messaging token of the user's phone (for connect-request pushes). */
  @Column({ name: 'fcm_token', type: 'varchar', length: 512, nullable: true, select: false })
  fcmToken: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
