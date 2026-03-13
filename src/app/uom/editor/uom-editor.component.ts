import {
  Component,
  OnInit,
  NgZone,
  signal,
  computed,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError } from 'rxjs/operators';
import { UomNamePipe } from './uom-name.pipe';

// ── Domain types ──────────────────────────────────────────────────────────────

export interface UomRecord {
  id:          number;
  name:        string;
  description: string | null;
  packlevel:   number;
  baseid:      number | null;
  baseqty:     number | null;
  created?:    string;
  createdby?:  string;
  updated?:    string;
  updatedby?:  string;
}

export interface UomChainNode {
  id:        number;
  name:      string;
  baseid:    number | null;
  baseqty:   number | null;
  packlevel: number;
}

interface FormErrors {
  name?:    string;
  baseqty?: string;
}

function emptyForm(): Omit<UomRecord, 'id' | 'created' | 'createdby' | 'updated' | 'updatedby'> {
  return {
    name:        '',
    description: null,
    packlevel:   1,
    baseid:      null,
    baseqty:     null,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector:    'app-uom-editor',
  standalone:  true,
  imports:     [FormsModule, UomNamePipe],
  templateUrl: './uom-editor.component.html',
  styleUrl:    './uom-editor.component.scss',
})
export class UomEditorComponent implements OnInit {

  // ── Mode ──────────────────────────────────────────────────
  mode     = signal<'create' | 'edit'>('create');
  loadedId = signal<number | null>(null);

  setMode(m: 'create' | 'edit') {
    this.mode.set(m);
    if (m === 'create') {
      this.resetForm();
    } else {
      this.resetSearch();
    }
    this.saveStatus.set('idle');
  }

  // ── All UOMs (base dropdown + reference list) ──────────────
  allUoms = signal<UomRecord[]>([]);

  baseOptions = computed(() =>
    this.allUoms().filter(u => u.id !== this.loadedId())
  );

  // ── Form ──────────────────────────────────────────────────
  form   = signal(emptyForm());
  errors = signal<FormErrors>({});

  patch<K extends keyof ReturnType<typeof emptyForm>>(
    key: K,
    value: ReturnType<typeof emptyForm>[K]
  ) {
    this.form.set({ ...this.form(), [key]: value });
    const errs = { ...this.errors() };
    delete errs[key as keyof FormErrors];
    this.errors.set(errs);
  }

  resetForm() {
    this.form.set(emptyForm());
    this.errors.set({});
    this.loadedId.set(null);
    this.chain.set([]);
    this.savedMeta.set(null);
  }

  savedMeta = signal<Pick<UomRecord, 'created' | 'createdby' | 'updated' | 'updatedby'> | null>(null);

  // ── Hierarchy chain ───────────────────────────────────────
  chain        = signal<UomChainNode[]>([]);
  chainLoading = signal(false);

  private fetchChain(baseid: number) {
    this.chainLoading.set(true);
    this.http
      .get<UomChainNode[]>(`/api/uom/chain/${baseid}`)
      .pipe(catchError(() => of([])))
      .subscribe(nodes => {
        this.chain.set(nodes);
        this.chainLoading.set(false);
      });
  }

  // ── Base UOM select ───────────────────────────────────────
  onBaseChange(value: string) {
    const baseid = value === 'null' || value === '' ? null : +value;
    this.patch('baseid', baseid);

    if (baseid === null) {
      this.patch('packlevel', 1);
      this.patch('baseqty', null);
      this.chain.set([]);
    } else {
      // Derive packlevel from chain length (chain returns all ancestors
      // up to and including baseid, so our level = nodes.length + 1)
      this.chainLoading.set(true);
      this.http
        .get<UomChainNode[]>(`/api/uom/chain/${baseid}`)
        .pipe(catchError(() => of([])))
        .subscribe(nodes => {
          this.chain.set(nodes);
          this.chainLoading.set(false);
          this.patch('packlevel', nodes.length + 1);
        });
    }
  }

  // ── Search (edit mode) ────────────────────────────────────
  private searchSubject = new Subject<string>();
  searchQuery   = signal('');
  searchResults = signal<UomRecord[]>([]);
  isSearching   = signal(false);
  showDropdown  = signal(false);

  onSearchInput(value: string) {
    this.searchQuery.set(value);
    this.showDropdown.set(false);
    this.searchSubject.next(value);
  }

  closeDropdown() {
    setTimeout(() => this.showDropdown.set(false), 150);
  }

  resetSearch() {
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.showDropdown.set(false);
    this.resetForm();
  }

  loadUom(item: UomRecord) {
    this.zone.run(() => {
      this.searchQuery.set(item.name);
      this.showDropdown.set(false);

      // Populate immediately from search result
      this.loadedId.set(item.id);
      this.form.set({
        name:        item.name,
        description: item.description,
        packlevel:   item.packlevel,
        baseid:      item.baseid,
        baseqty:     item.baseqty,
      });
      this.savedMeta.set({
        created:   item.created,
        createdby: item.createdby,
        updated:   item.updated,
        updatedby: item.updatedby,
      });
      this.errors.set({});
      this.saveStatus.set('idle');
      if (item.baseid) {
        this.fetchChain(item.baseid);
      } else {
        this.chain.set([]);
      }

      // Enrich with full record from API
      this.http
        .get<UomRecord>(`/api/uom/${item.id}`)
        .pipe(catchError(() => of(null)))
        .subscribe(uom => {
          if (!uom) return;
          this.loadedId.set(uom.id);
          this.form.set({
            name:        uom.name,
            description: uom.description,
            packlevel:   uom.packlevel,
            baseid:      uom.baseid,
            baseqty:     uom.baseqty,
          });
          this.savedMeta.set({
            created:   uom.created,
            createdby: uom.createdby,
            updated:   uom.updated,
            updatedby: uom.updatedby,
          });
          if (uom.baseid) this.fetchChain(uom.baseid);
        });
    });
  }

  // ── Validation ────────────────────────────────────────────
  private validate(): boolean {
    const f    = this.form();
    const errs: FormErrors = {};

    if (!f.name.trim())
      errs.name = 'Name is required';

    if (f.baseid !== null && (!f.baseqty || f.baseqty < 1))
      errs.baseqty = 'Base quantity must be ≥ 1 when a base is selected';

    this.errors.set(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Save ──────────────────────────────────────────────────
  saveStatus = signal<'idle' | 'saving' | 'success' | 'error'>('idle');
  saveError  = signal('');

  onSubmit() {
    if (!this.validate()) return;

    const f = this.form();
    const payload: Partial<UomRecord> = {
      ...f,
      updatedby: 'SYSTEM',
      createdby: this.loadedId() ? this.savedMeta()?.createdby || 'SYSTEM' : 'SYSTEM',
    };

    this.saveStatus.set('saving');

    const req$ = this.loadedId()
      ? this.http.put<UomRecord>(`/api/uom/${this.loadedId()}`, payload)
      : this.http.post<UomRecord>('/api/uom', payload);

    req$.pipe(catchError(err => {
      this.saveStatus.set('error');
      this.saveError.set(err?.error?.message ?? 'Save failed. Please try again.');
      return of(null);
    })).subscribe(result => {
      if (!result) return;
      this.saveStatus.set('success');
      this.loadedId.set(result.id);
      this.mode.set('edit');
      this.form.set({
        name:        result.name,
        description: result.description,
        packlevel:   result.packlevel,
        baseid:      result.baseid,
        baseqty:     result.baseqty,
      });
      this.savedMeta.set({
        created:   result.created,
        createdby: result.createdby,
        updated:   result.updated,
        updatedby: result.updatedby,
      });
      this.loadAllUoms();
      if (result.baseid) this.fetchChain(result.baseid);
      setTimeout(() => this.saveStatus.set('idle'), 3000);
    });
  }

  // ── Init ──────────────────────────────────────────────────
  constructor(private http: HttpClient, private zone: NgZone) {}

  ngOnInit() {
    this.loadAllUoms();

    this.searchSubject.pipe(
      debounceTime(200),
      distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 1) {
          this.searchResults.set([]);
          this.isSearching.set(false);
          return of([]);
        }
        this.isSearching.set(true);
        return this.http
          .get<UomRecord[]>(`/api/uom/search?q=${encodeURIComponent(query)}`)
          .pipe(catchError(() => of([])));
      })
    ).subscribe(results => {
      this.searchResults.set(results);
      this.isSearching.set(false);
      this.showDropdown.set(results.length > 0 || this.searchQuery().length >= 1);
    });
  }

  private loadAllUoms() {
    this.http
      .get<UomRecord[]>('/api/uom')
      .pipe(catchError(() => of([])))
      .subscribe(list => this.allUoms.set(list));
  }
}
