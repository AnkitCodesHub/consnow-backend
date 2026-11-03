import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConnectionsService } from './connections.service';
import { CreateConnectionDto } from './dto/create-connection.dto';

/**
 * POST   /connections                         connect by code (first time)
 * GET    /connections?include=disconnected    friends list (+ disconnected rows with state)
 * GET    /connections/requests                incoming Connect requests (inbox)
 * POST   /connections/requests/:id/accept     accept
 * POST   /connections/requests/:id/decline    decline (sender waits 3 h)
 * DELETE /connections/requests/:id            sender cancels their request
 * POST   /connections/:peerId/disconnect      disconnect instantly
 * POST   /connections/:peerId/undo-disconnect undo within 15 s
 * POST   /connections/:peerId/request         send a Connect request
 */
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
  async getConnections(@Request() req: any, @Query('include') include?: string) {
    return this.connectionsService.getConnections(req.user.id, include === 'disconnected');
  }

  @Get('requests')
  listRequests(@Request() req: any) {
    return this.connectionsService.listIncomingRequests(req.user.id);
  }

  @Post('requests/:id/accept')
  accept(@Request() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.connectionsService.acceptRequest(req.user.id, id);
  }

  @Post('requests/:id/decline')
  decline(@Request() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.connectionsService.declineRequest(req.user.id, id);
  }

  @Delete('requests/:id')
  cancel(@Request() req: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.connectionsService.cancelRequest(req.user.id, id);
  }

  @Post(':peerId/disconnect')
  disconnect(@Request() req: any, @Param('peerId', new ParseUUIDPipe()) peerId: string) {
    return this.connectionsService.disconnect(req.user.id, peerId);
  }

  @Post(':peerId/undo-disconnect')
  undo(@Request() req: any, @Param('peerId', new ParseUUIDPipe()) peerId: string) {
    return this.connectionsService.undoDisconnect(req.user.id, peerId);
  }

  @Post(':peerId/request')
  request(@Request() req: any, @Param('peerId', new ParseUUIDPipe()) peerId: string) {
    return this.connectionsService.requestConnect(req.user.id, peerId);
  }
}
