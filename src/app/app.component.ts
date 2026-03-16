import { Component, OnInit, OnDestroy, NgZone, signal, computed, ElementRef, ViewChild, input, output } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { AgGridAngular } from 'ag-grid-angular';
import {
  ColDef,
  GridApi,
  GridReadyEvent,
  themeQuartz,
  ICellRendererParams,
} from 'ag-grid-community';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface CartItem {
  slNo: number;
  id: string;
  item: string;
  qty: number;
  mrp: number;
  sp: number;
  savings: number;
  total: number;
  image?: string; // base64 JPEG, e.g. "/9j/4AAQ..."  (no data: prefix needed)
}

export interface ProductResult {
  id: string;
  name: string;
  mrp: number;
  sp: number;
  stock: number;
  image?: string; // base64 JPEG
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [AgGridAngular, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  readonly isActive = input<boolean>(true);
  readonly scannerStatusChange = output<'connecting' | 'connected' | 'disconnected'>();

  private gridApi!: GridApi<CartItem>;
  private ws: WebSocket | null = null;
  private reconnectTimer: any = null;
  private slCounter = 0;

  // ── Search ───────────────────────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery    = signal('');
  searchResults  = signal<ProductResult[]>([]);
  isSearching    = signal(false);
  showDropdown   = signal(false);

  manualQty       = signal(1);
  selectedProduct = signal<ProductResult | null>(null);

  // ── WebSocket state ──────────────────────────────────────
  wsStatus    = signal<'connecting' | 'connected' | 'disconnected'>('disconnected');
  lastBarcode = signal<string>('');
  lastError   = signal<string>('');

  private setWsStatus(s: 'connecting' | 'connected' | 'disconnected') {
    this.wsStatus.set(s);
    this.scannerStatusChange.emit(s);
  }

  // ── Cart state ───────────────────────────────────────────
  private rowData: CartItem[] = [];

  subTotal     = signal(0);
  totalSavings = signal(0);
  itemCount    = signal(0);

  grandTotal = computed(() => this.subTotal() - this.totalSavings());

  // ── AG-Grid config ───────────────────────────────────────
  readonly theme = themeQuartz.withParams({
    backgroundColor: '#0a0e1a',
    foregroundColor: '#e2e8f0',
    borderColor: '#1e2d4a',
    rowHoverColor: '#0f1f3d',
    selectedRowBackgroundColor: '#1a3a6e',
    headerBackgroundColor: '#060b14',
    headerTextColor: '#64b5f6',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 13,
    cellHorizontalPaddingScale: 1.2,
  });

  // Row height to match image size
  readonly rowHeight = 56;

  selectedCount = signal(0);

  colDefs: ColDef<CartItem>[] = [
    {
      // Checkbox selection column
      headerCheckboxSelection: true,
      checkboxSelection: true,
      headerName: '',
      width: 44,
      minWidth: 44,
      maxWidth: 44,
      pinned: 'left',
      sortable: false,
      resizable: false,
    },
    {
      // Image column — base64 JPEG rendered as a square thumbnail
      headerName: '',
      field: 'image',
      width: 60,
      pinned: 'left',
      sortable: false,
      resizable: false,
      cellRenderer: (p: ICellRendererParams<CartItem>) => {
        const src = p.value
          ? `data:image/jpeg;base64,${p.value}`
          : null;
        const el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;';
        if (src) {
          el.innerHTML = `<img src="${src}"
            style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #1e2d4a;" />`;
        } else {
          el.innerHTML = `<div style="width:44px;height:44px;border-radius:6px;
            background:#0d1b2e;border:1px solid #1e2d4a;display:flex;
            align-items:center;justify-content:center;color:#2a3f5f;font-size:18px;">▦</div>`;
        }
        return el;
      },
    },
    {
      field: 'slNo',
      headerName: 'Sl.',
      width: 55,
      pinned: 'left',
      cellStyle: { color: '#4a6fa5', fontWeight: '600' },
    },
    {
      // ID hidden but still in rowData for upsert matching
      field: 'id',
      hide: true,
    },
    {
      field: 'item',
      headerName: 'Item',
      flex: 1,
      minWidth: 180,
      cellStyle: { fontWeight: '500' },
    },
    {
      field: 'qty',
      headerName: 'Qty',
      width: 75,
      type: 'numericColumn',
      editable: true,
      cellStyle: (p) => ({
        color: p.value > 1 ? '#69f0ae' : '#e2e8f0',
        fontWeight: p.value > 1 ? '700' : '400',
        textAlign: 'center',
      }),
      onCellValueChanged: (e) => this.onQtyEdited(e),
    },
    {
      field: 'mrp',
      headerName: 'MRP',
      width: 110,
      type: 'numericColumn',
      valueFormatter: (p) => `₹${p.value.toFixed(2)}`,
      cellStyle: { color: '#546e7a', textDecoration: 'line-through' },
    },
    {
      field: 'sp',
      headerName: 'SP',
      width: 110,
      type: 'numericColumn',
      valueFormatter: (p) => `₹${p.value.toFixed(2)}`,
      cellStyle: { color: '#e2e8f0', fontWeight: '500' },
    },
    {
      field: 'savings',
      headerName: 'Savings',
      width: 105,
      type: 'numericColumn',
      valueFormatter: (p) => p.value > 0 ? `₹${p.value.toFixed(2)}` : '—',
      cellStyle: (p) => ({
        color: p.value > 0 ? '#ff8a65' : '#4a6fa5',
        fontWeight: p.value > 0 ? '600' : '400',
      }),
    },
    {
      field: 'total',
      headerName: 'Total',
      width: 115,
      type: 'numericColumn',
      valueFormatter: (p) => `₹${p.value.toFixed(2)}`,
      cellStyle: { color: '#69f0ae', fontWeight: '600' },
    },
  ];

  defaultColDef: ColDef = {
    sortable: true,
    resizable: true,
  };

  readonly rowSelection = 'multiple';

  removeSelected() {
    const selected = this.gridApi.getSelectedRows();
    if (!selected.length) return;
    this.rowData = this.rowData.filter(r => !selected.find(s => s.id === r.id));
    this.gridApi.applyTransaction({ remove: selected });
    this.recalcSummary();
    this.selectedCount.set(0);
  }

  constructor(private http: HttpClient, private zone: NgZone) {}

  ngOnInit() {
    this.connect();
    this.searchSubject.pipe(
      debounceTime(200),
      distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 3) {
          this.searchResults.set([]);
          this.isSearching.set(false);
          return of([]);
        }
        this.isSearching.set(true);
        return this.http
          .get<ProductResult[]>(`/api/products/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.searchResults.set(results);
      this.isSearching.set(false);
      this.showDropdown.set(results.length > 0);
    });
  }

  // ── Search handlers ───────────────────────────────────────

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
    // Focus qty input after selection
    setTimeout(() => {
      const qtyEl = document.getElementById('manualQty');
      qtyEl?.focus();
      (qtyEl as HTMLInputElement)?.select();
    }, 50);
  }

  addManually() {
    const product = this.selectedProduct();
    if (!product) return;
    const qty = Math.max(1, this.manualQty());

    this.upsertItem(product, qty);

    // Reset search UI
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
    // Small delay so click on item fires before blur hides it
    setTimeout(() => this.showDropdown.set(false), 150);
  }

  ngOnDestroy() {
    this.disconnect();
    this.searchSubject.complete();
  }

  // ── WebSocket ─────────────────────────────────────────────

  private connect() {
    const url = `ws://localhost:${5050}/ws`;
    this.setWsStatus('connecting');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.zone.run(() => {
        this.setWsStatus('connected');
        this.lastError.set('');
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      });
    };

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
      } catch {
        // ignore non-JSON frames
      }
    };

    this.ws.onclose = () => {
      this.zone.run(() => {
        this.setWsStatus('disconnected');
        this.scheduleReconnect();
      });
    };

    this.ws.onerror = () => {
      this.zone.run(() => {
        this.lastError.set(`Cannot reach ws://localhost:${5050}/ws`);
        this.ws?.close();
      });
    };
  }

  private disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect() {
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  // ── Barcode → API → Grid ─────────────────────────────────

  private showError(msg: string) {
    this.lastError.set(msg);
    setTimeout(() => this.lastError.set(''), 3000);
  }

  private onBarcodeScanned(barcode: string) {
    this.http
      .get<ProductResult | null>(`/api/products/${barcode}`)
      .pipe(catchError(() => of(null)))
      .subscribe(product => {
        if (!product) { this.showError(`Product not found: ${barcode}`); return; }
        this.upsertItem(product);
      });
  }

  private upsertItem(product: ProductResult, qtyToAdd = 1) {
    const existing = this.rowData.find((r) => r.id === product.id);

    if (existing) {
      existing.qty     += qtyToAdd;
      existing.total    = existing.sp * existing.qty;
      existing.savings  = (existing.mrp - existing.sp) * existing.qty;
      // refresh image in case it changed
      if (product.image) existing.image = product.image;
      this.gridApi.applyTransaction({ update: [existing] });
    } else {
      this.slCounter++;
      const newItem: CartItem = {
        slNo:    this.slCounter,
        id:      product.id,
        item:    product.name,
        qty:     qtyToAdd,
        mrp:     product.mrp,
        sp:      product.sp,
        total:   product.sp * qtyToAdd,
        savings: (product.mrp - product.sp) * qtyToAdd,
        image:   product.image,
      };
      this.rowData.push(newItem);
      this.gridApi.applyTransaction({ add: [newItem] });
    }

    this.recalcSummary();
    this.lastError.set('');
  }

  removeItem(row: CartItem) {
    this.rowData = this.rowData.filter(r => r.id !== row.id);
    this.gridApi.applyTransaction({ remove: [row] });
    this.recalcSummary();
  }

  onQtyEdited(event: any) {
    const row: CartItem = event.data;
    row.qty     = Math.max(1, Number(event.newValue) || 1);
    row.total   = row.sp * row.qty;
    row.savings = (row.mrp - row.sp) * row.qty;
    this.gridApi.applyTransaction({ update: [row] });
    this.recalcSummary();
  }

  private recalcSummary() {
    let sub = 0, savings = 0, items = 0;
    for (const r of this.rowData) {
      sub     += r.total;
      savings += r.savings;
      items   += r.qty;
    }
    this.subTotal.set(sub);
    this.totalSavings.set(savings);
    this.itemCount.set(items);
  }

  onGridReady(params: GridReadyEvent<CartItem>) {
    this.gridApi = params.api;
    params.api.addEventListener('selectionChanged', () => {
      this.selectedCount.set(this.gridApi.getSelectedRows().length);
    });
  }

  clearCart() {
    this.rowData = [];
    this.slCounter = 0;
    this.gridApi.setGridOption('rowData', []);
    this.subTotal.set(0);
    this.totalSavings.set(0);
    this.itemCount.set(0);
  }
}