import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as admin from 'firebase-admin';
import { User } from '../entities/user.entity';
import { ConnectionEvent, ConnectionsService } from '../connections/connections.service';

/**
 * Push notifications through Firebase Cloud Messaging.
 *
 * Turned on by the FIREBASE_SERVICE_ACCOUNT env var (the service-account JSON, pasted
 * as one line). Without it, pushes are skipped and everything else works as before.
 *
 * Only two events push: someone asked to connect (with Accept / Decline on the
 * notification) and someone accepted your request. Disconnects stay silent.
 * Messages are data-only so the app builds the notification with action buttons.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: admin.messaging.Messaging | null = null;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      try {
        const app = admin.apps.length
          ? admin.app()
          : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
        this.messaging = app.messaging();
        this.logger.log('FCM push enabled');
      } catch (e: any) {
        this.logger.error(`FCM disabled, bad FIREBASE_SERVICE_ACCOUNT: ${e?.message}`);
      }
    } else {
      this.logger.warn('FCM push disabled (FIREBASE_SERVICE_ACCOUNT not set)');
    }
    this.connections.onEvent((e) => this.onConnectionEvent(e));
  }

  async saveToken(userId: string, token: string | null) {
    if (token) {
      // A phone token belongs to one account: if someone else signed in on this phone
      // before, stop sending their pushes here.
      await this.users
        .createQueryBuilder()
        .update(User)
        .set({ fcmToken: null })
        .where('fcm_token = :token AND id != :userId', { token, userId })
        .execute();
    }
    await this.users.update({ id: userId }, { fcmToken: token });
    return { success: true };
  }

  private async onConnectionEvent(e: ConnectionEvent) {
    if (e.type === 'request_received') {
      await this.send(e.userId, {
        type: 'connection_request',
        requestId: e.requestId ?? '',
        peerId: e.peerId,
        peerName: e.peerName ?? '',
      });
    } else if (e.type === 'request_accepted') {
      await this.send(e.userId, {
        type: 'connection_accepted',
        peerId: e.peerId,
        peerName: e.peerName ?? '',
      });
    }
  }

  private async send(userId: string, data: Record<string, string>) {
    if (!this.messaging) return;
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, fcmToken: true },
    });
    if (!user?.fcmToken) return;
    try {
      await this.messaging.send({
        token: user.fcmToken,
        data,
        android: { priority: 'high', ttl: 24 * 60 * 60 * 1000 },
      });
    } catch (err: any) {
      const code = err?.errorInfo?.code ?? err?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
        await this.users.update({ id: userId }, { fcmToken: null }); // app uninstalled
      }
      this.logger.warn(`push to ${userId} failed: ${code ?? err?.message}`);
    }
  }
}
