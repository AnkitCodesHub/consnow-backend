import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConnectionsService } from './connections.service';
import { CreateConnectionDto } from './dto/create-connection.dto';

@Controller('connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post()
  async createConnection(
    @Request() req: any,
    @Body() dto: CreateConnectionDto,
  ) {
    return this.connectionsService.createConnection(
      req.user.id,
      dto.connectionCode,
    );
  }

  @Get()
  async getConnections(@Request() req: any) {
    return this.connectionsService.getConnections(req.user.id);
  }
}
