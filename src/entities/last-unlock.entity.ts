import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('last_unlock')
export class LastUnlock {
  @PrimaryColumn()
  userId: string;

  @Column({ type: 'timestamptz' })
  unlockedAt: Date;

  @Column({ default: true })
  isLocked: boolean;
}