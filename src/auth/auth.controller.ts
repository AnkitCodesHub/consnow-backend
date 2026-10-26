// Edited 26/10/2026
// Ankit Raj

import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';import { Delete, Request, UseGuards } from '@nestjs/common'; //Added on 26/10/2026
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
  // add inside the class, after the login method added on 26/10/2026
@Delete('me')
@UseGuards(JwtAuthGuard)
async deleteAccount(@Request() req: any) {
  await this.authService.deleteAccount(req.user.sub);
  return { message: 'Account deleted successfully' };
}
}
