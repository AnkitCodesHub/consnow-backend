import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One time a friend opened someone's profile screen. Kept for ~48h, then purged. */
@Entity('profile_views')
@Index('idx_profile_views_owner_viewed', ['ownerId', 'viewedAt'])
@Index('idx_profile_views_viewer_owner', ['viewerId', 'ownerId', 'viewedAt'])
export class ProfileView {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'viewer_id', type: 'uuid' })
  viewerId: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @CreateDateColumn({ name: 'viewed_at', type: 'timestamptz' })
  viewedAt: Date;
}
