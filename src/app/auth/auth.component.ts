import { Component, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { AuthService } from './auth.service';

type AdminTab = 'users' | 'roles' | 'permissions';

interface UserView {
  id:        string;
  userName:  string;
  email:     string;
  fullName:  string;
}

interface RoleView {
  name:        string;
  permissions: string[];
}

interface PermissionView      { name: string; }
interface RolePermissionView  { name: string; assigned: boolean; }
interface UserRoleView        { name: string; assigned: boolean; }
interface UserWithRolesView   { user: UserView; roles: UserRoleView[]; }

// Local list item — same as UserView, roles loaded separately on edit
type UserListItem = UserView;

@Component({
  selector:    'app-auth',
  standalone:  true,
  imports:     [FormsModule],
  templateUrl: './auth.component.html',
  styleUrl:    './auth.component.scss',
})
export class AuthComponent implements OnInit {

  activeTab = signal<AdminTab>('users');

  // ── Toast / flash ─────────────────────────────────────────
  toast     = signal('');
  toastType = signal<'ok' | 'err'>('ok');
  saveFlash = signal(0);
  private toastTimer: any;

  showToast(msg: string, type: 'ok' | 'err' = 'ok') {
    this.toast.set(msg);
    this.toastType.set(type);
    if (type === 'ok') this.saveFlash.update(n => n + 1);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3000);
  }

  // ── Users ─────────────────────────────────────────────────
  users    = signal<UserListItem[]>([]);
  userBusy = signal(false);

  newEmail    = signal('');
  newPassword = signal('');
  newFullName = signal('');

  editingUser     = signal<UserListItem | null>(null);
  editUserName    = signal('');
  editEmail       = signal('');
  editUserRoles   = signal<UserRoleView[]>([]);
  editRolesLoading = signal(false);

  loadUsers() {
    this.http.get<UserListItem[]>('/api/user/users')
      .pipe(catchError(() => of([])))
      .subscribe(r => this.users.set(Array.isArray(r) ? r : []));
  }

  createUser() {
    if (!this.newEmail() || !this.newPassword()) return;
    this.userBusy.set(true);
    this.http.post<UserView>('/api/user', {
      email: this.newEmail(), password: this.newPassword(), fullName: this.newFullName(),
    }).pipe(catchError(err => {
      this.showToast(err?.error?.message ?? err?.error ?? 'Create failed', 'err');
      this.userBusy.set(false);
      return of(null);
    })).subscribe(r => {
      this.userBusy.set(false);
      if (!r) return;
      // Append new user to list
      this.users.set([...this.users(), r]);
      this.newEmail.set(''); this.newPassword.set(''); this.newFullName.set('');
      this.showToast('User created');
    });
  }

  startEditUser(u: UserListItem) {
    if (this.editingUser()?.id === u.id) { this.cancelEditUser(); return; }
    this.editingUser.set(u);
    this.editUserName.set(u.userName);
    this.editEmail.set(u.email);
    this.editRolesLoading.set(true);
    this.editUserRoles.set([]);
    this.http.get<UserWithRolesView>(`/api/user/${u.id}/roles`)
      .pipe(catchError(() => of(null)))
      .subscribe(r => {
        this.editRolesLoading.set(false);
        if (r) this.editUserRoles.set(r.roles);
      });
  }

  cancelEditUser() { this.editingUser.set(null); this.editUserRoles.set([]); }

  saveEditUser() {
    const u = this.editingUser();
    if (!u) return;
    this.http.put<UserView>(`/api/user/${u.id}`, {
      userName: this.editUserName(), email: this.editEmail(),
    }).pipe(catchError(err => {
      this.showToast(err?.error?.message ?? err?.error ?? 'Update failed', 'err');
      return of(null);
    })).subscribe(r => {
      if (!r) return;
      this.users.set(this.users().map(x =>
        x.id === r.id ? { ...x, userName: r.userName, email: r.email, fullName: r.fullName } : x
      ));
      this.editingUser.set({ ...u, userName: r.userName, email: r.email, fullName: r.fullName });
      this.showToast('User updated');
    });
  }

  toggleEditUserRole(name: string) {
    this.editUserRoles.set(
      this.editUserRoles().map(r => r.name === name ? { ...r, assigned: !r.assigned } : r)
    );
  }

  saveUserRoles() {
    const u = this.editingUser();
    if (!u) return;
    const roleNames = this.editUserRoles().filter(r => r.assigned).map(r => r.name);
    this.http.post<UserWithRolesView>('/api/user/roles', { userId: u.id, roleNames })
      .pipe(catchError(err => {
        this.showToast(err?.error?.message ?? err?.error ?? 'Save failed', 'err');
        return of(null);
      })).subscribe(r => {
        if (!r) return;
        this.editUserRoles.set(r.roles);
        this.showToast('Roles saved');
      });
  }

  deleteUser(u: UserListItem) {
    if (!confirm(`Delete user "${u.userName}"?`)) return;
    this.http.delete(`/api/user/${u.id}`, { responseType: 'text' })
      .pipe(catchError(err => {
        this.showToast(err?.error ?? 'Delete failed', 'err');
        return of(null);
      })).subscribe(r => {
        if (r === null) return;
        this.users.set(this.users().filter(x => x.id !== u.id));
        if (this.editingUser()?.id === u.id) this.cancelEditUser();
        this.showToast('User deleted');
      });
  }

  // ── Roles ─────────────────────────────────────────────────
  roles       = signal<RoleView[]>([]);
  roleBusy    = signal(false);
  newRoleName = signal('');

  editPermRole    = signal('');
  editPermList    = signal<RolePermissionView[]>([]);
  editPermLoading = signal(false);

  loadRoles() {
    this.http.get<RoleView[]>('/api/role/roles')
      .pipe(catchError(() => of([])))
      .subscribe(r => this.roles.set(
        Array.isArray(r) ? r.map(role => ({ ...role, permissions: role.permissions ?? [] })) : []
      ));
  }

  createRole() {
    if (!this.newRoleName().trim()) return;
    this.roleBusy.set(true);
    this.http.post<RoleView>('/api/role', { name: this.newRoleName().trim() })
      .pipe(catchError(err => {
        this.showToast(err?.error?.message ?? err?.error ?? 'Create failed', 'err');
        this.roleBusy.set(false);
        return of(null);
      })).subscribe(r => {
        this.roleBusy.set(false);
        if (!r) return;
        this.roles.set([...this.roles(), { ...r, permissions: r.permissions ?? [] }]);
        this.newRoleName.set('');
        this.editPermRole.set('');
        this.showToast('Role created');
      });
  }

  deleteRole(name: string) {
    if (!confirm(`Delete role "${name}"?`)) return;
    this.http.delete(`/api/role/${encodeURIComponent(name)}`, { responseType: 'text' })
      .pipe(catchError(err => {
        this.showToast(err?.error ?? 'Delete failed', 'err');
        return of(null);
      })).subscribe(r => {
        if (r === null) return;
        this.roles.set(this.roles().filter(x => x.name !== name));
        if (this.editPermRole() === name) this.editPermRole.set('');
        this.showToast('Role deleted');
      });
  }

  selectRoleForPerms(roleName: string) {
    if (this.editPermRole() === roleName) { this.editPermRole.set(''); return; }
    this.editPermRole.set(roleName);
    this.editPermList.set([]);
    this.editPermLoading.set(true);
    this.http.get<RolePermissionView[]>(`/api/permission/permissions/${encodeURIComponent(roleName)}`)
      .pipe(catchError(() => of([])))
      .subscribe(list => { this.editPermLoading.set(false); this.editPermList.set(list); });
  }

  togglePermForRole(perm: string) {
    this.editPermList.set(
      this.editPermList().map(p => p.name === perm ? { ...p, assigned: !p.assigned } : p)
    );
  }

  saveRolePermissions() {
    const roleName        = this.editPermRole();
    const permissionNames = this.editPermList().filter(p => p.assigned).map(p => p.name);
    if (!roleName) return;
    this.http.post<RoleView>('/api/role/assign-permissions', { roleName, permissionNames })
      .pipe(catchError(err => {
        this.showToast(err?.error?.message ?? err?.error ?? 'Save failed', 'err');
        return of(null);
      })).subscribe(r => {
        if (!r) return;
        this.roles.set(this.roles().map(x =>
          x.name === roleName ? { ...x, permissions: r.permissions ?? [] } : x
        ));
        this.editPermRole.set('');
        this.showToast('Permissions saved');
      });
  }

  // ── Permissions ───────────────────────────────────────────
  permissions    = signal<string[]>([]);
  newPermName    = signal('');
  permBusy       = signal(false);
  permFilterRole = signal('');

  allPermissions = computed(() => {
    const set = new Set<string>();
    this.roles().forEach(r => r.permissions.forEach(p => set.add(p)));
    this.permissions().forEach(p => set.add(p));
    return Array.from(set).sort();
  });

  filteredPerms = computed(() => {
    const role = this.permFilterRole();
    if (!role) return this.allPermissions();
    return this.roles().find(r => r.name === role)?.permissions.slice().sort() ?? [];
  });

  loadPermissions() {
    this.http.get<PermissionView[]>('/api/permission/permissions')
      .pipe(catchError(() => of([])))
      .subscribe(r => this.permissions.set(Array.isArray(r) ? r.map(p => p.name) : []));
  }

  createPermission() {
    const name = this.newPermName().trim();
    if (!name) return;
    this.permBusy.set(true);
    this.http.post<PermissionView>('/api/permission', { name })
      .pipe(catchError(err => {
        this.showToast(err?.error?.message ?? err?.error ?? 'Create failed', 'err');
        this.permBusy.set(false);
        return of(null);
      })).subscribe(r => {
        this.permBusy.set(false);
        if (!r) return;
        // Add to list in-place — no reload needed
        this.permissions.set([...this.permissions(), r.name].sort());
        this.newPermName.set('');
        this.showToast('Permission created');
      });
  }

  loadAll() { this.loadUsers(); this.loadRoles(); this.loadPermissions(); }

  constructor(private http: HttpClient, readonly authSvc: AuthService) {}

  ngOnInit() { this.loadAll(); }
}