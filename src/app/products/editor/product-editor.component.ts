import {
  Component,
  OnInit,
  OnDestroy,
  NgZone,
  signal,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Uom {
  id: number;
  name: string;
}

export interface ProductPayload {
  id?: number;
  code: string;
  name: string;
  description: string;
  barcode: string;
  mrp: number | null;
  sp: number | null;
  thumb: string;        // base64, API stores as varbinary
  picture: string;      // base64, API stores as varbinary
  uomid: number | null;
  sellable: boolean;
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
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('thumbFileInput') thumbFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('pictureFileInput') pictureFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('barcodeInput1') barcodeInput1Ref!: ElementRef<HTMLInputElement>;
  @ViewChild('barcodeInput2') barcodeInput2Ref!: ElementRef<HTMLInputElement>;

  private ws: WebSocket | null = null;
  private wsReconnectTimer: any = null;
  private barcodeBuffer = '';
  private barcodeTimer: any = null;

  scannerStatus = signal<'connecting' | 'connected' | 'disconnected'>('disconnected');

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
        if (product) {
          console.log('[Scanner] Loading existing product into edit mode');
          this.mode.set('edit');
          this.loadedId.set(product.id!);
          this.searchQuery.set(product.name);
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
        } else {
          console.log('[Scanner] Product not found, switching to create mode');
          this.mode.set('create');
          this.loadedId.set(null);
          this.patch('barcode', barcode);
          this.barcodeConfirm.set(barcode);
        }

        this.barcodeScanned.set(true);
        if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
        this.barcodeFlashTimer = setTimeout(() => this.barcodeScanned.set(false), 2000);
      });
  }

  // ── WebSocket barcode scanner ─────────────────────────────

  private connectScanner() {
    const url = 'ws://localhost:5050/ws';
    console.log('[Scanner] Connecting to', url);
    this.scannerStatus.set('connecting');
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[Scanner] Connected');
      this.zone.run(() => this.scannerStatus.set('connected'));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'barcode' && msg.value) {
          console.log('[Scanner] Barcode received:', msg.value);
          this.zone.run(() => this.applyScannedBarcode(msg.value));
        }
      } catch (e) {
        console.error('[Scanner] Failed to parse message:', event.data, e);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[Scanner] Disconnected — code:', event.code);
      this.zone.run(() => {
        this.scannerStatus.set('disconnected');
        this.wsReconnectTimer = setTimeout(() => this.connectScanner(), 2000);
      });
    };

    this.ws.onerror = (event) => {
      console.error('[Scanner] WebSocket error:', event);
      this.ws?.close();
    };
  }

  private disconnectScanner() {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

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
  }

  loadProduct(item: ProductSearchResult) {
    this.searchQuery.set(item.name);
    this.showSearchDropdown.set(false);
    console.log('[Editor] Loading product id:', item.id);
    // Fetch full product details by ID
    this.http
      .get<ProductPayload>(`/api/Products?id=${item.id}`)
      .pipe(catchError((err) => {
        console.error('[Editor] Failed to load product:', err.status, err.message);
        return of(null);
      }))
      .subscribe((product) => {
        console.log('[Editor] Product response:', product);
        if (!product) return;
        this.loadedId.set(product.id ?? item.id);
        const { image: _img, ...rest } = product as any;
        const normalised = {
          ...rest,
          thumb:   _img ?? product.thumb   ?? '',
          picture: product.picture ?? '',
        };
        this.form.set({ ...emptyForm(), ...normalised });
        this.barcodeConfirm.set(normalised.barcode ?? '');
        this.barcodeScanned.set(false);
        this.thumbPreview.set(normalised.thumb ? `data:image/jpeg;base64,${normalised.thumb}` : null);
        this.picturePreview.set(normalised.picture ? `data:image/jpeg;base64,${normalised.picture}` : null);
        // If no manual thumb stored, assume auto mode
        this.autoThumb.set(!normalised.thumb && !!normalised.picture);
        this.errors.set({});
        this.saveStatus.set('idle');
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
  constructor(private http: HttpClient, private zone: NgZone) {}

  ngOnInit() {
    this.loadUoms();
    this.connectScanner();

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
          .get<ProductSearchResult[]>(`/api/products/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe((results) => {
      this.searchResults.set(results);
      this.isSearching.set(false);
      this.showSearchDropdown.set(results.length > 0 || this.searchQuery().length >= 3);
    });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
    this.disconnectScanner();
    if (this.barcodeFlashTimer) clearTimeout(this.barcodeFlashTimer);
  }
}