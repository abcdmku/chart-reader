import type { Response } from 'express';
import { nanoid } from 'nanoid';

type Client = {
  id: string;
  res: Response;
};

export class SseHub {
  private clients = new Map<string, Client>();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  addClient(res: Response): string {
    const id = nanoid();
    this.clients.set(id, { id, res });

    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => {
        this.broadcastComment('keep-alive');
      }, 15_000);
    }

    return id;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    if (this.clients.size === 0 && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  send<T>(event: string, data: T): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      client.res.write(payload);
    }
  }

  sendToClient<T>(clientId: string, event: string, data: T): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    client.res.write(payload);
  }

  private broadcastComment(text: string): void {
    const payload = `: ${text}\n\n`;
    for (const client of this.clients.values()) {
      client.res.write(payload);
    }
  }
}
