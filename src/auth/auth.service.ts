//edited on 26/10/2026 by ankit pandey
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Injectable, ConflictException, UnauthorizedException, NotFoundException } from '@nestjs/common';


@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  private generateConnectionCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private async getUniqueConnectionCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = this.generateConnectionCode();
      const existing = await this.userRepository.findOne({
        where: { connectionCode: code },
      });
      if (!existing) return code;
    }
    throw new Error('Failed to generate unique connection code');
  }

  async register(dto: RegisterDto) {
    const existing = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const connectionCode = await this.getUniqueConnectionCode();

    const user = this.userRepository.create({
      name: dto.name,
      email: dto.email.toLowerCase(),
      passwordHash,
      connectionCode,
    });

    const saved = await this.userRepository.save(user);

    return {
      token: this.generateToken(saved),
      user: this.sanitizeUser(saved),
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      token: this.generateToken(user),
      user: this.sanitizeUser(user),
    };
  }

  /** Sliding session: a still-valid token is swapped for a fresh one. */
  refresh(user: User) {
    return { token: this.generateToken(user) };
  }

  private generateToken(user: User): string {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });
  }

  private sanitizeUser(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      connectionCode: user.connectionCode,
      sharingEnabled: user.sharingEnabled,
    };
  }
  //Added an option to delete the user account on the app Date 26/10/2026
async deleteAccount(userId: string) {
  if (!userId) throw new UnauthorizedException();

  const user = await this.userRepository.findOne({ where: { id: userId } });
  if (!user) throw new NotFoundException('Account not found');

  await this.userRepository.manager.transaction(async (manager) => {
    await manager.query(`DELETE FROM daily_steps WHERE user_id = $1`, [userId]);
    await manager.query(`DELETE FROM last_unlock WHERE "userId" = $1`, [userId]);
    await manager.query(`DELETE FROM connections WHERE user_a_id = $1 OR user_b_id = $1`, [userId]);
    await manager.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });
}
}

