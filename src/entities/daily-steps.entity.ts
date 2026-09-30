import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

@Entity('daily_steps')
@Unique(['userId', 'date'])
export class DailySteps {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ type: 'date' })
  @Index()
  date: string;

  @Column({ name: 'step_count', type: 'int', default: 0 })
  stepCount: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
