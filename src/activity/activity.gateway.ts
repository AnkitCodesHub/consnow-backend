import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Server, Socket } from 'socket.io';
import { StepsService } from '../steps/steps.service';
import { ActivityService } from './activity.service';
import { ActivityState, LiveActivityDto, LiveStepsDto } from './dto/realtime.dto';

@WebSocketGateway({ cors: { origin: '*' } })
export class ActivityGateway //edited on 22/10/2026
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ActivityGateway.name);
  // one user can have multiple sockets (phone + tablet, reconnects)
  private readonly userToSockets = new Map<string, Set<string>>();
  private readonly socketToUser = new Map<string, string>();

  constructor(private readonly jwtService: JwtService) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token);
      const userId: string = String(payload.sub);
      this.socketToUser.set(client.id, userId);
      if (!this.userToSockets.has(userId)) {
        this.userToSockets.set(userId, new Set());
      }
      this.userToSockets.get(userId)!.add(client.id);
      this.logger.debug(`User ${userId} connected → socket ${client.id}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = this.socketToUser.get(client.id);
    if (userId !== undefined) {
      const sockets = this.userToSockets.get(userId);
      sockets?.delete(client.id);
      if (sockets?.size === 0) this.userToSockets.delete(userId);
      this.socketToUser.delete(client.id);
      this.logger.debug(`User ${userId} disconnected → socket ${client.id}`);
    }
  }

  emitUnlockToPeers(peerIds: string[], fromUserId: string, unlockedAt: Date) {
    const payload = { userId: fromUserId, unlockedAt: unlockedAt.toISOString() };
    for (const peerId of peerIds) {
      const sockets = this.userToSockets.get(peerId);
      if (sockets) {
        for (const socketId of sockets) {
          this.server.to(socketId).emit('peer_unlocked', payload);
        }
      }
    }
  }
     emitLockToPeers(peerIds: string[], fromUserId: string, lockedAt: Date) {
    const payload = { userId: fromUserId, lockedAt: lockedAt.toISOString() };
    for (const peerId of peerIds) {
      const sockets = this.userToSockets.get(peerId);
      if (sockets) {
        for (const socketId of sockets) {
          this.server.to(socketId).emit('peer_locked', payload);
        }
      }
    }
  }

  afterInit(server: Server) {
    this.logger.debug('WebSocket gateway initialized');
  }

  onModuleDestroy() {
    this.userToSockets.clear();
    this.socketToUser.clear();
  }
}
