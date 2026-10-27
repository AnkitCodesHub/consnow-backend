// Edited 26/10/2026
// Ankit Raj

import { Controller, Post, Body, HttpCode, HttpStatus, Delete, Request, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
  /** Returns a new token for a still-valid one, so active users never get logged out */
  @Post('refresh')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  refresh(@Request() req: any) {
    return this.authService.refresh(req.user);
  }

  // add inside the class, after the login method added on 26/10/2026
@Delete('me')
@UseGuards(JwtAuthGuard)
async deleteAccount(@Request() req: any) {
  await this.authService.deleteAccount(req.user.id);
  return { message: 'Account deleted successfully' };
}
}
