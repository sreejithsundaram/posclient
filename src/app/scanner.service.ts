import { Injectable, NgZone, signal } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ScannerService {
  private ws: WebSocket | null = null;
  private wsReconnectTimer: any = null;

  status = signal<'connecting' | 'connected' | 'disconnected'>('disconnected');
  barcode$ = new Subject<string>();

  constructor(private zone: NgZone) {
    this.connect();
  }

  private connect() {
    const url = 'ws://localhost:5050/ws';
    this.status.set('connecting');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.zone.run(() => this.status.set('connected'));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'barcode' && msg.value) {
          this.zone.run(() => {
            if (document.visibilityState !== 'visible') return;
            this.barcode$.next(msg.value);
          });
        }
      } catch (err) {
        console.error('[ScannerService] Failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      this.zone.run(() => {
        this.status.set('disconnected');
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connect(), 2000);
      });
    };

    this.ws.onerror = (event) => {
      console.error('[ScannerService] WebSocket error:', event);
      this.ws?.close();
    };
  }

  disconnect() {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
