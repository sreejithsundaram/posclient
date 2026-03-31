import {
  Component, OnInit, OnDestroy, signal, computed, input,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { AgGridAngular } from 'ag-grid-angular';
import {
  ColDef, GridApi, GridReadyEvent, themeQuartz,
  AllCommunityModule, ModuleRegistry,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

// ── Domain types ──────────────────────────────────────────────────────────────

export interface InventoryView {
  id:           number;
  code:         string;
  name:         string;
  description:  string;
  uomName:      string;
  availableQty: number | null;
}

export interface PagedResponse<T> {
  page:         number;
  size:         number;
  totalRecords: number;
  count:        number;
  totalPages:   number;
  hasNext:      boolean;
  hasPrevious:  boolean;
  items:        T[];
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector:    'app-inventory',
  standalone:  true,
  imports:     [AgGridAngular, FormsModule, CommonModule],
  templateUrl: './inventory.component.html',
  styleUrl:    './inventory.component.scss',
})
export class InventoryComponent implements OnInit, OnDestroy {
  readonly isActive = input<boolean>(true);

  inventory = signal<InventoryView[]>([]);
  pager     = signal({ page: 1, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 });
  isLoading = signal(false);

  // ── Search ────────────────────────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery   = signal('');
  isSearching   = signal(false);

  // ── Grid ──────────────────────────────────────────────────
  private gridApi!: GridApi<InventoryView>;

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

  colDefs: ColDef<InventoryView>[] = [
    { headerName: 'Code',        field: 'code',      width: 120 },
    { headerName: 'Product Name', field: 'name',      flex: 1,    minWidth: 200 },
    { headerName: 'Description',  field: 'description', flex: 1.5,  minWidth: 250 },
    { headerName: 'UOM',         field: 'uomName',   width: 100 },
    {
      headerName: 'Qty',
      field: 'availableQty',
      width: 100,
      cellStyle: (p) => ({
        color: (p.value ?? 0) <= 0 ? '#ff8a65' : '#69f0ae',
        fontWeight: 'bold',
        fontFamily: "'JetBrains Mono', monospace",
        textAlign: 'right',
      }),
      valueFormatter: (p) => (p.value !== null ? p.value.toFixed(2) : '0.00'),
    },
  ];

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadInventory();

    this.searchSubject.pipe(
      debounceTime(400),
      distinctUntilChanged()
    ).subscribe((query) => {
      this.loadInventory(1, query);
    });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.searchSubject.next(value);
  }

  clearSearch() {
    this.searchQuery.set('');
    this.loadInventory(1, '');
  }

  loadInventory(page = 1, query = this.searchQuery()) {
    this.isLoading.set(true);
    const size = 20;
    
    let url = `/api/Inventory?page=${page}&size=${size}`;
    if (query.trim()) {
      url = `/api/Inventory/search?q=${encodeURIComponent(query)}&page=${page}&size=${size}`;
    }

    this.http.get<PagedResponse<InventoryView>>(url)
      .pipe(catchError(() => of({
        items: [], page, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0, count: 0, size
      } as PagedResponse<InventoryView>)))
      .subscribe((res) => {
        this.inventory.set(res.items || []);
        this.pager.set({
          page: res.page,
          totalPages: res.totalPages,
          hasNext: res.hasNext,
          hasPrevious: res.hasPrevious,
          totalRecords: res.totalRecords
        });
        this.isLoading.set(false);
        this.gridApi?.setGridOption('rowData', res.items || []);
      });
  }

  changePage(delta: number) {
    const next = this.pager().page + delta;
    if (next >= 1 && next <= this.pager().totalPages) {
      this.loadInventory(next);
    }
  }

  onGridReady(params: GridReadyEvent<InventoryView>) {
    this.gridApi = params.api;
    params.api.setGridOption('rowData', this.inventory());
  }
}
