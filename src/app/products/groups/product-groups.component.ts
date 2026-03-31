import { Component, OnInit, OnDestroy, signal, input } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { ProductSearchResult } from '../editor/product-editor.component';

export interface ProductGroupLineView {
    productId: number;
    code: string;
    name: string;
}

export interface ProductGroupView {
    id: number | null;
    name: string;
    lines?: ProductGroupLineView[];
}

export interface PagedResponse<T> {
    page: number;
    size: number;
    totalRecords: number;
    count: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
    items: T[];
}

@Component({
  selector: 'app-product-groups',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './product-groups.component.html',
  styleUrl: './product-groups.component.scss'
})
export class ProductGroupsComponent implements OnInit, OnDestroy {
  readonly isActive = input<boolean>(true);

  groups = signal<ProductGroupView[]>([]);
  groupsPager = signal({ page: 1, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 });
  loadedId = signal<number | null>(null);
  
  form = signal<ProductGroupView>({ id: null, name: '', lines: [] });
  errors = signal<{ name?: string }>({});
  
  mode = signal<'create' | 'edit'>('create');
  
  saveStatus = signal<'idle' | 'saving' | 'success' | 'error'>('idle');
  saveError = signal('');

  // ── Product Picker ───────────────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery = signal('');
  allProducts = signal<ProductSearchResult[]>([]);
  productsPager = signal({ page: 1, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 });
  searchResults = signal<ProductSearchResult[]>([]);
  isLoadingAll = signal(false);
  isSearching = signal(false);

  /** Products shown in the picker: search results when query is typed, else all products */
  get pickerProducts(): ProductSearchResult[] {
    const query = this.searchQuery();
    return query.length >= 2 ? this.searchResults() : this.allProducts();
  }

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadGroups();
    this.loadAllProducts();

    this.searchSubject.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((query) => {
        if (query.length < 2) {
          this.searchResults.set([]);
          this.isSearching.set(false);
          return of([]);
        }
        this.isSearching.set(true);
        return this.http
          .get<ProductSearchResult[]>(`/api/products/search?q=${encodeURIComponent(query)}&pos=false`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe((results) => {
      this.searchResults.set(results);
      this.isSearching.set(false);
    });
  }

  loadAllProducts(page = 1) {
    this.isLoadingAll.set(true);
    this.http.get<PagedResponse<ProductSearchResult>>(`/api/Products/all?page=${page}&size=10&pos=false`)
      .pipe(catchError(() => of({ items: [], page, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 } as any)))
      .subscribe((res: any) => {
        this.allProducts.set(res.items || []);
        this.productsPager.set({ 
          page: res.page, 
          totalPages: res.totalPages, 
          hasNext: res.hasNext, 
          hasPrevious: res.hasPrevious,
          totalRecords: res.totalRecords
        });
        this.isLoadingAll.set(false);
      });
  }

  changeProductsPage(delta: number) {
    const next = this.productsPager().page + delta;
    if (next >= 1 && next <= this.productsPager().totalPages) {
      this.loadAllProducts(next);
    }
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  loadGroups(page = 1) {
    console.log(`[Groups] Loading groups page ${page} from /api/ProductGroup...`);
    this.http.get<PagedResponse<ProductGroupView>>(`/api/ProductGroup?page=${page}&size=10`)
      .pipe(catchError(err => {
        console.error('[Groups] Failed to load groups:', err);
        return of({ items: [], page, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 } as any);
      }))
      .subscribe((res: any) => {
        console.log('[Groups] Loaded groups:', res);
        this.groups.set(res.items || []);
        this.groupsPager.set({ 
          page: res.page, 
          totalPages: res.totalPages, 
          hasNext: res.hasNext, 
          hasPrevious: res.hasPrevious,
          totalRecords: res.totalRecords
        });
      });
  }

  changeGroupsPage(delta: number) {
    const next = this.groupsPager().page + delta;
    if (next >= 1 && next <= this.groupsPager().totalPages) {
      this.loadGroups(next);
    }
  }

  setMode(m: 'create' | 'edit') {
    this.mode.set(m);
    if (m === 'create') {
      this.loadedId.set(null);
      this.form.set({ id: null, name: '', lines: [] });
      this.errors.set({});
      this.searchQuery.set('');
    }
    this.saveStatus.set('idle');
  }

  loadGroup(group: ProductGroupView) {
    this.http.get<ProductGroupView>(`/api/ProductGroup/${group.id}`)
      .pipe(catchError(() => of(null)))
      .subscribe(res => {
        if (res) {
          this.loadedId.set(res.id);
          this.form.set(res);
          this.mode.set('edit');
          this.errors.set({});
          this.searchQuery.set('');
          this.saveStatus.set('idle');
        }
      });
  }

  patchName(name: string) {
    this.form.set({ ...this.form(), name });
    this.errors.set({});
  }

  // ── Lines logic ──────────────────────────────────────────
  clear() {
    this.setMode('create');
  }

  onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.searchSubject.next(value);
  }

  closeSearchDropdown() {
    // No-op: handled by picker results always showing in current layout
  }

  addLine(product: ProductSearchResult) {
    const currentLines = this.form().lines || [];
    // check if already added
    if (!currentLines.find(l => l.productId === product.id)) {
      const newLine: ProductGroupLineView = {
        productId: product.id,
        code: product.code,
        name: product.name
      };
      this.form.set({ ...this.form(), lines: [...currentLines, newLine] });
    }
    this.searchQuery.set('');
  }

  removeLine(productId: number) {
    const currentLines = this.form().lines || [];
    const filtered = currentLines.filter(l => l.productId !== productId);
    this.form.set({ ...this.form(), lines: filtered });
  }

  // ── Save/Delete ──────────────────────────────────────────
  onSubmit() {
    const f = this.form();
    if (!f.name.trim()) {
      this.errors.set({ name: 'Name is required' });
      return;
    }

    this.saveStatus.set('saving');
    this.http.post<ProductGroupView>('/api/ProductGroup/edit', f)
      .pipe(catchError(err => {
        this.saveStatus.set('error');
        this.saveError.set(err?.error?.message ?? 'Save failed.');
        return of(null);
      }))
      .subscribe(res => {
        if (res) {
          this.saveStatus.set('success');
          this.loadGroups();
          this.loadedId.set(res.id);
          this.form.set(res);
          this.mode.set('edit');
          setTimeout(() => this.saveStatus.set('idle'), 3000);
        }
      });
  }

  onDelete() {
    if (!this.loadedId() || !confirm('Are you sure you want to delete this group?')) return;
    
    this.http.delete(`/api/ProductGroup/${this.loadedId()}`)
      .pipe(catchError(() => of(null)))
      .subscribe(() => {
        this.loadGroups();
        this.setMode('create');
      });
  }
}
