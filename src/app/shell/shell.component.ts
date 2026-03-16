import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { AppComponent } from '../app.component';
import { ProductEditorComponent } from '../products/editor/product-editor.component';
import { UomEditorComponent } from '../uom/editor/uom-editor.component';
import { StockControllerComponent } from '../stock/stock-controller.component';

export type AppRoute = 'terminal' | 'products' | 'uom' | 'stock';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [AppComponent, ProductEditorComponent, UomEditorComponent, StockControllerComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent implements OnInit, OnDestroy {
  collapsed    = signal(false);
  activeRoute  = signal<AppRoute>('terminal');

  // ── Global API health ─────────────────────────────────────
  apiStatus = signal<'checking' | 'online' | 'offline'>('checking');
  private healthTimer: any = null;

  private checkHealth() {
    this.http.get('/api/POS/health', { observe: 'response' })
      .pipe(catchError(() => of(null)))
      .subscribe(res => this.apiStatus.set(res && res.ok ? 'online' : 'offline'));
  }

  // ── Global scanner status (reported up from active component) ─
  scannerStatus = signal<'connecting' | 'connected' | 'disconnected'>('disconnected');

  onScannerStatus(status: 'connecting' | 'connected' | 'disconnected') {
    this.scannerStatus.set(status);
  }

  toggleSidebar() { this.collapsed.set(!this.collapsed()); }
  navigate(route: AppRoute) { this.activeRoute.set(route); }

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.checkHealth();
    this.healthTimer = setInterval(() => this.checkHealth(), 15_000);
  }

  ngOnDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }
}
