import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';

export interface LoginResponse {
  user: {
    id:        string;
    userName:  string;
    email:     string;
    fullName?: string;
  };
  accessToken:  string;
  refreshToken: string;
  roles:        string[];
  expires?:     string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly SESSION_KEY = 'pos_session';

  session  = signal<LoginResponse | null>(this.loadSession());
  isLoggedIn = computed(() => !!this.session()?.accessToken);
  busy     = signal(false);
  error    = signal('');

  private loadSession(): LoginResponse | null {
    try {
      const raw = sessionStorage.getItem(this.SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as LoginResponse;
      s.roles = s.roles ?? [];
      if (s.expires && new Date(s.expires) < new Date()) {
        sessionStorage.removeItem(this.SESSION_KEY); return null;
      }
      return s;
    } catch { return null; }
  }

  login(email: string, password: string) {
    this.busy.set(true);
    this.error.set('');
    return this.http.post<LoginResponse>('/api/auth/login', { email, password })
      .pipe(catchError(err => {
        this.error.set(err?.error?.message ?? err?.error ?? 'Login failed');
        this.busy.set(false);
        return of(null);
      }));
  }

  setSession(s: LoginResponse) {
    const safe = { ...s, roles: s.roles ?? [] };
    this.session.set(safe);
    sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(safe));
    this.busy.set(false);
  }

  logout() {
    this.session.set(null);
    sessionStorage.removeItem(this.SESSION_KEY);
  }

  constructor(private http: HttpClient) {}
}
