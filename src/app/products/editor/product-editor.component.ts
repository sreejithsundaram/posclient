import {
  Component,
  OnInit,
  OnDestroy,
  NgZone,
  signal,
  computed,
  ElementRef,
  ViewChild,
  input,
  output,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { ScannerService } from '../../scanner.service';

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Uom {
  id:        number;
  name:      string;
  packlevel: number;
  baseid:    number | null;
}

export interface ProductPayload {
  id?: number;
  code: string;
  name: string;
  description: string;
  barcode: string;
  mrp: number | null;
  sp: number | null;
  thumb: string;
  picture: string;
  uomid: number | null;
  sellable: boolean;
  baseproductid: number | null;
  created?: string;
  createdby?: string;
  updated?: string;
  updatedby?: string;
}

export interface ProductSearchResult {
  id: number;
  code: string;
  name: string;
  barcode?: string;
  sp?: number;
  thumb?: string;
}

// ── Validation errors ────────────────────────────────────────────────────────

interface FormErrors {
  code?: string;
  name?: string;
  mrp?: string;
  sp?: string;
  uomid?: string;
  barcode?: string;
  baseproductid?: string;
}

// ── Empty form factory ───────────────────────────────────────────────────────

function emptyForm(): ProductPayload {
  return {
    code: '',
    name: '',
    description: '',
    barcode: '',
    mrp: null,
    sp: null,
    thumb: '',
    picture: '',
    uomid: null,
    sellable: true,
    baseproductid: null,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-product-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './product-editor.component.html',
  styleUrl: './product-editor.component.scss',
})
export class ProductEditorComponent implements OnInit, OnDestroy {
  readonly isActive = input<boolean>(true);

  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('thumbFileInput') thumbFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('pictureFileInput') pictureFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('barcodeInput1') barcodeInput1Ref!: ElementRef<HTMLInputElement>;
  @ViewChild('barcodeInput2') barcodeInput2Ref!: ElementRef<HTMLInputElement>;

  private barcodeBuffer = '';
  private barcodeTimer: any = null;

  scannerStatus = computed(() => this.scanner.status());

  // ── Browse Mode ─────────────────────────────────────────
  browseMode = signal<'search' | 'list'>('search');
  setBrowseMode(m: 'search' | 'list') {
    this.browseMode.set(m);
    if (m === 'list' && this.allProducts().length === 0) {
      this.loadAllProducts(1);
    }
  }

  // ── Mode ────────────────────────────────────────────────
  mode = signal<'create' | 'edit'>('create');

  setMode(m: 'create' | 'edit') {
    this.mode.set(m);
    if (m === 'create') {
      this.loadedId.set(null);
      this.resetForm();
    } else {
      this.resetSearch();
    }
    this.saveStatus.set('idle');
  }

  // ── Form state ───────────────────────────────────────────
  form = signal<ProductPayload>(emptyForm());
  errors = signal<FormErrors>({});
  loadedId = signal<number | null>(null);

  patch<K extends keyof ProductPayload>(key: K, value: ProductPayload[K]) {
    this.form.set({ ...this.form(), [key]: value });
    // Clear the specific field error on change
    const errs = { ...this.errors() };
    delete errs[key as keyof FormErrors];
    this.errors.set(errs);
  }

  toggle(key: 'sellable') {
    this.patch(key, !this.form()[key] as any);
  }

  resetForm() {
    this.form.set(emptyForm());
    this.thumbPreview.set(null);
    this.picturePreview.set(null);
    this.autoThumb.set(true);
    this.errors.set({});
    this.loadedId.set(null);
    this.barcodeConfirm.set('');
    this.barcodeScanned.set(false);
    this.selectedBaseProduct.set(null);
    this.baseProductQuery.set('');
    this.baseProductResults.set([]);
    this.showBaseProductDropdown.set(false);
  }

  // ── Conflict/Prompt state ───────────────────────────────
  conflictProduct    = signal<ProductPayload | null>(null);
  showConflictPrompt = signal(false);

  confirmLoadConflict() {
    if (this.conflictProduct()) {
      this.loadProduct(this.conflictProduct() as any);
      this.showConflictPrompt.set(false);
      this.conflictProduct.set(null);
    }
  }

  cancelConflict() {
    this.showConflictPrompt.set(false);
    this.conflictProduct.set(null);
    // User opted NOT to switch — clear barcode fields for current product as requested
    this.patch('barcode', '');
    this.barcodeConfirm.set('');
  }

  // ── Barcode confirm + scan state ─────────────────────────
  barcodeConfirm = signal('');
  barcodeScanned = signal(false);
  private barcodeFlashTimer: any = null;

  onBarcodeInput(value: string) {
    this.patch('barcode', value);
    // Clear barcode error when user types
    const errs = { ...this.errors() };
    delete errs['barcode'];
    this.errors.set(errs);
  }

  onBarcodeConfirmInput(value: string) {
    this.barcodeConfirm.set(value);
  }

  private applyScannedBarcode(barcode: string) {
    console.log('[Scanner] Looking up barcode:', barcode);
    this.http
      .get<ProductPayload | null>(`/api/products/${encodeURIComponent(barcode)}?pos=false`)
      .pipe(catchError(() => of(null)))
      .subscribe((product) => {
        console.log('[Scanner] Product lookup result:', product);

        if (this.loadedId()) {
          // --- CASE: EDIT MODE ---
          if (product) {
            if (product.id === this.loadedId()) {
              // Current product — just verify
              this.barcodeConfirm.set(barcode);
            } else {
              // CONFLICT: Belongs to DIFFERENT product
              this.conflictProduct.set(product);
              this.showConflictPrompt.set(true);
            }
          } else {
            // New barcode for current product
            this.patch('barcode', barcode);
            this.barcodeConfirm.set(barcode);
          }
        } else {
          // --- CASE: CREATE MODE (Existing behavior) ---
          if (product) {
            console.log('[Scanner] Loading existing product into edit mode');
            this.mode.set('edit');
            this.loadedId.set(product.id!);
            this.searchQuery.set(product.name);
            this.applyProductToForm(product);
          } else {
            console.log('[Scanner] Product not found, staying in create mode');
            this.patch('barcode', barcode);
            this.barcodeConfirm.set(barcode);
          }
        }

        this.barcodeScanned.set(true);
        if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
        this.barcodeFlashTimer = setTimeout(() => this.barcodeScanned.set(false), 2000);
      });
  }

  private applyProductToForm(product: ProductPayload) {
    // API returns 'image', schema stores as 'thumb' — normalise
    const { image: _img, ...rest } = product as any;
    const normalised = {
      ...rest,
      thumb:   _img ?? product.thumb   ?? '',
      picture: product.picture ?? '',
    };
    this.form.set({ ...emptyForm(), ...normalised });
    this.barcodeConfirm.set(normalised.barcode ?? '');
    this.thumbPreview.set(normalised.thumb ? `data:image/jpeg;base64,${normalised.thumb}` : null);
    this.picturePreview.set(normalised.picture ? `data:image/jpeg;base64,${normalised.picture}` : null);
    this.autoThumb.set(!normalised.thumb && !!normalised.picture);
    this.errors.set({});
    this.saveStatus.set('idle');
  }

  // ── WebSocket barcode scanner ─────────────────────────────

  // ── Image handling ───────────────────────────────────────
  thumbPreview   = signal<string | null>(null);
  picturePreview = signal<string | null>(null);
  autoThumb      = signal(true);   // when true, API generates thumb from picture

  onPictureFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.readPictureFile(file);
  }

  onPictureDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) this.readPictureFile(file);
  }

  private readPictureFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64  = dataUrl.split(',')[1] ?? '';
      this.picturePreview.set(dataUrl);
      this.patch('picture', base64);
      // If auto-thumb is on, clear any manual thumb so API generates it
      if (this.autoThumb()) {
        this.patch('thumb', '');
        this.thumbPreview.set(null);
      }
    };
    reader.readAsDataURL(file);
  }

  clearPicture() {
    this.picturePreview.set(null);
    this.patch('picture', '');
    if (this.pictureFileInputRef) this.pictureFileInputRef.nativeElement.value = '';
  }

  onThumbFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.readThumbFile(file);
  }

  onThumbDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) this.readThumbFile(file);
  }

  private readThumbFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64  = dataUrl.split(',')[1] ?? '';
      this.thumbPreview.set(dataUrl);
      this.patch('thumb', base64);
    };
    reader.readAsDataURL(file);
  }

  clearThumb() {
    this.thumbPreview.set(null);
    this.patch('thumb', '');
    if (this.thumbFileInputRef) this.thumbFileInputRef.nativeElement.value = '';
  }

  toggleAutoThumb() {
    const next = !this.autoThumb();
    this.autoThumb.set(next);
    if (next) {
      // Switching auto ON — clear any manually set thumb
      this.clearThumb();
    }
  }

  // ── UOMs ─────────────────────────────────────────────────
  uoms = signal<Uom[]>([]);
  uomLoading = signal(false);

  // Derives the full UOM record for the currently selected uomid
  selectedUom = computed(() =>
    this.uoms().find(u => u.id === this.form().uomid) ?? null
  );

  // True when the selected UOM is not a root (packlevel > 1), meaning
  // it represents a pack of something — user must link a base product
  requiresBaseProduct = computed(() =>
    (this.selectedUom()?.packlevel ?? 1) > 1
  );

  // The base UOM that base-product candidates must use
  baseUomId = computed(() => this.selectedUom()?.baseid ?? null);
  baseUomName = computed(() =>
    this.uoms().find(u => u.id === this.baseUomId())?.name ?? ''
  );

  private loadUoms() {
    this.uomLoading.set(true);
    this.http
      .get<Uom[]>('/api/uom')
      .pipe(catchError(() => of([])))
      .subscribe((data) => {
        this.uoms.set(data);
        this.uomLoading.set(false);
      });
  }

  onUomChange(uomid: number | null) {
    this.patch('uomid', uomid);
    // When UOM changes, clear any previously selected base product
    this.patch('baseproductid', null);
    this.baseProductQuery.set('');
    this.baseProductResults.set([]);
    this.showBaseProductDropdown.set(false);
    this.selectedBaseProduct.set(null);
  }

  // ── Base product search ───────────────────────────────────
  private baseProductSubject = new Subject<string>();
  baseProductQuery          = signal('');
  baseProductResults        = signal<ProductSearchResult[]>([]);
  isBaseProductSearching    = signal(false);
  showBaseProductDropdown   = signal(false);
  selectedBaseProduct       = signal<ProductSearchResult | null>(null);

  onBaseProductInput(value: string) {
    this.baseProductQuery.set(value);
    if (!value) {
      this.patch('baseproductid', null);
      this.selectedBaseProduct.set(null);
    }
    this.showBaseProductDropdown.set(false);
    this.baseProductSubject.next(value);
  }

  closeBaseProductDropdown() {
    setTimeout(() => this.showBaseProductDropdown.set(false), 150);
  }

  selectBaseProduct(item: ProductSearchResult) {
    this.selectedBaseProduct.set(item);
    this.baseProductQuery.set(item.name);
    this.patch('baseproductid', item.id);
    this.showBaseProductDropdown.set(false);
  }

  clearBaseProduct() {
    this.selectedBaseProduct.set(null);
    this.baseProductQuery.set('');
    this.patch('baseproductid', null);
    this.baseProductResults.set([]);
    this.showBaseProductDropdown.set(false);
  }

  // ── Product search (edit mode) ────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery = signal('');
  searchResults = signal<ProductSearchResult[]>([]);
  isSearching = signal(false);
  showSearchDropdown = signal(false);

  onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.showSearchDropdown.set(false);
    this.searchSubject.next(value);
  }

  closeSearchDropdown() {
    setTimeout(() => this.showSearchDropdown.set(false), 150);
  }

  resetSearch() {
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.showSearchDropdown.set(false);
    this.loadedId.set(null);
    this.form.set(emptyForm());
    this.thumbPreview.set(null);
    this.showConflictPrompt.set(false);
  }

  // ── Browse All List ───────────────────────────────────────
  allProducts   = signal<ProductSearchResult[]>([]);
  allProductsPager = signal({ page: 1, totalPages: 1, hasNext: false, hasPrevious: false, totalRecords: 0 });
  isLoadingAll  = signal(false);

  loadAllProducts(page = 1) {
    this.isLoadingAll.set(true);
    this.http.get<any>(`/api/Products/all?page=${page}&size=10&pos=false`)
      .pipe(catchError(() => of({ items: [], page, totalPages: 1, totalRecords: 0 })))
      .subscribe(res => {
        this.allProducts.set(res.items || []);
        this.allProductsPager.set({
          page: res.page,
          totalPages: res.totalPages,
          hasNext: res.hasNext,
          hasPrevious: res.hasPrevious,
          totalRecords: res.totalRecords
        });
        this.isLoadingAll.set(false);
      });
  }

  changeAllProductsPage(delta: number) {
    const next = this.allProductsPager().page + delta;
    if (next >= 1 && next <= this.allProductsPager().totalPages) {
      this.loadAllProducts(next);
    }
  }

  loadProduct(item: ProductSearchResult) {
    this.searchQuery.set(item.name);
    this.showSearchDropdown.set(false);
    this.http
      .get<ProductPayload>(`/api/Products?id=${item.id}&pos=false`)
      .pipe(catchError((err) => {
        console.error('[Editor] Failed to load product:', err.status, err.message);
        return of(null);
      }))
      .subscribe((product) => {
        if (!product) return;
        this.loadedId.set(product.id ?? item.id);
        const { image: _img, ...rest } = product as any;
        const normalised = {
          ...rest,
          thumb:   _img ?? product.thumb   ?? '',
          picture: product.picture ?? '',
          baseproductid: product.baseproductid ?? null,
        };
        this.form.set({ ...emptyForm(), ...normalised });
        this.barcodeConfirm.set(normalised.barcode ?? '');
        this.barcodeScanned.set(false);
        this.thumbPreview.set(normalised.thumb ? `data:image/jpeg;base64,${normalised.thumb}` : null);
        this.picturePreview.set(normalised.picture ? `data:image/jpeg;base64,${normalised.picture}` : null);
        this.autoThumb.set(!normalised.thumb && !!normalised.picture);
        this.errors.set({});
        this.saveStatus.set('idle');

        // Restore base product display if present
        if (normalised.baseproductid) {
          this.http
            .get<ProductPayload>(`/api/Products?id=${normalised.baseproductid}&pos=false`)
            .pipe(catchError(() => of(null)))
            .subscribe(bp => {
              if (bp) {
                this.selectedBaseProduct.set({ id: bp.id!, code: bp.code, name: bp.name });
                this.baseProductQuery.set(bp.name);
              }
            });
        } else {
          this.selectedBaseProduct.set(null);
          this.baseProductQuery.set('');
        }
      });
  }

  // ── Validation ────────────────────────────────────────────
  private validate(): boolean {
    const f = this.form();
    const errs: FormErrors = {};

    if (!f.code.trim())        errs.code   = 'Code is required';
    if (!f.name.trim())        errs.name   = 'Name is required';
    if (f.mrp === null || isNaN(f.mrp as number) || (f.mrp as number) < 0)
                               errs.mrp    = 'Valid MRP required';
    if (f.sp === null || isNaN(f.sp as number) || (f.sp as number) < 0)
                               errs.sp     = 'Valid SP required';
    if (f.barcode && f.barcode !== this.barcodeConfirm())
                               errs.barcode = 'Barcodes do not match';
    if (!f.uomid)              errs.uomid  = 'UOM is required';
    if (this.requiresBaseProduct() && !f.baseproductid)
                               errs.baseproductid = `Select the base ${this.baseUomName()} product`;

    this.errors.set(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Save ──────────────────────────────────────────────────
  saveStatus = signal<'idle' | 'saving' | 'success' | 'error'>('idle');
  saveError  = signal('');

  onSubmit() {
    if (!this.validate()) return;

    const f = this.form();
    const payload: ProductPayload & { autoThumb?: boolean; image?: never } = {
      ...f,
      thumb:     f.thumb,
      picture:   f.picture,
      updatedby: 'SYSTEM',
      createdby: this.loadedId() ? f.createdby || 'SYSTEM' : 'SYSTEM',
      autoThumb: this.autoThumb(),
    };
    // Ensure the raw 'image' field from the API response never leaks into PUT/POST
    delete (payload as any).image;

    this.saveStatus.set('saving');

    const req$ = this.loadedId()
      ? this.http.put<ProductPayload>(`/api/products/${this.loadedId()}`, payload)
      : this.http.post<ProductPayload>('/api/products', payload);

    req$.pipe(catchError((err) => {
      this.saveStatus.set('error');
      this.saveError.set(err?.error?.message ?? 'Save failed. Please try again.');
      return of(null);
    })).subscribe((result) => {
      if (!result) return;
      this.saveStatus.set('success');

      // Normalise the returned payload (API may return 'image' instead of 'thumb')
      const { image: _img, ...rest } = result as any;
      const normalised = {
        ...rest,
        thumb:   _img ?? result.thumb   ?? '',
        picture: result.picture ?? '',
      };

      this.loadedId.set(normalised.id ?? this.loadedId());
      this.mode.set('edit');
      this.form.set({ ...emptyForm(), ...normalised });
      this.barcodeConfirm.set(normalised.barcode ?? '');
      this.thumbPreview.set(normalised.thumb   ? `data:image/jpeg;base64,${normalised.thumb}`   : null);
      this.picturePreview.set(normalised.picture ? `data:image/jpeg;base64,${normalised.picture}` : null);
      // Reflect auto-thumb state from what the server stored
      this.autoThumb.set(!normalised.thumb && !!normalised.picture);

      setTimeout(() => this.saveStatus.set('idle'), 3000);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────
  constructor(private http: HttpClient, private zone: NgZone, private scanner: ScannerService) {}

  ngOnInit() {
    this.loadUoms();

    this.scanner.barcode$.subscribe(barcode => {
      if (!this.isActive() || document.visibilityState !== 'visible') return;
      this.zone.run(() => this.applyScannedBarcode(barcode));
    });

    this.searchSubject.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((query) => {
        if (query.length < 3) {
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
      this.showSearchDropdown.set(results.length > 0 || this.searchQuery().length >= 3);
    });

    this.baseProductSubject.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((query) => {
        const baseUom = this.baseUomId();
        if (query.length < 2 || !baseUom) {
          this.baseProductResults.set([]);
          this.isBaseProductSearching.set(false);
          return of([]);
        }
        this.isBaseProductSearching.set(true);
        return this.http
          .get<ProductSearchResult[]>(
            `/api/products/search?q=${encodeURIComponent(query)}&uomid=${baseUom}&pos=false`
          )
          .pipe(catchError(() => of([])));
      })
    ).subscribe((results) => {
      this.baseProductResults.set(results);
      this.isBaseProductSearching.set(false);
      this.showBaseProductDropdown.set(results.length > 0 || this.baseProductQuery().length >= 2);
    });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
    this.baseProductSubject.complete();
    if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
  }
}