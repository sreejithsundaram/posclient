import { Component, OnInit, OnDestroy, NgZone, signal, computed, ElementRef, ViewChild, input, output } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { AgGridAngular } from 'ag-grid-angular';
import { ColDef, GridApi, GridReadyEvent, themeQuartz, ICellRendererParams } from 'ag-grid-community';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Domain types ──────────────────────────────────────────────────────────────

export interface CartItem {
  lineId?:  number;
  billId?:  number;
  slNo:     number;   // UI only
  id:       number;   // productid
  item:     string;
  qty:      number;
  mrp:      number;
  sp:       number;
  savings:  number;
  total:    number;
  image?:   string;
}

export interface ProductResult {
  id:     number;
  name:   string;
  mrp:    number;
  sp:     number;
  stock:  number;
  image?: string;
}

export interface BilllineView {
  id:          number;
  billid:      number;
  productid:   number;
  productname: string;
  qty:         number;
  mrp:         number;
  sp:          number;
  savings:     number;
  total:       number;
}

export interface BillView {
  id:        number;
  number:    string;
  customer:  string;
  state:     number;
  subtotal:  number;
  savings:   number;
  billlines: BilllineView[];
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector:    'app-root',
  standalone:  true,
  imports:     [AgGridAngular, FormsModule],
  templateUrl: './app.component.html',
  styleUrl:    './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  readonly isActive            = input<boolean>(true);
  readonly scannerStatusChange = output<'connecting' | 'connected' | 'disconnected'>();

  private gridApi!: GridApi<CartItem>;
  private ws:             WebSocket | null = null;
  private reconnectTimer: any = null;

  // ── Bill state ────────────────────────────────────────────
  bill          = signal<BillView | null>(null);
  billSaving    = signal(false);
  customerInput = signal('');
  private slCounter = 0;

  // ── Bill search ───────────────────────────────────────────
  private billSearchSubject = new Subject<string>();
  billQuery        = signal('');
  billResults      = signal<BillView[]>([]);
  isBillSearching  = signal(false);
  showBillDropdown = signal(false);

  onBillSearchInput(value: string) {
    this.billQuery.set(value);
    this.showBillDropdown.set(false);
    this.billSearchSubject.next(value);
  }

  closeBillDropdown() {
    setTimeout(() => this.showBillDropdown.set(false), 150);
  }

  loadBill(b: BillView) {
    this.billQuery.set(b.number);
    this.showBillDropdown.set(false);
    // Fetch full bill with lines
    this.http.get<BillView>(`/api/bill/${b.id}`)
      .pipe(catchError(() => of(null)))
      .subscribe(full => { if (full) this.applyBill(full); });
  }

  private applyBill(b: BillView) {
    this.bill.set({ ...b, billlines: [] });
    this.customerInput.set(b.customer ?? '');
    this.slCounter = 0;
    const items: CartItem[] = (b.billlines ?? []).map((l, i) => ({
      lineId:  l.id,
      billId:  l.billid,
      slNo:    i + 1,
      id:      l.productid,
      item:    l.productname,
      qty:     l.qty,
      mrp:     l.mrp,
      sp:      l.sp,
      savings: l.savings,
      total:   l.total,
    }));
    this.slCounter = items.length;
    this.rowData = items;
    this.gridApi?.setGridOption('rowData', items);
    this.recalcSummary();
  }

  // ── Product search ────────────────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery     = signal('');
  searchResults   = signal<ProductResult[]>([]);
  isSearching     = signal(false);
  showDropdown    = signal(false);
  manualQty       = signal(1);
  selectedProduct = signal<ProductResult | null>(null);

  // ── WS ────────────────────────────────────────────────────
  wsStatus    = signal<'connecting' | 'connected' | 'disconnected'>('disconnected');
  lastBarcode = signal('');
  lastError   = signal('');

  private setWsStatus(s: 'connecting' | 'connected' | 'disconnected') {
    this.wsStatus.set(s);
    this.scannerStatusChange.emit(s);
  }

  // ── Cart ──────────────────────────────────────────────────
  private rowData: CartItem[] = [];
  subTotal      = signal(0);
  totalSavings  = signal(0);
  itemCount     = signal(0);
  grandTotal    = computed(() => this.subTotal());
  selectedCount = signal(0);

  // ── Grid ──────────────────────────────────────────────────
  readonly rowHeight = 56;

  readonly theme = themeQuartz.withParams({
    backgroundColor:            '#0a0e1a',
    foregroundColor:            '#e2e8f0',
    borderColor:                '#1e2d4a',
    rowHoverColor:              '#0f1f3d',
    selectedRowBackgroundColor: '#1a3a6e',
    headerBackgroundColor:      '#060b14',
    headerTextColor:            '#64b5f6',
    fontFamily:                 '"JetBrains Mono", monospace',
    fontSize:                   13,
    cellHorizontalPaddingScale: 1.2,
  });

  colDefs: ColDef<CartItem>[] = [
    {
      headerCheckboxSelection: true, checkboxSelection: true,
      headerName: '', width: 44, minWidth: 44, maxWidth: 44,
      pinned: 'left', sortable: false, resizable: false,
    },
    {
      headerName: '', field: 'image', width: 60, pinned: 'left', sortable: false, resizable: false,
      cellRenderer: (p: ICellRendererParams<CartItem>) => {
        const src = p.value ? `data:image/jpeg;base64,${p.value}` : null;
        const el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;';
        el.innerHTML = src
          ? `<img src="${src}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #1e2d4a;" />`
          : `<div style="width:44px;height:44px;border-radius:6px;background:#0d1b2e;border:1px solid #1e2d4a;display:flex;align-items:center;justify-content:center;color:#2a3f5f;font-size:18px;">▦</div>`;
        return el;
      },
    },
    { field: 'slNo',    headerName: 'Sl.',     width: 55,  pinned: 'left', cellStyle: { color: '#4a6fa5', fontWeight: '600' } },
    { field: 'id',      hide: true },
    { field: 'item',    headerName: 'Item',    flex: 1,    minWidth: 180, cellStyle: { fontWeight: '500' } },
    {
      field: 'qty', headerName: 'Qty', width: 75, type: 'numericColumn',
      editable: () => !this.isComplete(),
      suppressKeyboardEvent: () => false,
      cellStyle: (p) => ({ color: p.value > 1 ? '#69f0ae' : '#e2e8f0', fontWeight: p.value > 1 ? '700' : '400', textAlign: 'center' }),
      onCellValueChanged: (e) => this.onQtyEdited(e),
    },
    { field: 'mrp',     headerName: 'MRP',     width: 110, type: 'numericColumn', valueFormatter: p => `₹${p.value.toFixed(2)}`, cellStyle: { color: '#546e7a', textDecoration: 'line-through' } },
    { field: 'sp',      headerName: 'SP',      width: 110, type: 'numericColumn', valueFormatter: p => `₹${p.value.toFixed(2)}`, cellStyle: { color: '#e2e8f0', fontWeight: '500' } },
    { field: 'savings', headerName: 'Savings', width: 105, type: 'numericColumn', valueFormatter: p => p.value > 0 ? `₹${p.value.toFixed(2)}` : '—', cellStyle: (p) => ({ color: p.value > 0 ? '#ff8a65' : '#4a6fa5', fontWeight: p.value > 0 ? '600' : '400' }) },
    { field: 'total',   headerName: 'Total',   width: 115, type: 'numericColumn', valueFormatter: p => `₹${p.value.toFixed(2)}`, cellStyle: { color: '#69f0ae', fontWeight: '600' } },
  ];

  defaultColDef: ColDef = { sortable: true, resizable: true };

  // ── Grid ready ────────────────────────────────────────────
  onGridReady(params: GridReadyEvent<CartItem>) {
    this.gridApi = params.api;
    params.api.addEventListener('selectionChanged', () => {
      this.selectedCount.set(this.gridApi.getSelectedRows().length);
    });
  }

  // ── Search ────────────────────────────────────────────────
  onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.selectedProduct.set(null);
    this.showDropdown.set(false);
    this.searchSubject.next(value);
  }

  selectProduct(product: ProductResult) {
    this.selectedProduct.set(product);
    this.searchQuery.set(product.name);
    this.searchResults.set([]);
    this.showDropdown.set(false);
    setTimeout(() => {
      const qtyEl = document.getElementById('manualQty');
      qtyEl?.focus();
      (qtyEl as HTMLInputElement)?.select();
    }, 50);
  }

  addManually() {
    const product = this.selectedProduct();
    if (!product) return;
    this.upsertItem(product, Math.max(1, this.manualQty()));
    this.searchQuery.set('');
    this.selectedProduct.set(null);
    this.manualQty.set(1);
    this.searchResults.set([]);
    this.showDropdown.set(false);
    this.searchInputRef?.nativeElement.focus();
  }

  clearSelection() {
    this.selectedProduct.set(null);
    this.searchQuery.set('');
    this.manualQty.set(1);
    this.searchResults.set([]);
    this.showDropdown.set(false);
    setTimeout(() => this.searchInputRef?.nativeElement.focus(), 50);
  }

  closeDropdown() {
    setTimeout(() => this.showDropdown.set(false), 150);
  }

  // ── Bill actions ──────────────────────────────────────────
  newBill() {
    this.bill.set(null);
    this.billQuery.set('');
    this.customerInput.set('');
    this.rowData = [];
    this.slCounter = 0;
    this.gridApi?.setGridOption('rowData', []);
    this.subTotal.set(0);
    this.totalSavings.set(0);
    this.itemCount.set(0);
    this.selectedCount.set(0);
    this.lastBarcode.set('');
    setTimeout(() => this.searchInputRef?.nativeElement.focus(), 50);
  }

  onCustomerBlur() {
    const b = this.bill();
    if (!b) return;
    this.http.put(`/api/bill`, {
      id: b.id, customer: this.customerInput(), state: b.state,
    }).pipe(catchError(() => of(null))).subscribe();
  }

  isComplete = computed(() => (this.bill()?.state ?? 0) >= 2);

  completeBill() {
    const b = this.bill();
    if (!b) return;
    this.billSaving.set(true);
    this.http.post<BillView>(`/api/bill/complete/${b.id}`, {})
      .pipe(catchError(() => of(null)))
      .subscribe(result => {
        this.billSaving.set(false);
        if (result) this.bill.set({ ...result, billlines: [] });
      });
  }

  // ── Qty edit in grid — PUT /api/billline/{id}/{qty} ───────
  onQtyEdited(event: any) {
    const row: CartItem = event.data;
    const qty = Math.max(1, Number(event.newValue) || 1);
    row.qty     = qty;
    row.total   = row.sp * qty;
    row.savings = (row.mrp - row.sp) * qty;
    this.gridApi.applyTransaction({ update: [row] });
    this.recalcSummary();
    if (row.lineId) {
      this.http.put<BilllineView>(`/api/billline/${row.lineId}/${qty}`, {})
        .pipe(catchError(() => of(null)))
        .subscribe(result => {
          if (!result) return;
          row.savings = result.savings;
          row.total   = result.total;
          this.gridApi.applyTransaction({ update: [row] });
          this.recalcSummary();
        });
    }
  }

  // ── Remove selected — batch DELETE ────────────────────────
  removeSelected() {
    const selected = this.gridApi.getSelectedRows();
    if (!selected.length) return;
    const billId = this.bill()?.id;
    const ids = selected.map(s => s.lineId).filter(Boolean) as number[];
    this.rowData = this.rowData.filter(r => !selected.find(s => s.id === r.id));
    this.gridApi.applyTransaction({ remove: selected });
    this.renumberLines();
    this.recalcSummary();
    this.selectedCount.set(0);
    if (billId && ids.length) {
      this.http.delete<BillView>('/api/billline', { body: { billid: billId, ids } })
        .pipe(catchError(() => of(null)))
        .subscribe(result => {
          if (result) this.bill.set({ ...result, billlines: [] });
        });
    }
  }

  // ── Core: upsert item ─────────────────────────────────────
  private upsertItem(product: ProductResult, qtyToAdd = 1) {
    const existing = this.rowData.find(r => r.id === product.id);

    if (existing) {
      existing.qty    += qtyToAdd;
      existing.total   = existing.sp * existing.qty;
      existing.savings = (existing.mrp - existing.sp) * existing.qty;
      if (product.image) existing.image = product.image;
      this.gridApi.applyTransaction({ update: [existing] });
      this.recalcSummary();
      this.lastError.set('');
      if (existing.lineId) {
        this.http.put<BilllineView>(`/api/billline/${existing.lineId}/${existing.qty}`, {})
          .pipe(catchError(() => of(null)))
          .subscribe(result => {
            if (!result) return;
            existing.savings = result.savings;
            existing.total   = result.total;
            this.gridApi.applyTransaction({ update: [existing] });
            this.recalcSummary();
          });
      }
      return;
    }

    // New line — optimistic add, slNo is UI-only
    this.slCounter++;
    const newItem: CartItem = {
      slNo: this.slCounter, id: product.id, item: product.name,
      qty: qtyToAdd, mrp: product.mrp, sp: product.sp,
      total: product.sp * qtyToAdd, savings: (product.mrp - product.sp) * qtyToAdd,
      image: product.image,
    };
    this.rowData.push(newItem);
    this.gridApi.applyTransaction({ add: [newItem] });
    this.recalcSummary();
    this.lastError.set('');

    this.http.post<BillView>('/api/billline', {
      billid:    this.bill()?.id ?? null,
      productid: product.id,
      qty:       qtyToAdd,
      mrp:       product.mrp,
      sp:        product.sp,
    }).pipe(catchError(() => of(null)))
      .subscribe(result => {
        if (!result) return;
        // Find the line for this product in the response
        const line = result.billlines?.find(l => l.productid === product.id);
        if (line) {
          newItem.lineId  = line.id;
          newItem.billId  = line.billid;
          newItem.savings = line.savings;
          newItem.total   = line.total;
          this.gridApi.applyTransaction({ update: [newItem] });
          this.recalcSummary();
        }
        // Update bill header every time (sets number on first add)
        this.bill.set({ id: result.id, number: result.number, customer: result.customer, state: result.state, subtotal: result.subtotal, savings: result.savings, billlines: [] });
      });
  }

  private renumberLines() {
    this.rowData.forEach((r, i) => { r.slNo = i + 1; });
    this.slCounter = this.rowData.length;
    if (this.rowData.length > 0) {
      this.gridApi.applyTransaction({ update: [...this.rowData] });
    }
  }

  private recalcSummary() {
    let sub = 0, savings = 0, items = 0;
    for (const r of this.rowData) { sub += r.total; savings += r.savings; items += r.qty; }
    this.subTotal.set(sub);
    this.totalSavings.set(savings);
    this.itemCount.set(items);
  }

  // ── WebSocket ─────────────────────────────────────────────
  private connect() {
    this.setWsStatus('connecting');
    this.ws = new WebSocket('ws://localhost:5050/ws');
    this.ws.onopen  = () => this.zone.run(() => {
      this.setWsStatus('connected');
      this.lastError.set('');
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    });
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'barcode' && msg.value) {
          this.zone.run(() => {
            if (!this.isActive() || document.visibilityState !== 'visible') return;
            this.lastBarcode.set(msg.value);
            this.onBarcodeScanned(msg.value);
          });
        }
      } catch {}
    };
    this.ws.onclose = () => this.zone.run(() => {
      this.setWsStatus('disconnected');
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
    this.ws.onerror = () => this.ws?.close();
  }

  private showError(msg: string) {
    this.lastError.set(msg);
    setTimeout(() => this.lastError.set(''), 3000);
  }

  private onBarcodeScanned(barcode: string) {
    this.http.get<ProductResult | null>(`/api/products/${barcode}`)
      .pipe(catchError(() => of(null)))
      .subscribe(product => {
        if (!product) { this.showError(`Product not found: ${barcode}`); return; }
        this.upsertItem(product);
      });
  }

  constructor(private http: HttpClient, private zone: NgZone) {}

  ngOnInit() {
    this.connect();

    this.searchSubject.pipe(
      debounceTime(200), distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 3) { this.searchResults.set([]); this.isSearching.set(false); return of([]); }
        this.isSearching.set(true);
        return this.http.get<ProductResult[]>(`/api/products/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.searchResults.set(results);
      this.isSearching.set(false);
      this.showDropdown.set(results.length > 0);
    });

    this.billSearchSubject.pipe(
      debounceTime(300), distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 2) { this.billResults.set([]); this.isBillSearching.set(false); return of([]); }
        this.isBillSearching.set(true);
        return this.http.get<BillView[]>(`/api/bill/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.billResults.set(results as BillView[]);
      this.isBillSearching.set(false);
      this.showBillDropdown.set((results as any[]).length > 0);
    });
  }

  ngOnDestroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.searchSubject.complete();
    this.billSearchSubject.complete();
  }
}