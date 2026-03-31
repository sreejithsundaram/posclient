import {
  Component, OnInit, OnDestroy, NgZone,
  signal, computed, input, output,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { ScannerService } from '../scanner.service';
import { AgGridAngular } from 'ag-grid-angular';
import {
  ColDef, GridApi, GridReadyEvent, themeQuartz,
  AllCommunityModule, ModuleRegistry,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Domain types ──────────────────────────────────────────────────────────────

export type StockStatus = 0 | 1 | 2 | 3;

export interface StockRecord {
  id:          number;
  stocktakeid: string;
  start:       string;
  finish:      string | null;
  status:      StockStatus;
  created:     string;
  createdby:   string;
  lines?:      StockLine[];
}

// Matches GET /api/stock/{id} lines[] and POST/PUT /api/stockline/ response
export interface StockLine {
  id?:          number;
  stockid?:     number;
  productid:    number;
  qty:          number;
  productName?: string;
  productCode?: string;
  barcode?:     string;
  uomName?:     string;
  baseUomName?: string;
  baseQty?:     number;
  packChain?:   string;
  thumb?:       string;
  mrp?:         number;
  sp?:          number;
  sellable?:    boolean;
  created?:     string;
  createdby?:   string;
}

export interface ProductSearchResult {
  id:       number;
  code:     string;
  name:     string;
  barcode?: string;
  sp?:      number;
  thumb?:   string;
  uomid?:   number;
}

export const STATUS_LABELS: Record<number, string> = {
  0: 'Creating', 1: 'Open', 2: 'Counting', 3: 'Posted',
};
export const STATUS_COLORS: Record<number, string> = {
  0: '#4a6fa5', 1: '#69f0ae', 2: '#ff8a65', 3: '#64b5f6',
};

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector:    'app-stock-controller',
  standalone:  true,
  imports:     [AgGridAngular, FormsModule],
  templateUrl: './stock-controller.component.html',
  styleUrl:    './stock-controller.component.scss',
})
export class StockControllerComponent implements OnInit, OnDestroy {
  readonly isActive = input<boolean>(true);
  scannerStatus = computed(() => this.scanner.status());

  readonly STATUS_LABELS = STATUS_LABELS;
  readonly STATUS_COLORS = STATUS_COLORS;
  readonly Math = Math;

  readonly theme = themeQuartz.withParams({
    backgroundColor:            '#0a0e1a',
    foregroundColor:            '#e2e8f0',
    borderColor:                '#1e2d4a',
    rowHoverColor:              '#0f1f3d',
    selectedRowBackgroundColor: '#0d1b2e',
    headerBackgroundColor:      '#060b14',
    headerTextColor:            '#4a6fa5',
    oddRowBackgroundColor:      '#0a0e1a',
    fontFamily:                 'Rajdhani, sans-serif',
    fontSize:                   13,
  });

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }

  // ── Section 1: Stock header + search ─────────────────────
  stock      = signal<StockRecord | null>(null);
  uiStatus   = signal<StockStatus>(0);   // reflects saved DB state
  pendingStatus = signal<StockStatus>(0); // reflects dropdown selection
  saveStatus = signal<'idle' | 'saving' | 'success' | 'error'>('idle');
  saveError  = signal('');
  refreshing = signal(false);
  toast      = signal<string>('');
  private toastTimer: any = null;

  showToast(msg: string) {
    this.toast.set(msg);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3000);
  }

  isPosted = computed(() => this.uiStatus() === 3);

  // Stock take search
  private stockSearchSubject = new Subject<string>();
  stockQuery        = signal('');
  stockResults      = signal<StockRecord[]>([]);
  isStockSearching  = signal(false);
  showStockDropdown = signal(false);

  onStockSearchInput(value: string) {
    this.stockQuery.set(value);
    this.showStockDropdown.set(false);
    this.stockSearchSubject.next(value);
  }

  closeStockDropdown() {
    setTimeout(() => this.showStockDropdown.set(false), 150);
  }

  loadStock(record: StockRecord) {
    this.stockQuery.set(record.stocktakeid);
    this.showStockDropdown.set(false);
    this.fetchStock(record.id);
  }

  private fetchStock(id: number) {
    this.refreshing.set(true);
    this.http.get<StockRecord>(`/api/stock/${id}`)
      .pipe(catchError(() => of(null)))
      .subscribe(result => {
        this.refreshing.set(false);
        if (!result) return;
        this.stock.set(result);
        this.setStatus(result.status as StockStatus);
        const rows = (result.lines ?? []).slice().reverse();
        this.lines.set(rows);
        this.gridApi?.setGridOption('rowData', rows);
      });
  }

  refreshStock() {
    const id = this.stock()?.id;
    if (id) this.fetchStock(id);
  }

  private setStatus(s: StockStatus) {
    this.uiStatus.set(s);
    this.pendingStatus.set(s);
  }

  onStatusChange(value: string) {
    const next = +value as StockStatus;
    if (next < this.uiStatus()) return;
    this.pendingStatus.set(next); // UI shows selection but DB not yet updated
  }

  saveStock() {
    const current = this.stock();
    this.saveStatus.set('saving');
    if (!current) {
      this.http.post<StockRecord>('/api/stock', { status: 1 })
        .pipe(catchError(err => {
          this.saveStatus.set('error');
          this.saveError.set(err?.error?.message ?? 'Save failed');
          return of(null);
        }))
        .subscribe(result => {
          if (!result) return;
          this.stock.set(result);
          this.setStatus(result.status as StockStatus);
          this.saveStatus.set('success');
          setTimeout(() => this.saveStatus.set('idle'), 3000);
        });
    } else {
      this.http.put<StockRecord>(`/api/stock/${current.id}`, {
        id: current.id, status: this.pendingStatus(),
      })
        .pipe(catchError(err => {
          this.saveStatus.set('error');
          this.saveError.set(err?.error?.message ?? 'Save failed');
          this.pendingStatus.set(this.uiStatus()); // revert dropdown on error
          return of(null);
        }))
        .subscribe(result => {
          if (!result) return;
          this.stock.set(result);
          this.setStatus(result.status as StockStatus);
          this.saveStatus.set('success');
          setTimeout(() => this.saveStatus.set('idle'), 3000);
        });
    }
  }

  newStock() {
    this.stock.set(null);
    this.setStatus(0);
    this.stockQuery.set('');
    this.lines.set([]);
    this.gridApi?.setGridOption('rowData', []);
    this.clearProduct();
    this.saveStatus.set('idle');
  }

  // ── Section 2: Product search ─────────────────────────────
  private searchSubject = new Subject<string>();
  productQuery    = signal('');
  productResults  = signal<ProductSearchResult[]>([]);
  isSearching     = signal(false);
  showDropdown    = signal(false);
  selectedProduct = signal<ProductSearchResult | null>(null);
  addQty          = signal<number>(1);

  private wsReconnectTimer: any = null;

  onProductInput(value: string) {
    this.productQuery.set(value);
    this.showDropdown.set(false);
    if (!value) this.selectedProduct.set(null);
    this.searchSubject.next(value);
  }

  closeDropdown() {
    setTimeout(() => this.showDropdown.set(false), 150);
  }

  barcodeInput   = signal('');
  barcodeScanned = signal(false);
  private barcodeFlashTimer: any = null;

  onBarcodeInput(value: string) { this.barcodeInput.set(value); }

  onBarcodeEnter() {
    const val = this.barcodeInput().trim();
    if (!val) return;
    this.barcodeInput.set('');
    // Resolve barcode to product first, then scan with productid
    this.http.get<any>(`/api/products/${encodeURIComponent(val)}?pos=false`)
      .pipe(catchError(() => of(null)))
      .subscribe(p => {
        if (!p) { this.showToast('⚠ Product not found: ' + val); return; }
        this.barcodeScanned.set(true);
        if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
        this.barcodeFlashTimer = setTimeout(() => this.barcodeScanned.set(false), 2000);
        this.scan({ productid: p.id });
      });
  }

  selectProduct(item: ProductSearchResult) {
    this.selectedProduct.set(item);
    this.productQuery.set(item.name);
    this.showDropdown.set(false);
    this.addQty.set(1);
  }

  clearProduct() {
    this.selectedProduct.set(null);
    this.productQuery.set('');
    this.productResults.set([]);
    this.showDropdown.set(false);
    this.addQty.set(1);
  }

  // ── Section 2: Add to grid via scan endpoint ──────────────
  lines = signal<StockLine[]>([]);
  adding = signal(false);

  addToGrid() {
    const p = this.selectedProduct();
    if (!p) return;
    this.scan({ productid: p.id });
  }

  private scan(payload: { productid: number }) {
    const stockid = this.stock()?.id;
    if (!stockid) return;
    this.adding.set(true);
    this.http.post<StockLine>('/api/stockline/scan', { stockid, qty: this.addQty(), ...payload })
      .pipe(catchError(() => of(null)))
      .subscribe(result => {
        this.adding.set(false);
        if (!result) {
          this.showToast('⚠ Product not found');
          return;
        }
        const idx = this.lines().findIndex(l => l.productid === result.productid);
        const updated = idx >= 0
          ? [result, ...this.lines().filter((_, i) => i !== idx)]
          : [result, ...this.lines()];
        this.lines.set(updated);
        this.gridApi?.setGridOption('rowData', updated);
        this.barcodeScanned.set(true);
        if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
        this.barcodeFlashTimer = setTimeout(() => this.barcodeScanned.set(false), 2000);
        this.clearProduct();
      });
  }

  // ── Section 3: AG Grid ────────────────────────────────────
  private gridApi!: GridApi<StockLine>;

  colDefs: ColDef<StockLine>[] = [
    {
      headerName: '',
      width: 52,
      sortable: false, filter: false, resizable: false,
      valueGetter: p => p.data?.thumb ?? '',
      cellRenderer: (params: any) => {
        const src = params.value;
        if (!src) return `<span style="color:#2a3f5f;font-size:18px">⬡</span>`;
        return `<img src="data:image/jpeg;base64,${src}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;margin-top:4px"/>`;
      },
    },
    { headerName: 'Code',      width: 100, valueGetter: p => p.data?.productCode ?? '' },
    { headerName: 'Product',   flex: 1,    valueGetter: p => p.data?.productName ?? '' },
    { headerName: 'UOM',       width: 80,  valueGetter: p => p.data?.uomName ?? '' },
    {
      field: 'qty',
      headerName: 'Qty',
      width: 80,
      editable: true,
      cellStyle: { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 } as any,
      onCellValueChanged: e => this.onQtyChanged(e),
    },
    {
      headerName: 'Pack Chain',
      flex: 1,
      valueGetter: p => p.data?.packChain ?? '—',
      cellStyle: { color: '#ff8a65', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' } as any,
    },
    {
      headerName: '',
      width: 48,
      sortable: false, filter: false, resizable: false,
      cellRenderer: () => `<button class="grid-del-btn" title="Remove">✕</button>`,
      onCellClicked: e => { if (!this.isPosted()) this.removeLine(e.data as StockLine); },
    },
  ];

  onGridReady(e: GridReadyEvent<StockLine>) {
    this.gridApi = e.api;
    e.api.setGridOption('rowData', this.lines());
  }

  onQtyChanged(e: any) {
    const line = e.data as StockLine;
    if (!line.id) return;
    this.http.put<StockLine>(`/api/stockline/${line.id}`, {
      id: line.id, stockid: line.stockid, productid: line.productid, qty: line.qty,
    }).pipe(catchError(() => of(null)))
      .subscribe(result => {
        const updated = this.lines().map(l => l.id === line.id ? (result ?? l) : l);
        this.lines.set(updated);
        this.gridApi?.setGridOption('rowData', updated);
      });
  }

  removeLine(line: StockLine) {
    if (line.id) {
      this.http.delete(`/api/stockline/${line.id}`)
        .pipe(catchError(() => of(null))).subscribe();
    }
    const updated = this.lines().filter(l => l !== line);
    this.lines.set(updated);
    this.gridApi?.setGridOption('rowData', updated);
  }

  // ── Grid summary ──────────────────────────────────────────
  totalLineCount    = computed(() => this.lines().length);
  totalQty          = computed(() => this.lines().reduce((s, l) => s + l.qty, 0));
  totalBaseUnitsAll = computed(() =>
    this.lines().reduce((s, l) => s + (l.baseQty ? l.qty * l.baseQty : l.qty), 0)
  );

  private disconnectScanner() {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
  }

  constructor(private http: HttpClient, private zone: NgZone, private scanner: ScannerService) {}

  ngOnInit() {
    // Product search
    this.searchSubject.pipe(
      debounceTime(250), distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 2) { this.productResults.set([]); this.isSearching.set(false); return of([]); }
        this.isSearching.set(true);
        return this.http.get<ProductSearchResult[]>(`/api/products/search?q=${encodeURIComponent(query)}&pos=false`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.productResults.set(results as ProductSearchResult[]);
      this.isSearching.set(false);
      this.showDropdown.set((results as any[]).length > 0 || this.productQuery().length >= 2);
    });

    // Stock take search
    this.stockSearchSubject.pipe(
      debounceTime(300), distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 2) { this.stockResults.set([]); this.isStockSearching.set(false); return of([]); }
        this.isStockSearching.set(true);
        return this.http.get<StockRecord[]>(`/api/stock/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.stockResults.set(results as StockRecord[]);
      this.isStockSearching.set(false);
      this.showStockDropdown.set((results as any[]).length > 0);
    });

    this.scanner.barcode$.subscribe(barcode => {
      if (!this.isActive() || document.visibilityState !== 'visible') return;
      this.zone.run(() => {
        this.barcodeInput.set(barcode);
        this.http.get<any>(`/api/products/${encodeURIComponent(barcode)}?pos=false`)
          .pipe(catchError(() => of(null)))
          .subscribe(p => {
            if (!p) { this.showToast('⚠ Product not found: ' + barcode); return; }
            this.barcodeScanned.set(true);
            if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
            this.barcodeFlashTimer = setTimeout(() => this.barcodeScanned.set(false), 2000);
            this.scan({ productid: p.id });
          });
      });
    });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
    this.stockSearchSubject.complete();
    this.disconnectScanner();
    if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
  }
}