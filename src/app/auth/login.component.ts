import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from './auth.service';

@Component({
  selector:    'app-login',
  standalone:  true,
  imports:     [FormsModule],
  templateUrl: './login.component.html',
  styleUrl:    './login.component.scss',
})
export class LoginComponent {
  email    = signal('');
  password = signal('');
  showPwd  = signal(false);

  constructor(readonly auth: AuthService) {}

  login() {
    if (!this.email() || !this.password()) return;
    this.auth.login(this.email(), this.password()).subscribe(r => {
      if (r) this.auth.setSession(r);
    });
  }
}
